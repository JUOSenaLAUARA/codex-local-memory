import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, projectKey } from './store.mjs';
import { NoteLifecycle } from './lifecycle.mjs';
import { associateUpstream, runPython } from './upstream-association.mjs';
import { ArtifactStore } from './artifacts.mjs';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stopwords = new Set(['我们', '你们', '这个', '那个', '为什么', '什么', '怎样', '怎么', '可以', '现在', '以前', '曾经', '记得', '之前', '一下', '关于', '时候', '了吗', '进行', '改成']);
export { projectKey };

function searchTerms(query, keywords = []) {
  const words = [...segmenter.segment(query)].filter((word) => word.isWordLike).map((word) => word.segment);
  return [...new Set([query.trim(), ...keywords, ...words].map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2 && !stopwords.has(s)))].slice(0, 20);
}

function excerpt(text, terms) {
  const lower = text.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((p) => p >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100);
  return { text: text.slice(start, start + 600), truncated: start > 0 || text.length > start + 600 };
}

export class ConversationMemory extends MemoryStore {
  constructor(root, config, { now = () => Date.now() } = {}) {
    super(root);
    this.config = config;
    this.shared = config.sharedThreadIds ?? [];
    this.now = now;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const indexed = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").get();
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid,text) VALUES(new.rowid,new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.rowid,old.text);
        END;
        CREATE TABLE IF NOT EXISTS memory_notes (
          id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
          scope TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','superseded','archived')),
          supersedes TEXT REFERENCES memory_notes(id), created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_note_sources (
          note_id TEXT NOT NULL REFERENCES memory_notes(id), message_id TEXT NOT NULL REFERENCES messages(id),
          PRIMARY KEY(note_id,message_id)
        );
      `);
      if (!indexed) this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.lifecycle = new NoteLifecycle(this.db, now);
    this.artifacts = new ArtifactStore(this.db, now);
  }

  canRead(threadId, projectPath) {
    if (this.shared.includes(threadId)) return true;
    if (!projectPath) return false;
    const thread = this.db.prepare('SELECT cwd FROM threads WHERE id=?').get(threadId);
    return Boolean(thread?.cwd) && projectKey(thread.cwd) === projectKey(projectPath);
  }

  visibleThreads(projectPath, threadId) {
    const project = projectPath ? projectKey(projectPath) : null;
    return this.db.prepare('SELECT id,cwd FROM threads').all().filter((row) =>
      (!threadId || row.id === threadId) && (this.shared.includes(row.id) ||
        (project && row.cwd && projectKey(row.cwd) === project))).map((row) => row.id);
  }

  async topics({ query = '', keywords = [], project_path, thread_id, limit = 4 }) {
    const threads = this.visibleThreads(project_path, thread_id);
    if (!threads.length || !fs.existsSync(path.join(this.root, 'data', 'topics.sqlite3'))) return { items: [] };
    return runPython('topics.py', ['query', this.root], { threads, query, keywords, limit }, 7000);
  }

  resume({ project_path, thread_id, limit = 2 }) {
    const threads = this.visibleThreads(project_path, thread_id);
    if (!threads.length) return { items: [] };
    const checkpoints = this.db.prepare(`
      WITH candidates AS (
        SELECT *,row_number() OVER (PARTITION BY thread_id ORDER BY anchor_at DESC, saved_at DESC, trigger DESC) AS priority
        FROM conversation_checkpoints WHERE thread_id IN (SELECT value FROM json_each(?))
      )
      SELECT thread_id,trigger,message_ids,anchor_at,saved_at FROM candidates WHERE priority=1
      ORDER BY anchor_at DESC,saved_at DESC,thread_id LIMIT ?`).all(JSON.stringify(threads), limit);
    const relevant = this.noteRows(project_path).filter((note) => ['decision', 'open_question'].includes(note.kind));
    const source = this.db.prepare('SELECT thread_id FROM messages WHERE id=?');
    const lines = this.db.prepare(`
      SELECT m.id AS message_id,m.timestamp,m.role AS speaker,substr(m.text,1,480) AS excerpt,
        length(m.text)>480 AS truncated FROM json_each(?) j JOIN messages m ON m.id=j.value
        WHERE m.thread_id=? ORDER BY CAST(j.key AS INTEGER)`);
    return { items: checkpoints.map(({ message_ids, ...checkpoint }) => {
      const notes = relevant.filter((note) =>
        note.source_message_ids.some((id) => source.get(id)?.thread_id === checkpoint.thread_id));
      return { ...checkpoint, recent_messages: lines.all(message_ids, checkpoint.thread_id),
        decisions: notes.filter((note) => note.kind === 'decision').slice(0, 4),
        open_questions: notes.filter((note) => note.kind === 'open_question').slice(0, 4) };
    }) };
  }

  search({ query, keywords = [], project_path, thread_id, speaker, limit = 6, from, to }) {
    if (!query?.trim()) throw new Error('查询不能为空');
    const terms = searchTerms(query, keywords);
    if (!terms.length) return { results: [], explanation: '请提供至少两个字的主题或关键词' };
    const rows = new Map();
    const filters = [];
    const parameters = [];
    const ids = this.visibleThreads(project_path, thread_id);
    if (!ids.length) return { results: [], explanation: '当前范围没有可检索的聊天' };
    filters.push('m.thread_id IN (SELECT value FROM json_each(?))');
    parameters.push(JSON.stringify(ids));
    if (speaker) { filters.push('m.role=?'); parameters.push(speaker); }
    if (from) { filters.push('julianday(m.timestamp)>=julianday(?)'); parameters.push(from); }
    if (to) { filters.push('julianday(m.timestamp)<=julianday(?)'); parameters.push(to); }
    const where = filters.join(' AND ');
    const phrases = terms.filter((term) => [...term].length >= 3).map((term) => `"${term.replaceAll('"', '""')}"`);
    if (phrases.length) {
      for (const row of this.db.prepare(`SELECT m.*,bm25(messages_fts) rank FROM messages_fts
          JOIN messages m ON m.rowid=messages_fts.rowid WHERE messages_fts MATCH ? AND ${where}
          ORDER BY rank LIMIT 300`).all(phrases.join(' OR '), ...parameters)) rows.set(row.id, row);
    }
    // Trigram FTS cannot match two-character Chinese words. Keep exact substring support.
    const short = terms.filter((term) => [...term].length < 3);
    if (short.length) {
      const condition = short.map(() => "instr(lower(m.text),?)>0").join(' OR ');
      for (const row of this.db.prepare(`SELECT m.* FROM messages m WHERE ${where} AND (${condition})
          ORDER BY m.timestamp DESC LIMIT 300`).all(...parameters, ...short)) rows.set(row.id, row);
    }
    const ranked = [...rows.values()].map((row) => {
      const lower = row.text.toLowerCase();
      const matches = terms.filter((term) => lower.includes(term));
      const score = matches.reduce((total, term) => total + Math.min(12, [...term].length), 0) /
        Math.sqrt(1 + row.text.length / 350);
      return { row, score, matches };
    }).sort((a, b) => b.score - a.score || a.row.timestamp.localeCompare(b.row.timestamp));
    return { retrieval: 'local lexical search with Chinese phrase support', results: ranked.slice(0, limit).map(({ row, score, matches }) => ({
      message_id: row.id, thread_id: row.thread_id, timestamp: row.timestamp, speaker: row.role,
      excerpt: excerpt(row.text, matches), matches, score: Number(score.toFixed(3)),
      source_id: row.source_id,
    })) };
  }

