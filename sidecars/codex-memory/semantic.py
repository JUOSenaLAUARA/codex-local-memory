"""Local embedding index for Codex message IDs. Raw messages stay in the collector database."""
from __future__ import annotations

import heapq
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "memory-rag"))
from memory_rag.embeddings import LlamaCppEmbedder
from memory_rag.recall import _rrf
import numpy as np


MODEL = "Qwen3-Embedding-0.6B-Q8_0"
DIM = 512
CHUNK = 1000
STEP = 880
LAYOUT = f"message-v1:{CHUNK}:{STEP}"
INSTRUCTION = "Given a question about past conversations, retrieve passages that contain the answer."


def embedder(port):
    return LlamaCppEmbedder({"base_url": f"http://127.0.0.1:{port}", "model": MODEL,
                            "dim": DIM, "instruct": INSTRUCTION, "batch": 2, "timeout_s": 12})


def schema(db):
    db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS indexed (
            model TEXT NOT NULL, message_id TEXT NOT NULL, content_hash TEXT NOT NULL,
            PRIMARY KEY(model, message_id)
        );
        CREATE TABLE IF NOT EXISTS vectors (
            model TEXT NOT NULL, message_id TEXT NOT NULL, start INTEGER NOT NULL,
            vector BLOB NOT NULL, PRIMARY KEY(model, message_id, start)
        );
    """)


def index_batch(db, encoder, model):
    rows = db.execute("""
        SELECT m.id, m.content_hash, m.text
        FROM archive.messages m LEFT JOIN indexed i
            ON i.model=? AND i.message_id=m.id AND i.content_hash=m.content_hash
        WHERE i.message_id IS NULL ORDER BY m.rowid LIMIT 8
    """, (model,)).fetchall()
    if not rows:
        return False
    locations = []
    texts = []
    for message_id, _, text in rows:
        for start in range(0, len(text), STEP):
            chunk = text[start:start + CHUNK]
            if chunk.strip():
                locations.append((message_id, start))
                texts.append(chunk)
            if start + CHUNK >= len(text):
                break
    vectors = encoder.embed_docs(texts)
    if vectors.shape != (len(texts), DIM) or not np.isfinite(vectors).all():
        raise ValueError("Embedding output has invalid shape or values")
    with db:
        db.executemany("DELETE FROM vectors WHERE model=? AND message_id=?",
                       [(model, row[0]) for row in rows])
        db.executemany("INSERT INTO vectors VALUES (?,?,?,?)",
                       [(model, *loc, vec.astype("<f4", copy=False).tobytes())
                        for loc, vec in zip(locations, vectors)])
        db.executemany("INSERT OR REPLACE INTO indexed VALUES (?,?,?)",
                       [(model, row[0], row[1]) for row in rows])
    return True


def publish(root, **status):
    target = root / "semantic-status.json"
    tmp = root / f"semantic-status-{os.getpid()}.tmp"
    try:
        tmp.write_text(json.dumps({**status, "at_ms": int(time.time() * 1000)}), encoding="utf-8")
        for attempt in range(12):
            try:
                os.replace(tmp, target)
                return
            except PermissionError:
                if os.name != "nt" or attempt == 11:
                    raise
                # Windows briefly denies replacement while another reader has the status file open.
                time.sleep(0.05)
    finally:
        tmp.unlink(missing_ok=True)


def windows_job(process):
    """Bind the model process to the worker lifetime, including forced Windows termination."""
    if os.name != "nt":
        return None
    import ctypes as c
    from ctypes import wintypes as w

    class BasicLimits(c.Structure):
        _fields_ = [("process_time", c.c_int64), ("job_time", c.c_int64),
                    ("flags", w.DWORD), ("min_ws", c.c_size_t), ("max_ws", c.c_size_t),
                    ("active_process_limit", w.DWORD), ("affinity", c.c_size_t),
                    ("priority", w.DWORD), ("scheduling", w.DWORD)]

    class Limits(c.Structure):
        _fields_ = [("basic", BasicLimits), ("io", c.c_uint64 * 6),
                    ("memory", c.c_size_t * 4)]

    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise c.WinError(c.get_last_error())
    limits = Limits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    # 9 = JobObjectExtendedLimitInformation.
    if not (kernel.SetInformationJobObject(handle, 9, c.byref(limits), c.sizeof(limits))
            and kernel.AssignProcessToJobObject(handle, int(process._handle))):
        error = c.WinError(c.get_last_error())
        kernel.CloseHandle(handle)
        raise error
    return lambda: kernel.CloseHandle(handle)


def monitor(root, executable, weights):
    stopped = threading.Event()

    def watch_parent():
        os.read(sys.stdin.fileno(), 1)
        stopped.set()

    threading.Thread(target=watch_parent, daemon=True).start()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    encoder = embedder(port)
    model = f"{encoder.model_id}|{LAYOUT}"
    publish(root, state="starting", model=MODEL)
    process = subprocess.Popen([executable, "-m", weights, "--embedding", "--pooling", "last",
                                "--host", "127.0.0.1", "--port", str(port), "-ngl", "0",
                                "-t", "4", "-c", "4096", "-b", "4096", "-ub", "4096",
                                "--parallel", "1"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    close_job = None
    try:
        close_job = windows_job(process)
        deadline = time.monotonic() + 90
        while not stopped.is_set() and not encoder.healthy():
            if process.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("Local llama-server did not start")
            stopped.wait(1)
        with closing(sqlite3.connect(root / "data" / "semantic.sqlite3", timeout=5, uri=True)) as db:
            schema(db)
            db.execute("ATTACH DATABASE ? AS archive", ((root / "data" / "conversations.sqlite3").as_uri() + "?mode=ro",))
            while not stopped.is_set():
                if process.poll() is not None:
                    raise RuntimeError("Local llama-server stopped")
                try:
                    count = db.execute("SELECT count(*) FROM indexed WHERE model=?", (model,)).fetchone()[0]
                    total = db.execute("SELECT count(*) FROM archive.messages").fetchone()[0]
                    publish(root, state="ready" if count >= total else "indexing", model=MODEL,
                            port=port, indexed=count, total=total)
                    stopped.wait(0.2 if index_batch(db, encoder, model) else 5)
                except (RuntimeError, ValueError, sqlite3.Error) as error:
                    publish(root, state="degraded", model=MODEL, error=type(error).__name__)
                    stopped.wait(5)
    except Exception as error:
        publish(root, state="unavailable", model=MODEL, error=str(error))
        raise
    finally:
        encoder.client.close()
        if close_job:
            close_job()
        elif process.poll() is None:
            process.terminate()
        process.wait(timeout=5)


def nearest(root, model, query, request):
    if query.shape != (DIM,) or not np.isfinite(query).all():
        raise ValueError("Invalid query embedding")
    with closing(sqlite3.connect((root / "data" / "semantic.sqlite3").as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("ATTACH DATABASE ? AS archive", ((root / "data" / "conversations.sqlite3").as_uri() + "?mode=ro",))
        filters = ["v.model=?", "m.thread_id IN (SELECT value FROM json_each(?))"]
        params = [model, json.dumps(request["threads"])]
        for key, clause in (("speaker", "m.role=?"), ("from", "julianday(m.timestamp)>=julianday(?)"),
                            ("to", "julianday(m.timestamp)<=julianday(?)")):
            if request.get(key):
                filters.append(clause)
                params.append(request[key])
        cursor = db.execute("""
            SELECT v.message_id,v.start,v.vector FROM vectors v
            JOIN archive.messages m ON m.id=v.message_id
            JOIN indexed i ON i.model=v.model AND i.message_id=m.id AND i.content_hash=m.content_hash
            WHERE """ + " AND ".join(filters), params)
        best = {}
        while rows := cursor.fetchmany(256):
            matrix = np.frombuffer(b"".join(row[2] for row in rows), dtype="<f4").reshape(-1, DIM)
            for (message_id, start, _), score in zip(rows, matrix @ query):
                entry = (float(score), start)
                if score >= 0.28 and entry > best.get(message_id, (-1, 0)):
                    best[message_id] = entry
    top = heapq.nlargest(24, best, key=best.get)
    return [{"id": mid, "cosine": round(best[mid][0], 4), "start": best[mid][1]} for mid in top]


def search(root, request):
    status = json.loads((root / "semantic-status.json").read_text(encoding="utf-8"))
    if status["state"] not in {"ready", "indexing"} or time.time() * 1000 - status["at_ms"] > 120000:
        raise RuntimeError("Local semantic index is offline or starting")
    encoder = embedder(status["port"])
    try:
        query = encoder.embed_query(request["query"])
        return nearest(root, f"{encoder.model_id}|{LAYOUT}", query, request)
    finally:
        encoder.client.close()


if __name__ == "__main__":
    mode, base, *args = sys.argv[1:]
    root = Path(base)
    if mode == "watch":
        monitor(root, *args)
    else:
        request = json.load(sys.stdin)
        hits = search(root, request)
        ranking = _rrf({"keyword": request["lexical"], "semantic": [hit["id"] for hit in hits]})
        print(json.dumps({"vectors": hits, "ranking": ranking}))
