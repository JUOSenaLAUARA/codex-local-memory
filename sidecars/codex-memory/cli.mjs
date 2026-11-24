import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, atomicWrite } from './store.mjs';
import { pythonWorker, runPython } from './upstream-association.mjs';
import { externalBackup, restoreExternalSnapshot, verifyExternalSnapshot } from './backup.mjs';
import { ArtifactStore } from './artifacts.mjs';

const [command = 'status', rootArgument, destination, ...extra] = process.argv.slice(2);
const standalone = ['verify-backup', 'restore-backup'].includes(command);
const root = path.resolve(rootArgument ?? fileURLToPath(new URL('../../../', import.meta.url)));
const config = standalone ? null : JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
if (config && (config.version !== 1 || !Array.isArray(config.sourceDirectories) || !Array.isArray(config.threadIds) ||
    !Number.isFinite(Date.parse(config.captureSince)) || !(config.pollSeconds >= 5))) {
  throw new Error('采集配置不完整');
}

function saveExternal(store, force = false) {
  const backup = externalBackup(store.db, config, { force });
  atomicWrite(path.join(root, 'backup-status.json'), JSON.stringify({
    state: 'ok', directory: backup.directory, createdAt: backup.manifest.createdAt, totals: backup.manifest.totals,
  }, null, 2));
  return backup;
}

function refreshTopics(force = false) {
  return runPython('topics.py', [force ? 'rebuild' : 'refresh', root], {}, 600000);
}

if (standalone) {
  if (!rootArgument || (command === 'restore-backup' && !destination)) {
    throw new Error('用法：verify-backup <快照目录> 或 restore-backup <快照目录> <新目录>');
  }
  const result = command === 'verify-backup' ? verifyExternalSnapshot(root) : restoreExternalSnapshot(root, destination);
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'status') {
  console.log(fs.readFileSync(path.join(root, 'status.json'), 'utf8'));
} else if (command === 'rebuild-topics') {
  console.log(JSON.stringify(await refreshTopics(true)));
} else if (command === 'precompact-hook') {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (event?.hook_event_name !== 'PreCompact' || !event.session_id || !event.cwd) {
    throw new Error('没有收到有效的 PreCompact 事件');
  }
  const store = new MemoryStore(root);
  try {
    const saved = store.captureBeforeCompaction(event.session_id, event.cwd);
    console.log(JSON.stringify(saved ? { continue: true } :
      { continue: true, systemMessage: '记忆库还没有当前聊天的可用原文。采集器会继续保存。' }));
  } finally { store.close(); }
} else if (command === 'recover-artifact') {
  const [artifactId, fileName] = extra;
  if (!destination || !artifactId || !fileName || fileName === '.' || fileName === '..' || /[\\/:]/.test(fileName)) {
    throw new Error('用法：recover-artifact <记忆目录> <原项目绝对路径> <产物编号> <恢复文件名>');
  }
  const store = new MemoryStore(root);
  try {
    const directory = path.join(root, 'recovered-artifacts');
    fs.mkdirSync(directory, { recursive: true });
    const artifacts = new ArtifactStore(store.db, () => Date.now());
    console.log(JSON.stringify(artifacts.restore({ project_path: destination, artifact_id: artifactId,
      destination: path.join(directory, fileName) }, directory), null, 2));
  } finally { store.close(); }
} else if (command === 'watch') {
  const lockPath = path.join(root, 'collector.lock');
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previousPid = Number(fs.readFileSync(lockPath, 'utf8'));
    let alive = false;
    try { process.kill(previousPid, 0); alive = true; } catch {}
    if (alive) { console.log('采集器已在运行'); process.exit(0); }
    fs.unlinkSync(lockPath);
    // Exclusive creation makes simultaneous restarts safe.
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  }
  const store = new MemoryStore(root);
  let semanticWorker;
  let retryAt = 0;
  let checkBackupAt = 0;
  let topicsDirty = true;
  let topicsRunning = false;
  let topicsRetryAt = 0;
  const startSemantic = () => {
    if (!config.semantic || semanticWorker || Date.now() < retryAt) return;
    const { executable, weights } = config.semantic;
    semanticWorker = pythonWorker('semantic.py', ['watch', root, path.resolve(root, executable), path.resolve(root, weights)],
      { stdio: ['pipe', 'ignore', 'inherit'] });
    semanticWorker.on('error', (error) => console.error(`Semantic worker: ${error.message}`));
    semanticWorker.stdin.on('error', () => {});
    semanticWorker.on('close', () => { semanticWorker = undefined; retryAt = Date.now() + 60000; });
  };
  const cycle = () => {
    try {
      const result = store.scan(config);
      topicsDirty ||= result.added > 0;
      store.backup();
      atomicWrite(path.join(root, 'heartbeat.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      if (result.added || result.errors.length) console.log(JSON.stringify(result));
      startSemantic();
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), error: error.message }));
    }
    if (topicsDirty && !topicsRunning && Date.now() >= topicsRetryAt) {
      topicsDirty = false;
      topicsRunning = true;
      refreshTopics().catch((error) => {
        topicsDirty = true;
        topicsRetryAt = Date.now() + 60000;
        console.error(`话题索引更新失败：${error.message}`);
      }).finally(() => { topicsRunning = false; });
    }
    if (config.backup && Date.now() >= checkBackupAt) {
      checkBackupAt = Date.now() + 60000;
      try { saveExternal(store); }
      catch (error) {
        console.error(`异盘备份失败：${error.message}`);
        try {
          atomicWrite(path.join(root, 'backup-status.json'), JSON.stringify({
            state: 'error', at: new Date().toISOString(), error: error.message,
          }, null, 2));
        } catch (statusError) { console.error(statusError.message); }
      }
    }
  };
  const shutdown = () => {
    semanticWorker?.stdin.end();
    store.close();
    if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  cycle();
  setInterval(cycle, config.pollSeconds * 1000);
} else if (['scan', 'export', 'backup', 'backup-external'].includes(command)) {
  const store = new MemoryStore(root);
  try {
    if (command === 'scan') {
      console.log(JSON.stringify(store.scan(config), null, 2));
      await refreshTopics();
    }
    if (command === 'export') {
      for (const row of store.db.prepare('SELECT id FROM threads').all()) store.exportThread(row.id);
      console.log('原文导出已重建');
    }
    if (command === 'backup') console.log(store.backup({ force: true }));
    if (command === 'backup-external') console.log(JSON.stringify(saveExternal(store, true), null, 2));
  } finally { store.close(); }
} else {
  throw new Error('命令应为 scan、watch、status、export、rebuild-topics、precompact-hook、recover-artifact、backup、backup-external、verify-backup 或 restore-backup');
}