  async hybridSearch(args) {
    const limit = args.limit ?? 6;
    const lexical = this.search({ ...args, limit: 24 });
    const fallback = { ...lexical, results: lexical.results.slice(0, limit) };
    if (!this.config.semantic || args.mode === 'keyword') return fallback;
    const threads = this.visibleThreads(args.project_path, args.thread_id);
    if (!threads.length) return fallback;
    try {
      const { ranking, vectors } = await runPython('semantic.py', ['search', this.root], {
        query: args.query, threads, speaker: args.speaker, from: args.from, to: args.to,
        lexical: lexical.results.map((row) => row.message_id),
      }, 7000);
      if (!vectors.length) return { ...fallback, semantic: 'no_hits' };
      const keywords = new Map(lexical.results.map((row) => [row.message_id, row]));
      const semantic = new Map(vectors.map((hit) => [hit.id, hit]));
      const lookup = this.db.prepare('SELECT id,thread_id,timestamp,role,text,source_id FROM messages WHERE id=?');
      const results = [];
      for (const [id, score, routes] of ranking) {
        const row = lookup.get(id);
        if (!row || !this.canRead(row.thread_id, args.project_path)) continue;
        const vector = semantic.get(id);
        const keyword = keywords.get(id);
        const start = Math.max(0, (vector?.start ?? 0) - 40);
        let snippet = keyword?.excerpt;
        if (!snippet) {
          const characters = [...row.text];
          snippet = { text: characters.slice(start, start + 700).join(''),
            truncated: start > 0 || characters.length > start + 700 };
        }
        results.push({ message_id: id, thread_id: row.thread_id, timestamp: row.timestamp, speaker: row.role,
          source_id: row.source_id, excerpt: snippet, matches: keyword?.matches ?? [],
          score: Number(score.toFixed(6)), routes, ...(vector ? { cosine: vector.cosine } : {}) });
        if (results.length === limit) break;
      }
      return { retrieval: 'local semantic + keyword (RRF)', semantic: 'available', results };
    } catch {
      return { ...fallback, semantic: 'unavailable' };
    }
  }

