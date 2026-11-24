"""Adapt a scoped Codex note snapshot to the upstream associate() interface."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'memory-rag'))
from memory_rag.recall import associate
from memory_rag.l2 import normalize_name


class ScopedNotes:
    def __init__(self, notes):
        self.rows = {}
        self.entities = {}
        self.names = {}
        for note in notes:
            sid = note['id']
            self.rows[sid] = {
                'summary_id': sid, 'title': note['kind'], 'summary': note['text'],
                'day': note['created_at'][:10], 't_end': note['created_ms'],
            }
            self.entities[sid] = []
            for name in note['entities']:
                normalized = normalize_name(name)
                if normalized:
                    entity = 'topic:' + normalized
                    self.entities[sid].append(entity)
                    self.names[entity] = name

    def count_summaries(self, key):
        return len(self.rows)

    def entity_df(self, key, entities):
        return {entity: sum(entity in values for values in self.entities.values()) for entity in entities}

    def entities_in_text(self, key, text, min_len=2):
        text = normalize_name(text)
        return [entity for entity, name in self.names.items() if len(normalize_name(name)) >= min_len and normalize_name(name) in text]

    def linked_summaries(self, key, seeds, t_end_lte=None, exclude_ids=()):
        seeds = set(seeds)
        return {sid: sorted(seeds.intersection(values)) for sid, values in self.entities.items()
                if sid not in exclude_ids and seeds.intersection(values)
                and (t_end_lte is None or self.rows[sid]['t_end'] <= t_end_lte)}

    def get_summaries(self, key, ids):
        return {sid: self.rows[sid] for sid in ids if sid in self.rows}

    def entities_of(self, key, ids):
        return {sid: self.entities[sid] for sid in ids if sid in self.entities}

    def entity_names(self, ids):
        return {entity: self.names[entity] for entity in ids if entity in self.names}

    def summary_covering(self, key, timestamp):
        return next((row for row in self.rows.values() if row['t_end'] == timestamp), None)


def main():
    request = json.load(sys.stdin)
    # Node has already applied project visibility. One snapshot is one graph scope.
    notes = ScopedNotes(request['notes'])
    service = SimpleNamespace(l2=notes, cfg={'associate': {'min_age_days': 0}})
    result = associate(service, 'codex-snapshot', text=request['text'],
                       exclude=request.get('exclude', []), min_age_days=request.get('min_age_days', 0),
                       k=request.get('limit', 3), now_ms=request['now'])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
