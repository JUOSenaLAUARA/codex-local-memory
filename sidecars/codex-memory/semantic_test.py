import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import numpy as np

from semantic import DIM, index_batch, nearest, schema


class Encoder:
    def embed_docs(self, texts):
        vectors = np.zeros((len(texts), DIM), dtype=np.float32)
        for i, text in enumerate(texts):
            vectors[i, int("tail" not in text)] = 1
        return vectors


class IndexTest(unittest.TestCase):
    def test_incremental_chunks_scope_and_stale_vector(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            raw_file = data / "conversations.sqlite3"
            with closing(sqlite3.connect(raw_file)) as raw:
                raw.executescript("""
                    CREATE TABLE messages(id TEXT,thread_id TEXT,content_hash TEXT,text TEXT,role TEXT,timestamp TEXT);
                    INSERT INTO messages VALUES ('in','visible','h1','head','user','2026-11-24T00:00:00Z'),
                                                ('out','private','h2','tail','user','2026-11-24T00:00:00Z'),
                                                ('other','visible','h3','tail','assistant','2026-11-24T00:00:00Z');
                """)
                raw.execute("UPDATE messages SET text=? WHERE id='in'", ("x" * 1140 + " tail",))
                raw.commit()
                with closing(sqlite3.connect(data / "semantic.sqlite3", uri=True)) as index:
                    schema(index)
                    index.execute("ATTACH DATABASE ? AS archive", (raw_file.as_uri() + "?mode=ro",))
                    self.assertTrue(index_batch(index, Encoder(), "sample"))
                    self.assertFalse(index_batch(index, Encoder(), "sample"))
                    query = np.eye(1, DIM, dtype=np.float32)[0]
                    filters = {"threads": ["visible"], "speaker": "user", "from": "2026-11-24"}
                    self.assertEqual(nearest(root, "sample", query, filters),
                                     [{"id": "in", "cosine": 1, "start": 880}])
                    self.assertEqual(nearest(root, "sample", query, {**filters, "to": "2026-11-23"}), [])
                    raw.execute("UPDATE messages SET content_hash='changed',text='changed' WHERE id='in'")
                    raw.commit()
                    self.assertEqual(nearest(root, "sample", query, filters), [])
                    self.assertTrue(index_batch(index, Encoder(), "sample"))
                    self.assertFalse(index_batch(index, Encoder(), "sample"))


if __name__ == "__main__":
    unittest.main()