  context({ message_id, project_path, before = 2, after = 2, max_chars = 16000 }) {
    const target = this.db.prepare('SELECT thread_id FROM messages WHERE id=?').get(message_id);
    if (!target || !this.canRead(target.thread_id, project_path)) throw new Error('消息不存在或不在当前可读范围');
    const rows = this.db.prepare('SELECT id,timestamp,role,text,attachments FROM messages WHERE thread_id=? ORDER BY timestamp,source_offset,id').all(target.thread_id);
    const index = rows.findIndex((row) => row.id === message_id);
    const selected = rows.slice(Math.max(0, index - before), index + after + 1);
    const perMessage = Math.floor(max_chars / selected.length);
    return { thread_id: target.thread_id, messages: selected.map((row) => ({ ...row,
      text: row.text.slice(0, perMessage), truncated: row.text.length > perMessage,
      attachments: JSON.parse(row.attachments),
    })), guidance: '标记 truncated 的长消息可用 before=0、after=0 和更大的 max_chars 单独读取。完整原文另存于 exports。' };
  }

  noteRows(projectPath, includeHistory = false) {
    const project = projectPath ? projectKey(projectPath) : '';
    const status = includeHistory ? '' : " AND status='active'";
    return this.db.prepare(`SELECT * FROM memory_notes WHERE (scope='shared' OR (scope='project' AND project=?))${status}
      ORDER BY created_at DESC,id`).all(project).map(({ payload, ...row }) => ({ ...row,
        source_message_ids: this.db.prepare('SELECT message_id FROM memory_note_sources WHERE note_id=? ORDER BY message_id').all(row.id).map((r) => r.message_id),
      }));
  }

  notes(projectPath, includeHistory = false) {
    return this.rankedNotes(projectPath, includeHistory).slice(0, 50);
  }

  rankedNotes(projectPath, includeHistory) {
    return this.noteRows(projectPath, includeHistory).map((note) => ({ ...note, memory: this.lifecycle.state(note) }))
      .sort((a, b) => Number(b.memory.core) - Number(a.memory.core) || b.memory.R - a.memory.R || b.created_at.localeCompare(a.created_at));
  }

  bootstrap(projectPath) {
    return this.bootstrapContext(projectPath).notes;
  }

