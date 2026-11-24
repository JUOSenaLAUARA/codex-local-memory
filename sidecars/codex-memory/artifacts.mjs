import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, projectKey } from './store.mjs';

const maximumBytes = 16 * 1024 * 1024;
const metadataColumns = 'id, project, relative_path, description, sha256, bytes, saved_at';

function inside(directory, file) {
  const relative = path.relative(directory, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('文件须在当前项目目录内');
  }
  return relative;
}

function snapshotBytes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const original = fs.fstatSync(fd);
    if (!original.isFile()) throw new Error('只能保存普通文件');
    if (original.size > maximumBytes) throw new Error('单个产物最多保存 16 MiB');
    const content = Buffer.alloc(original.size);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(fd, content, offset, content.length - offset, offset);
      if (count === 0) throw new Error('文件在读取时发生变化');
      offset += count;
    }
    const current = fs.fstatSync(fd);
    if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
      throw new Error('文件在读取时发生变化');
    }
    return content;
  } finally { fs.closeSync(fd); }
}

export class ArtifactStore {
  constructor(db, now) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_artifacts (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, relative_path TEXT NOT NULL,
        description TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
        saved_at TEXT NOT NULL, content BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_artifacts_project ON memory_artifacts(project,saved_at);
      CREATE TABLE IF NOT EXISTS memory_artifact_sources (
        artifact_id TEXT NOT NULL REFERENCES memory_artifacts(id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        PRIMARY KEY(artifact_id,message_id)
      );
    `);
  }

  withSources(record) {
    const rows = this.db.prepare('SELECT message_id FROM memory_artifact_sources WHERE artifact_id=? ORDER BY message_id')
      .all(record.id);
    return { ...record, source_message_ids: rows.map((row) => row.message_id) };
  }

  save({ project_path, file_path, description, source_message_ids }) {
    const project = projectKey(project_path);
    const evidence = [...new Set(source_message_ids ?? [])];
    const find = this.db.prepare('SELECT t.cwd FROM messages m JOIN threads t ON m.thread_id=t.id WHERE m.id=?');
    if (!evidence.length || !evidence.every((id) => {
      const message = find.get(id);
      return message?.cwd && projectKey(message.cwd) === project;
    })) throw new Error('归档产物需要当前项目的原文依据');
    if (!path.isAbsolute(file_path)) throw new Error('文件须使用绝对路径');
    const root = fs.realpathSync(project_path);
    inside(path.resolve(project_path), path.resolve(file_path));
    const file = fs.realpathSync(file_path);
    const relative = inside(root, file).split(path.sep).join('/');
    const content = snapshotBytes(file);
    const sha256 = digest(content);
    const id = digest(JSON.stringify([project, relative, sha256]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO memory_artifacts VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, project, relative, description, sha256, content.length, new Date(this.now()).toISOString(), content);
      const attach = this.db.prepare('INSERT OR IGNORE INTO memory_artifact_sources VALUES (?,?)');
      for (const source of evidence) attach.run(id, source);
      const record = this.db.prepare(`SELECT ${metadataColumns} FROM memory_artifacts WHERE id=?`).get(id);
      const result = this.withSources(record);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  list({ project_path, query = '', limit = 10 }) {
    const project = projectKey(project_path);
    const filter = query.trim().toLowerCase();
    const rows = this.db.prepare(`SELECT ${metadataColumns} FROM memory_artifacts WHERE project=?
      AND (instr(lower(relative_path),?)>0 OR instr(lower(description),?)>0)
      ORDER BY saved_at DESC,rowid DESC LIMIT ?`).all(project, filter, filter, limit);
    return rows.map((row) => this.withSources(row));
  }

  restore({ project_path, artifact_id, destination }, targetDirectory = project_path) {
    const project = projectKey(project_path);
    const record = this.db.prepare(`SELECT ${metadataColumns},content FROM memory_artifacts WHERE id=? AND project=?`)
      .get(artifact_id, project);
    if (!record) throw new Error('产物不存在或项目不符');
    const { content, ...metadata } = record;
    if (content.length !== record.bytes || digest(content) !== record.sha256) throw new Error('产物完整性校验失败');
    if (!path.isAbsolute(destination)) throw new Error('恢复目标须使用绝对路径');
    const root = fs.realpathSync(targetDirectory);
    inside(path.resolve(targetDirectory), path.resolve(destination));
    const parent = fs.realpathSync(path.dirname(destination));
    const target = path.join(parent, path.basename(destination));
    inside(root, target);
    const result = this.withSources(metadata);
    const temporary = path.join(parent, `.memory-artifact-${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.linkSync(temporary, target);
    } finally { fs.unlinkSync(temporary); }
    return { ...result, destination: target };
  }
}
