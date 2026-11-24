import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { writeSnapshot } from './backup.mjs';

export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function projectKey(value) {
  if (!value || !(path.isAbsolute(value) || path.win32.isAbsolute(value))) throw new Error('请提供项目的绝对路径');
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() || '/';
}

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, file);
}

function listLogs(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return listLogs(file);
    return entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name) ? [file] : [];
  });
}

function readLog(file) {
  const bytes = fs.readFileSync(file);
  return file.endsWith('.zst') ? zstdDecompressSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }) : bytes;
}

function metadata(bytes) {
  const end = bytes.indexOf(10);
  if (end < 0) return null;
  const record = JSON.parse(bytes.subarray(0, end).toString('utf8').replace(/^\uFEFF/, ''));
  if (record.type !== 'session_meta' || !record.payload?.id || !record.payload?.timestamp) {
    throw new Error('日志首行缺少可识别的 session_meta，采集未推进');
  }
  return record.payload;
}

function candidateMessage(record, offset, session) {
  if (record.type !== 'response_item' || record.payload?.type !== 'message') return null;
  const item = record.payload;
  if (item.role !== 'user' && item.role !== 'assistant') return null;
  if (item.role === 'assistant' && !['final_answer', 'final'].includes(item.phase)) {
    if (['analysis', 'commentary', 'summary'].includes(item.phase)) return null;
    throw new Error(`无法识别的回复阶段 ${String(item.phase)}，采集未推进`);
  }
  if (!Array.isArray(item.content)) throw new Error('消息 content 格式变化，采集未推进');
  const attachments = [];
  const parts = [];
  for (const part of item.content) {
    if (['input_text', 'output_text', 'text'].includes(part.type)) {
      if (typeof part.text !== 'string') throw new Error('消息文本格式变化，采集未推进');
      parts.push(part.text);
    } else if (['input_image', 'image', 'image_url', 'input_audio', 'audio', 'input_file', 'file'].includes(part.type)) {
      // Keep attachment presence without copying embedded image/audio bytes or tool payloads.
      attachments.push({ type: String(part.type ?? 'unknown'), name: part.filename ?? null });
    } else {
      throw new Error(`无法识别的消息内容类型 ${String(part.type)}，采集未推进`);
    }
  }
  const text = parts.join('\n');
  if (item.role === 'user' && /^\s*(?:# AGENTS\.md instructions|<environment_context>|<turn_aborted>|<user_instructions>)/.test(text)) return null;
  if (!text && attachments.length === 0) return null;
  const sourceId = item.id || `ordinal:${record.ordinal ?? offset}`;
  return {
    id: digest(`${session.id}\0${sourceId}`), sourceId, thread: session.id,
    time: record.timestamp || session.timestamp, role: item.role, text,
    attachments: JSON.stringify(attachments), hash: digest(JSON.stringify({ text, attachments, role: item.role })),
    offset,
  };
}

export class MemoryStore {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(path.join(this.root, 'data'), { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'data', 'conversations.sqlite3'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, cwd TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
        source_id TEXT NOT NULL, timestamp TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, attachments TEXT NOT NULL, content_hash TEXT NOT NULL,
        source_file TEXT NOT NULL, source_offset INTEGER NOT NULL,
        UNIQUE(thread_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, timestamp, source_offset);
      CREATE TABLE IF NOT EXISTS sources (
        path TEXT PRIMARY KEY, thread_id TEXT NOT NULL, offset INTEGER NOT NULL,
        head_length INTEGER NOT NULL, head_hash TEXT NOT NULL, tail_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_checkpoints (
        thread_id TEXT NOT NULL REFERENCES threads(id),
        trigger TEXT NOT NULL CHECK(trigger IN ('collector','pre_compact')),
        message_ids TEXT NOT NULL,
        anchor_at TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        PRIMARY KEY(thread_id,trigger)
      );
      PRAGMA foreign_keys=ON;
    `);
    this.insertMessage = this.db.prepare(`INSERT OR IGNORE INTO messages
      (id,thread_id,source_id,timestamp,role,text,attachments,content_hash,source_file,source_offset)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
  }

  importFile(file, config) {
    const bytes = readLog(file);
    const session = metadata(bytes);
    if (!session) return { added: 0, incomplete: true };
    const selected = config.threadIds.includes(session.id) ||
      (config.captureNewChats && Date.parse(session.timestamp) >= Date.parse(config.captureSince));
    if (!selected) return { added: 0, skipped: true };
    const previous = this.db.prepare('SELECT * FROM sources WHERE path=?').get(file);
    let offset = previous?.offset ?? 0;
    if (previous) {
      const head = digest(bytes.subarray(0, previous.head_length));
      const tail = digest(bytes.subarray(Math.max(0, offset - 128), offset));
      if (bytes.length < offset || head !== previous.head_hash || tail !== previous.tail_hash) offset = 0;
    }
    if (offset === bytes.length) {
      this.exportThread(session.id);
      return { added: 0, thread: session.id };
    }
    let position = offset;
    const messages = [];
    while (position < bytes.length) {
      const end = bytes.indexOf(10, position);
      if (end < 0) break;
      const line = bytes.subarray(position, end).toString('utf8').replace(/^\uFEFF/, '').trim();
      if (line) {
        const record = JSON.parse(line);
        if (typeof record.type !== 'string') throw new Error('日志记录类型缺失，采集未推进');
        const message = candidateMessage(record, position, session);
        if (message) messages.push(message);
      }
      position = end + 1;
    }
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO threads VALUES (?,?,?)')
        .run(session.id, session.timestamp, session.cwd ?? '');
      for (const message of messages) {
        const existing = this.db.prepare('SELECT content_hash FROM messages WHERE id=?').get(message.id);
        if (existing && existing.content_hash !== message.hash) {
          throw new Error(`同一消息编号内容变化 ${message.sourceId}，保留原文并停止推进`);
        }
        added += this.insertMessage.run(message.id, message.thread, message.sourceId, message.time,
          message.role, message.text, message.attachments, message.hash, file, message.offset).changes;
      }
      const headLength = Math.min(position, 4096);
      this.db.prepare(`INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,?,?)`).run(
        file, session.id, position, headLength, digest(bytes.subarray(0, headLength)),
        digest(bytes.subarray(Math.max(0, position - 128), position)), new Date().toISOString());
      if (added) this.captureCheckpoint(session.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Also repairs a missing or interrupted export when no new messages were inserted.
    this.exportThread(session.id);
    return { added, thread: session.id, offset: position, incomplete: position < bytes.length };
  }

  captureCheckpoint(threadId, trigger = 'collector') {
    const rows = this.db.prepare(`SELECT id,timestamp FROM messages WHERE thread_id=?
      ORDER BY timestamp DESC,source_offset DESC,id DESC LIMIT 8`).all(threadId);
    if (!rows.length) return null;
    const anchor = rows[0].timestamp;
    const ids = JSON.stringify(rows.reverse().map((row) => row.id));
    this.db.prepare(`INSERT INTO conversation_checkpoints VALUES (?,?,?,?,?)
      ON CONFLICT(thread_id,trigger) DO UPDATE SET message_ids=excluded.message_ids,
      anchor_at=excluded.anchor_at,saved_at=excluded.saved_at
      WHERE conversation_checkpoints.message_ids<>excluded.message_ids`)
      .run(threadId, trigger, ids, anchor, new Date().toISOString());
    return { thread_id: threadId, source_message_ids: JSON.parse(ids), anchor_at: anchor, trigger };
  }

  captureBeforeCompaction(threadId, cwd) {
    const session = this.db.prepare('SELECT cwd FROM threads WHERE id=?').get(threadId);
    if (!session?.cwd || projectKey(session.cwd) !== projectKey(cwd)) return null;
    return this.captureCheckpoint(threadId, 'pre_compact');
  }

  exportThread(threadId) {
    const thread = this.db.prepare('SELECT * FROM threads WHERE id=?').get(threadId);
    const rows = this.db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY timestamp,source_offset,id').all(threadId);
    const sections = [`# Codex 聊天原文\n\n聊天编号 ${threadId}\n\n项目目录 ${thread.cwd}\n\n开始时间 ${thread.started_at}\n\n按原文保存双方当时的说法。消息中的判断、引用与预测保留其当时身份。附件仅记录类型与可用名称。`];
    for (const row of rows) {
      const attachments = JSON.parse(row.attachments);
      sections.push(`## ${row.role === 'user' ? '用户' : 'Codex'} · ${row.timestamp}\n\n${row.text}${attachments.length ? `\n\n附件记录 ${JSON.stringify(attachments)}` : ''}\n\n<!-- message ${row.id} -->`);
    }
    atomicWrite(path.join(this.root, 'exports', `${threadId}.md`), `${sections.join('\n\n')}\n`);
  }

  scan(config) {
    const result = { at: new Date().toISOString(), added: 0, files: 0, selected: 0, incomplete: 0, errors: [] };
    for (const directory of config.sourceDirectories) {
      if (!fs.existsSync(directory)) {
        result.errors.push({ file: directory, error: '日志目录不存在' });
        continue;
      }
      for (const file of listLogs(directory)) {
        result.files++;
        try {
          // Existing older chats need only a small header read. Compressed archives are decoded once.
          if (!file.endsWith('.zst')) {
            const descriptor = fs.openSync(file, 'r');
            let header;
            try {
              header = Buffer.alloc(65536);
              header = header.subarray(0, fs.readSync(descriptor, header, 0, header.length, 0));
            } finally { fs.closeSync(descriptor); }
            const session = metadata(header);
            if (session && !config.threadIds.includes(session.id) &&
                !(config.captureNewChats && Date.parse(session.timestamp) >= Date.parse(config.captureSince))) continue;
          }
          const imported = this.importFile(file, config);
          if (!imported.skipped) result.selected++;
          result.added += imported.added;
          if (imported.incomplete) result.incomplete++;
        } catch (error) {
          result.errors.push({ file, error: error.message });
        }
      }
    }
    const missed = this.db.prepare(`SELECT t.id FROM threads t
      WHERE EXISTS (SELECT 1 FROM messages m WHERE m.thread_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM conversation_checkpoints c WHERE c.thread_id=t.id AND c.trigger='collector')`).all();
    for (const row of missed) this.captureCheckpoint(row.id);
    result.messages = this.db.prepare('SELECT count(*) n FROM messages').get().n;
    result.threads = this.db.prepare('SELECT count(*) n FROM threads').get().n;
    atomicWrite(path.join(this.root, 'status.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  backup({ force = false } = {}) {
    const directory = path.join(this.root, 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const stamp = force ? `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}` : new Date().toISOString().slice(0, 10);
    const target = path.join(directory, `conversations-${stamp}.sqlite3`);
    if (fs.existsSync(target)) return target;
    writeSnapshot(this.db, target);
    return target;
  }

  close() { this.db.close(); }
}