  bootstrapContext(projectPath) {
    const visible = this.rankedNotes(projectPath, false).filter((note) => !note.memory.frozen);
    const snippets = (items, limit) => items.slice(0, limit).map((note) => ({ ...note, text: note.text.slice(0, 300) }));
    return {
      notes: snippets(visible.filter((note) => note.kind !== 'self_observation'), 8),
      self_observations: snippets(visible.filter((note) => note.kind === 'self_observation'), 2),
    };
  }

  accessibleNote(noteId, projectPath) {
    const note = this.db.prepare('SELECT * FROM memory_notes WHERE id=?').get(noteId);
    if (!note || (note.scope === 'project' && note.project !== projectKey(projectPath))) throw new Error('记忆不存在或项目不符');
    return note;
  }

  review({ note_id, project_path, rating = 'good' }) {
    const note = this.accessibleNote(note_id, project_path);
    if (note.status !== 'active') throw new Error('只能复习当前有效的记忆');
    return { id: note.id, ...this.lifecycle.review(note, rating) };
  }

  setCore({ note_id, project_path, core }) {
    const note = this.accessibleNote(note_id, project_path);
    if (note.status !== 'active') throw new Error('只能设置当前有效的记忆');
    return { id: note.id, memory: this.lifecycle.setCore(note, core) };
  }

  async associate({ note_id, text, project_path, limit = 3, min_age_days = 0 }) {
    let seed = text;
    if (note_id) {
      const note = this.accessibleNote(note_id, project_path);
      if (note.status !== 'active') throw new Error('种子记忆已经归档或被修订');
      seed = note.text;
    }
    if (!seed?.trim()) throw new Error('请提供主题文字或种子记忆编号');
    const hubs = new Set(['用户', 'codex', 'ai', '讨论', '明确', '随后', '是否', '能够', '需要', '作为', '自己', ...stopwords]);
    const notes = this.noteRows(project_path).map((note) => ({ ...note,
      created_ms: Date.parse(note.created_at),
      entities: [...new Set([...segmenter.segment(note.text)].filter((w) => w.isWordLike)
        .map((w) => w.segment).filter((w) => [...w].length >= 2 && !hubs.has(w.toLowerCase())))].slice(0, 30),
    }));
    const result = await associateUpstream({ text: seed, notes, exclude: note_id ? [note_id] : [],
      limit, min_age_days, now: this.now() });
    const current = new Map(this.noteRows(project_path).map((note) => [note.id, note]));
    return { engine: 'upstream memory_rag.recall.associate', items: result.items.filter((item) => current.has(item.summary_id))
      .map((item) => ({ note: current.get(item.summary_id), via: item.via, score: item.score,
        memory: this.lifecycle.state(current.get(item.summary_id)) })) };
  }

