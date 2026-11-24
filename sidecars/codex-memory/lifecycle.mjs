// Reuse the upstream FSRS calculations. SQLite keeps reviews consistent across MCP processes.
import {
  retrievability, initialStability, initialDifficulty, ltmUnitMeta,
  nextStability, nextDifficulty,
} from '../../src/memory-decay.js';

const categories = { preference: 'trait', user_statement: 'fact', shared_event: 'event',
  prediction: 'note', hypothesis: 'note', decision: 'fact', open_question: 'pending', self_observation: 'note' };

export class NoteLifecycle {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS memory_note_lifecycle (
      note_id TEXT PRIMARY KEY REFERENCES memory_notes(id), stability REAL NOT NULL,
      difficulty REAL NOT NULL, last_review_ms REAL NOT NULL, reps INTEGER NOT NULL DEFAULT 0,
      hard INTEGER NOT NULL DEFAULT 0, core INTEGER NOT NULL DEFAULT 0
    )`);
  }

  state(note) {
    const record = this.db.prepare('SELECT * FROM memory_note_lifecycle WHERE note_id=?').get(note.id);
    const meta = ltmUnitMeta({ at: note.created_at, cat: categories[note.kind] ?? 'note',
      core: Boolean(record?.core), status: note.status === 'active' ? 'open' : 'done' });
    const S = record?.stability ?? initialStability(meta);
    const D = record?.difficulty ?? initialDifficulty(meta);
    const last = record?.last_review_ms ?? meta.createdAt;
    const R = retrievability(Math.max(0, (this.now() - last) / 86400000), S);
    return { S, D, R, last, reps: record?.reps ?? 0, hard: record?.hard ?? 0,
      core: Boolean(record?.core), exempt: meta.exempt, frozen: !meta.exempt && R < 0.5 };
  }

  initialize(note, core = false) {
    const current = this.state(note);
    this.db.prepare(`INSERT OR IGNORE INTO memory_note_lifecycle VALUES (?,?,?,?,?,?,?)`)
      .run(note.id, current.S, current.D, current.last, current.reps, current.hard, Number(core));
  }

  setCore(note, core) {
    this.initialize(note);
    this.db.prepare('UPDATE memory_note_lifecycle SET core=? WHERE note_id=?').run(Number(core), note.id);
    return this.state(note);
  }

  review(note, rating) {
    if (!['good', 'hard'].includes(rating)) throw new Error('复习评分应为 good 或 hard');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.state(note);
      const now = this.now();
      if (current.reps && now - current.last < 3600000) {
        this.db.exec('COMMIT');
        return { applied: false, reason: 'cooldown', state: current };
      }
      this.initialize(note, current.core);
      this.db.prepare(`UPDATE memory_note_lifecycle SET stability=?,difficulty=?,last_review_ms=?,reps=reps+1,hard=hard+? WHERE note_id=?`)
        .run(nextStability(current.S, current.D, current.R, rating), nextDifficulty(current.D, rating), now, Number(rating === 'hard'), note.id);
      const state = this.state(note);
      this.db.exec('COMMIT');
      return { applied: true, state };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
