"""Rebuildable, local conversation excerpts and their concept graph."""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import threading
from collections import Counter
from contextlib import closing
from datetime import datetime
from itertools import combinations
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "memory-rag"))
from memory_rag.fts import query_tokens, tokenize
from memory_rag.l2 import L2, clear_rows, ensure_schema, normalize_name, summary_id_for, text_hash
from memory_rag.recall import _rrf, score_linked


METHOD = "local-extractive-v1"
STOP = set("问题 继续 好的 这个 可以 已经 时候 需要 现在 刚才 可能 事情 一点 觉得 应该 如果 用来 一次 以后 目前 之前 之后 内容 实现 怎么 相关 结果 不是 一个 没有 什么 这样 所以".split())
SENTENCE = re.compile(r"[^\n。！？!?；]+[。！？!?；]*")
QUOTED = re.compile(r"[「『“《`][^\n「『“《`」』”》]{2,28}[」』”》`]")
TOPIC_SCHEMA = """
CREATE TABLE IF NOT EXISTS topic_details (
    summary_id TEXT PRIMARY KEY, sources TEXT NOT NULL, excerpts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_progress (
    key TEXT PRIMARY KEY, count INTEGER NOT NULL, latest INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_edge_sources (
    summary_id TEXT NOT NULL, src_id TEXT NOT NULL, dst_id TEXT NOT NULL, message_id TEXT NOT NULL,
    PRIMARY KEY(summary_id, src_id, dst_id)
);
CREATE INDEX IF NOT EXISTS topic_relations_summary ON relations(summary_id);
"""