  remember({ operation_id, text, kind, scope = 'project', project_path, source_message_ids, supersedes, core }) {
    const project = scope === 'project' ? projectKey(project_path) : '';
    if (!source_message_ids?.length) throw new Error('记忆必须附上原文消息编号');
    const evidence = [...new Set(source_message_ids)].sort();
    const payload = JSON.stringify({ text, kind, scope, project, evidence, supersedes: supersedes ?? null, core: core ?? null });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT id,payload FROM memory_notes WHERE operation_id=?').get(operation_id);
      if (previous) {
        const legacy = JSON.parse(previous.payload);
        const canonical = JSON.stringify({ ...legacy, core: legacy.core ?? null });
        if (canonical !== payload) throw new Error('同一操作编号对应不同内容');
        this.db.exec('COMMIT');
        return { id: previous.id, replayed: true };
      }
      const sources = evidence.map((id) => this.db.prepare('SELECT role,thread_id FROM messages WHERE id=?').get(id));
      if (sources.some((row) => !row || (scope === 'shared' ? !this.shared.includes(row.thread_id) : !this.canRead(row.thread_id, project_path)))) {
        throw new Error('来源消息不存在或超出此条记忆的范围');
      }
      if (['preference', 'user_statement'].includes(kind) && !sources.some((row) => row.role === 'user')) {
        throw new Error('关于用户的记忆需要用户发言作为依据');
      }
      if (kind === 'self_observation' && !sources.some((row) => row.role === 'assistant')) {
        throw new Error('助手观察需要至少一条助手发言作为依据');
      }
      let inheritedCore = false;
      if (supersedes) {
        const old = this.db.prepare('SELECT * FROM memory_notes WHERE id=?').get(supersedes);
        if (!old || old.status !== 'active' || old.scope !== scope || old.project !== project) throw new Error('被修订的记忆不可用或范围不同');
        inheritedCore = this.lifecycle.state(old).core;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO memory_notes VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, operation_id, payload, scope, project, kind, text, 'active', supersedes ?? null, new Date(this.now()).toISOString());
      for (const sourceId of evidence) this.db.prepare('INSERT INTO memory_note_sources VALUES (?,?)').run(id, sourceId);
      const saved = this.db.prepare('SELECT * FROM memory_notes WHERE id=?').get(id);
      this.lifecycle.initialize(saved, core ?? inheritedCore);
      if (supersedes) this.db.prepare("UPDATE memory_notes SET status='superseded' WHERE id=?").run(supersedes);
      this.db.exec('COMMIT');
      return { id, replayed: false, supersedes: supersedes ?? null };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  archiveNote({ note_id, project_path }) {
    const note = this.db.prepare('SELECT scope,project,status FROM memory_notes WHERE id=?').get(note_id);
    if (!note || (note.scope === 'project' && note.project !== projectKey(project_path))) throw new Error('记忆不存在或项目不符');
    if (note.status === 'superseded') throw new Error('这条记忆已有修订，请查看历史');
    this.db.prepare("UPDATE memory_notes SET status='archived' WHERE id=?").run(note_id);
    return { id: note_id, status: 'archived' };
  }

  status() {
    const read = (name) => fs.existsSync(path.join(this.root, name)) ? JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8')) : null;
    const heartbeat = read('heartbeat.json');
    return { root: this.root, collection: read('status.json'), heartbeat,
      collector_recently_seen: Boolean(heartbeat && Date.now() - Date.parse(heartbeat.at) < 60000),
      semantic: this.semanticStatus(), topics: this.topicStatus(),
      continuity: this.db.prepare(`SELECT
        (SELECT count(*) FROM conversation_checkpoints WHERE trigger='collector') AS chats_with_checkpoints,
        (SELECT count(*) FROM conversation_checkpoints WHERE trigger='pre_compact') AS chats_with_pre_compact_checkpoints,
        (SELECT count(*) FROM memory_artifacts) AS artifact_versions`).get(),
      backup: this.config.backup ? read('backup-status.json') ?? { state: 'pending' } : { state: 'disabled' },
      totals: this.db.prepare('SELECT (SELECT count(*) FROM messages) messages,(SELECT count(*) FROM threads) threads,(SELECT count(*) FROM memory_notes WHERE status=\'active\') active_notes').get() };
  }

  semanticStatus() {
    if (!this.config.semantic) return { state: 'disabled' };
    try {
      const { port, ...status } = JSON.parse(fs.readFileSync(path.join(this.root, 'semantic-status.json'), 'utf8'));
      return Date.now() - status.at_ms < 120000 ? status : { state: 'offline' };
    } catch { return { state: 'offline' }; }
  }

  topicStatus() {
    const index = path.join(this.root, 'data', 'topics.sqlite3');
    if (!fs.existsSync(index)) return { state: 'pending' };
    let database;
    try {
      database = new DatabaseSync(index, { readOnly: true });
      database.exec('PRAGMA busy_timeout=1000');
      const indexed = database.prepare('SELECT coalesce(sum(count), 0) AS n FROM topic_progress').get().n;
      const totals = database.prepare(`SELECT (SELECT count(*) FROM summaries) AS summaries,
        (SELECT count(*) FROM entities) AS concepts, (SELECT count(*) FROM relations) AS relationships`).get();
      const messages = this.db.prepare('SELECT count(*) AS n FROM messages').get().n;
      return { state: indexed === messages ? 'ready' : 'indexing', indexed, messages, ...totals };
    } catch { return { state: 'unavailable' }; }
    finally { database?.close(); }
  }
}
