import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const databaseName = 'conversations.sqlite3';
const snapshotPattern = /^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-[a-f0-9-]{36}$/;
const backupPeriod = 6 * 60 * 60 * 1000;

export function sha256File(file) {
  const descriptor = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length;
    while ((length = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function inspectDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('备份数据库完整性检查失败');
    const count = (table) => db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total;
    const tableExists = (name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return { messages: count('messages'), threads: count('threads'),
      notes: tableExists('memory_notes') ? count('memory_notes') : 0,
      reviews: tableExists('memory_note_lifecycle') ? count('memory_note_lifecycle') : 0 };
  } finally { db.close(); }
}

export function writeSnapshot(db, target) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    db.prepare('VACUUM INTO ?').run(temporary);
    const totals = inspectDatabase(temporary);
    const fd = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    return totals;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function syncJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flush: true, flag: 'wx' });
}

function configForBackup(config) {
  const { version, captureSince, captureNewChats, threadIds, sourceDirectories, pollSeconds, sharedThreadIds = [], semantic } = config;
  return { version, captureSince, captureNewChats, threadIds, sourceDirectories, pollSeconds, sharedThreadIds,
    ...(semantic ? { semantic: { executable: semantic.executable, weights: semantic.weights } } : {}) };
}

function sha256(file, expected) {
  if (sha256File(file) !== expected) throw new Error(`备份校验失败：${path.basename(file)}`);
}

export function verifyExternalSnapshot(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('无法识别备份格式');
  }
  const database = path.join(directory, databaseName);
  const config = path.join(directory, 'config.json');
  sha256(database, manifest.sha256?.database);
  sha256(config, manifest.sha256?.config);
  const actual = inspectDatabase(database);
  for (const key of Object.keys(actual)) {
    if (actual[key] !== manifest.totals?.[key]) throw new Error('备份条目数校验失败');
  }
  return manifest;
}

export function externalBackup(db, config, { force = false, now = new Date() } = {}) {
  const directory = config.backup?.directory;
  if (!directory || !path.isAbsolute(directory)) throw new Error('请配置独立备份的绝对路径');
  fs.mkdirSync(directory, { recursive: true });
  if (!force) {
    const recent = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && snapshotPattern.test(entry.name))
      .map((entry) => entry.name).sort().at(-1);
    if (recent) {
      const folder = path.join(directory, recent);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')); } catch {}
      const age = now - Date.parse(manifest?.createdAt);
      if (manifest?.version === 1 && age >= 0 && age < backupPeriod &&
          fs.existsSync(path.join(folder, databaseName)) && fs.existsSync(path.join(folder, 'config.json'))) {
        return { directory: folder, manifest };
      }
    }
  }
  const stamp = now.toISOString().replaceAll(':', '-');
  const filename = `snapshot-${stamp}-${randomUUID()}`;
  const target = path.join(directory, filename);
  const stage = path.join(directory, `.${filename}.tmp`);
  fs.mkdirSync(stage);
  const database = path.join(stage, databaseName);
  const settings = path.join(stage, 'config.json');
  const manifestPath = path.join(stage, 'manifest.json');
  try {
    const totals = writeSnapshot(db, database);
    syncJson(settings, configForBackup(config));
    const manifest = { version: 1, createdAt: now.toISOString(), totals,
      sha256: { database: sha256File(database), config: sha256File(settings) } };
    syncJson(manifestPath, manifest);
    fs.renameSync(stage, target);
    return { directory: target, manifest };
  } finally {
    if (fs.existsSync(stage)) {
      for (const file of [database, settings, manifestPath]) fs.rmSync(file, { force: true });
      fs.rmdirSync(stage);
    }
  }
}

export function restoreExternalSnapshot(snapshot, destination) {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error('恢复目标必须是一个尚未创建的目录');
  const manifest = verifyExternalSnapshot(snapshot);
  const stage = `${target}.${randomUUID()}.tmp`;
  const data = path.join(stage, 'data');
  const database = path.join(data, databaseName);
  const settings = path.join(stage, 'config.json');
  fs.mkdirSync(data, { recursive: true });
  try {
    fs.copyFileSync(path.join(snapshot, databaseName), database, fs.constants.COPYFILE_EXCL);
    sha256(database, manifest.sha256.database);
    const savedConfig = path.join(snapshot, 'config.json');
    const configBytes = fs.readFileSync(savedConfig);
    if (createHash('sha256').update(configBytes).digest('hex') !== manifest.sha256.config) throw new Error('备份配置在恢复期间发生变化');
    const config = JSON.parse(configBytes.toString('utf8'));
    // Restores start disconnected from live log ingestion until explicitly configured.
    config.sourceDirectories = [];
    config.captureNewChats = false;
    syncJson(settings, config);
    fs.renameSync(stage, target);
    return { directory: target, manifest };
  } finally {
    if (fs.existsSync(stage)) {
      for (const file of [database, settings]) fs.rmSync(file, { force: true });
      fs.rmdirSync(data);
      fs.rmdirSync(stage);
    }
  }
}