def open_database(file, read_only=False):
    uri = file.resolve().as_uri() + ("?mode=ro" if read_only else "?mode=rwc")
    connection = sqlite3.connect(uri, uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def topic_path(root):
    return root / "data" / "topics.sqlite3"


def terms(text):
    words = tokenize(text)
    quoted = (normalize_name(match.group()[1:-1]) for match in QUOTED.finditer(text))
    return {word for word in [*words, *quoted]
            if 2 <= len(word) <= 24 and word not in STOP and not word.isdecimal()}


def candidates(messages):
    for message in messages:
        text = message["text"]
        spans = list(SENTENCE.finditer(text))
        for span in spans[:24] + spans[max(24, len(spans) - 8):]:
            raw = span.group()
            stripped = raw.lstrip()
            if not stripped or stripped.startswith(("http://", "https://", "```", "|")):
                continue
            start = span.start() + len(raw) - len(stripped)
            snippet = stripped[:240].rstrip()
            words = terms(snippet)
            if not words:
                continue
            yield {
                "message_id": message["id"], "role": message["role"], "timestamp": message["timestamp"],
                "start": start, "text": snippet, "truncated": start > 0 or start + len(snippet) < len(text),
            }, words


def summarize(messages):
    options = list(candidates(messages))
    if not options:
        return None
    focus = set().union(*(words for excerpt, words in options if excerpt["role"] == "user"))
    counts = Counter(word for _, words in options for word in words)

    def relevance(index):
        excerpt, words = options[index]
        return (2 * len(words & focus) + sum(min(counts[word], 3) for word in words)
                + min(len(excerpt["text"]), 75) / 25) / max(1, len(words)) ** 0.5

    chosen = []
    for role, limit in (("user", 1), ("assistant", 2)):
        indexes = [index for index, (excerpt, _) in enumerate(options) if excerpt["role"] == role]
        chosen.extend(sorted(indexes, key=relevance, reverse=True)[:limit])
    selected = [options[index] for index in sorted(chosen)]
    excerpts = [excerpt for excerpt, _ in selected]
    previews = {"user": "用户", "assistant": "Codex"}
    summary = "\n".join(f"{previews[excerpt['role']]}：{excerpt['text']}" for excerpt in excerpts)
    occurrence = Counter()
    for excerpt, words in selected:
        weight = 2 if excerpt["role"] == "user" else 1
        occurrence.update({word: weight for word in words})
    concepts = sorted(occurrence, key=lambda word: (-occurrence[word], -min(counts[word], 3), word))[:8]
    relationships = {}
    for excerpt, words in selected:
        for pair in combinations(sorted(set(concepts) & words), 2):
            relationships.setdefault(pair, excerpt["message_id"])
    title = re.sub(r"^[#*\s]+", "", excerpts[0]["text"])[:70].rstrip()
    return title, summary, excerpts, concepts, relationships


def turns(messages):
    turn = []
    for message in messages:
        if turn and message["role"] == "user":
            yield turn
            turn = []
        turn.append(message)
    if turn:
        yield turn


def write_topic(db, key, messages):
    result = summarize(messages)
    if not result:
        return
    title, summary, excerpts, concepts, relationships = result
    ids = [message["id"] for message in messages]
    signature = text_hash(json.dumps([
        METHOD, [(message["id"], message["content_hash"], message["timestamp"]) for message in messages],
    ]))
    chunk_id = text_hash(f"{key}|{ids[0]}")
    sid = summary_id_for(chunk_id, signature)
    begin = datetime.fromisoformat(messages[0]["timestamp"])
    end = datetime.fromisoformat(messages[-1]["timestamp"])
    start_ms, end_ms = int(begin.timestamp() * 1000), int(end.timestamp() * 1000)
    db.execute(
        """INSERT INTO summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'disabled')""",
        (sid, chunk_id, key, signature, start_ms, end_ms, begin.date().isoformat(), title, summary, METHOD, end_ms),
    )
    db.execute("INSERT INTO summaries_fts(tokens, summary_id) VALUES (?, ?)",
               (" ".join([*tokenize(summary), *concepts]), sid))
    db.execute("INSERT INTO topic_details VALUES (?, ?, ?)",
               (sid, json.dumps(ids), json.dumps(excerpts, ensure_ascii=False)))
    entity_ids = {term: f"{key}:{term}" for term in concepts}
    db.executemany("INSERT OR IGNORE INTO entities VALUES (?, 'topic', ?, ?, NULL, ?)",
                   [(entity, term, term, end_ms) for term, entity in entity_ids.items()])
    db.executemany("INSERT INTO summary_entities VALUES (?, ?, ?)",
                   [(sid, entity, key) for entity in entity_ids.values()])
    edges = [(entity_ids[first], entity_ids[second], source) for (first, second), source in relationships.items()]
    db.executemany("INSERT INTO relations VALUES (?, ?, ?, ?, 'co_occurrence')",
                   [(sid, key, first, second) for first, second, _ in edges])
    db.executemany("INSERT INTO topic_edge_sources VALUES (?, ?, ?, ?)",
                   [(sid, *edge) for edge in edges])


def clear_thread(db, key):
    for table in ("topic_details", "topic_edge_sources", "summaries_fts"):
        db.execute(f"DELETE FROM {table} WHERE summary_id IN (SELECT summary_id FROM summaries WHERE key=?)",
                   (key,))
    for table in ("relations", "summary_entities", "summaries", "topic_progress"):
        db.execute(f"DELETE FROM {table} WHERE key=?", (key,))


def refresh(root, force=False):
    with (closing(open_database(topic_path(root))) as db,
          closing(open_database(root / "data" / "conversations.sqlite3", True)) as archive):
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA secure_delete=ON")
        ensure_schema(db)
        db.executescript(TOPIC_SCHEMA)
        with db:
            db.execute("BEGIN IMMEDIATE")
            archive.execute("BEGIN")
            if force:
                clear_rows(db.cursor())
                db.execute("DELETE FROM topic_details")
                db.execute("DELETE FROM topic_edge_sources")
                db.execute("DELETE FROM topic_progress")
            source = {row["thread_id"]: (row["n"], row["latest"]) for row in archive.execute(
                "SELECT thread_id, COUNT(*) AS n, MAX(rowid) AS latest FROM messages GROUP BY thread_id"
            )}
            current = {row["key"]: (row["count"], row["latest"]) for row in db.execute(
                "SELECT key, count, latest FROM topic_progress"
            )}
            changed = sorted(key for key in source.keys() | current.keys() if source.get(key) != current.get(key))
            for key in changed:
                clear_thread(db, key)
                if key in source:
                    messages = archive.execute(
                        """SELECT id, role, timestamp, text, content_hash FROM messages
                           WHERE thread_id=? ORDER BY timestamp, source_offset, id""", (key,),
                    )
                    for turn in turns(messages):
                        write_topic(db, key, turn)
                    db.execute("INSERT INTO topic_progress VALUES (?, ?, ?)", (key, *source[key]))
            if changed:
                db.execute("DELETE FROM entities WHERE NOT EXISTS "
                           "(SELECT 1 FROM summary_entities se WHERE se.entity_id=entities.entity_id)")
        return {"changed_threads": len(changed)}


def topics_for_query(db, threads, query, keywords, limit):
    l2 = L2(SimpleNamespace(conn=db, lock=threading.RLock()))
    words = [word for word in query_tokens(query, keywords) if len(word) >= 2 and word not in STOP]
    lexical, graph, via = [], [], {}
    scope = json.dumps(threads)
    graph_keys = [row["key"] for row in db.execute(
        "SELECT key FROM topic_progress WHERE key IN (SELECT value FROM json_each(?))", (scope,),
    )]
    if words:
        match = " OR ".join('"' + word.replace('"', '""') + '"' for word in words[:30])
        lexical = [row["summary_id"] for row in db.execute(
            """SELECT s.summary_id FROM summaries_fts JOIN summaries s USING(summary_id)
               WHERE summaries_fts MATCH ? AND s.key IN (SELECT value FROM json_each(?))
               ORDER BY instr(lower(s.summary), ?)=0, bm25(summaries_fts), s.t_end DESC, s.summary_id
               LIMIT 30""", (match, scope, query.strip().lower()),
        )]
    for key in graph_keys:
        seeds = l2.entities_in_text(key, " ".join([query, *keywords]))
        linked = l2.linked_summaries(key, seeds)
        graph.extend(score_linked(l2, key, linked).items())
        names = l2.entity_names(seeds)
        via.update({sid: sorted(names[entity] for entity in entities)[:5] for sid, entities in linked.items()})
    graph.sort(key=lambda item: (-item[1], item[0]))
    return [(sid, routes, via.get(sid, [])) for sid, _, routes in
            _rrf({"summary": lexical, "graph": [sid for sid, _ in graph[:30]]})[:limit]]


def query_index(root, request):
    threads, limit = request["threads"], request["limit"]
    file = topic_path(root)
    if not threads or not file.is_file():
        return {"items": []}
    with closing(open_database(file, True)) as db:
        db.execute("BEGIN")
        query = request.get("query", "")
        keywords = request.get("keywords", [])
        if query or keywords:
            rows = topics_for_query(db, threads, query, keywords, limit)
        else:
            rows = [(row["summary_id"], [], []) for row in db.execute(
                """SELECT summary_id FROM summaries WHERE key IN (SELECT value FROM json_each(?))
                   ORDER BY t_end DESC, summary_id LIMIT ?""", (json.dumps(threads), limit),
            )]
        items = []
        for sid, routes, via in rows:
            row = db.execute(
                """SELECT s.key, s.title, s.day, s.summary, s.model, d.sources, d.excerpts
                   FROM summaries s JOIN topic_details d USING(summary_id) WHERE s.summary_id=?""", (sid,),
            ).fetchone()
            if not row or row["key"] not in threads:
                continue
            concept_rows = db.execute(
                """SELECT e.name FROM summary_entities se JOIN entities e USING(entity_id)
                   WHERE se.summary_id=? AND se.key=? ORDER BY e.name""", (sid, row["key"]),
            )
            relationships = db.execute(
                """SELECT a.name AS source, b.name AS target, r.relation AS kind, ev.message_id
                   FROM relations r
                   JOIN entities a ON a.entity_id=r.src_id JOIN entities b ON b.entity_id=r.dst_id
                   JOIN topic_edge_sources ev ON ev.summary_id=r.summary_id AND ev.src_id=r.src_id
                     AND ev.dst_id=r.dst_id
                   WHERE r.summary_id=? AND r.key=? ORDER BY a.name, b.name LIMIT 12""", (sid, row["key"]),
            )
            items.append({"id": sid, "thread_id": row["key"], "title": row["title"], "day": row["day"],
                          "summary": row["summary"], "method": row["model"], "routes": routes, "via": via,
                          "source_message_ids": json.loads(row["sources"]), "excerpts": json.loads(row["excerpts"]),
                          "concepts": [concept["name"] for concept in concept_rows],
                          "relationships": [dict(edge) for edge in relationships]})
    return {"items": items}


if __name__ == "__main__":
    action, base = sys.argv[1:]
    root = Path(base)
    if action in {"refresh", "rebuild"}:
        result = refresh(root, force=action == "rebuild")
    elif action == "query":
        result = query_index(root, json.load(sys.stdin))
    else:
        raise ValueError(f"Unknown topic index action: {action}")
    print(json.dumps(result, ensure_ascii=False))
