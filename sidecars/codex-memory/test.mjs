import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memory-test-'));
  const input = path.join(root, 'sessions');
  fs.mkdirSync(input);
  const file = path.join(input, 'session.jsonl');
  const config = { threadIds: ['conversation-1'], captureNewChats: true,
    captureSince: '2026-11-24T10:00:00Z', sourceDirectories: [input] };
  const store = new MemoryStore(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const meta = { type: 'session_meta', payload: { id: 'conversation-1', timestamp: '2026-11-24T09:00:00Z', cwd: 'D:/example' } };
  const message = (id, text, role = 'user', phase) => ({ timestamp: '2026-11-24T09:01:00Z', type: 'response_item',
    payload: { type: 'message', id, role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  const write = (records) => fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  return { root, file, input, store, config, meta, message, write };
}

test('可见原文、角色、附件、重复文字和过滤内部消息', (t) => {
  const f = fixture(t);
  const attachment = f.message('image', '');
  attachment.payload.content = [{ type: 'input_image', image_url: 'data:image/png;base64,SECRET' }];
  f.write([f.meta, f.message('setup', '# AGENTS.md instructions\nconfiguration'),
    f.message('1', '图书归档'), f.message('2', '图书归档'),
    f.message('3', '内部文字', 'assistant', 'analysis'),
    f.message('4', '进度文字', 'assistant', 'commentary'),
    f.message('5', '保存你的原话', 'assistant', 'final_answer'), attachment]);
  assert.equal(f.store.scan(f.config).added, 4);
  const rows = f.store.db.prepare('SELECT * FROM messages ORDER BY source_offset').all();
  assert.deepEqual(rows.map((r) => r.role), ['user', 'user', 'assistant', 'user']);
  assert.equal(rows[0].text, '图书归档');
  assert.ok(!rows[3].attachments.includes('SECRET'));
  assert.equal(rows[0].source_file, f.file);
});

test('重复采集和数据库重开幂等，缺失导出可以恢复', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', '原文')]);
  assert.equal(f.store.scan(f.config).added, 1);
  assert.equal(f.store.scan(f.config).added, 0);
  fs.unlinkSync(path.join(f.root, 'exports', 'conversation-1.md'));
  const reopened = new MemoryStore(f.root);
  try {
    assert.equal(reopened.scan(f.config).added, 0);
    assert.ok(fs.readFileSync(path.join(f.root, 'exports', 'conversation-1.md'), 'utf8').includes('原文'));
  } finally { reopened.close(); }
});

test('采集随原文保存续接点，PreCompact 只为匹配的聊天保存快照', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('u1', '整理项目进度'), f.message('a1', '备份已完成', 'assistant', 'final_answer')]);
  f.store.scan(f.config);
  const checkpoint = (trigger) => f.store.db.prepare('SELECT * FROM conversation_checkpoints WHERE trigger=?').get(trigger);
  const first = checkpoint('collector');
  assert.equal(JSON.parse(first.message_ids).length, 2);
  f.store.scan(f.config);
  assert.deepEqual(checkpoint('collector'), first);

  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ ...f.config, version: 1, pollSeconds: 5 }));
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const invoke = (cwd) => spawnSync(process.execPath, [cli, 'precompact-hook', f.root], { encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: f.meta.payload.id, cwd, trigger: 'auto' }) });
  const wrong = invoke('D:/Other');
  assert.equal(wrong.status, 0, wrong.stderr);
  assert.ok(JSON.parse(wrong.stdout).systemMessage);
  assert.equal(checkpoint('pre_compact'), undefined);
  const right = invoke('D:/example');
  assert.equal(right.status, 0, right.stderr);
  assert.deepEqual(JSON.parse(right.stdout), { continue: true });
  assert.equal(checkpoint('pre_compact').message_ids, first.message_ids);

  fs.appendFileSync(f.file, JSON.stringify(f.message('u2', '继续整理未办事项')) + '\n');
  f.store.scan(f.config);
  assert.equal(JSON.parse(checkpoint('collector').message_ids).length, 3);
  assert.equal(checkpoint('pre_compact').message_ids, first.message_ids);
});

test('半条中文消息等完整换行后再入库', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', '第一条')]);
  f.store.scan(f.config);
  const bytes = Buffer.from(JSON.stringify(f.message('2', '龙娘的新消息')) + '\n');
  const split = bytes.indexOf(Buffer.from('龙')) + 1;
  fs.appendFileSync(f.file, bytes.subarray(0, split));
  const partial = f.store.scan(f.config);
  assert.equal(partial.added, 0);
  assert.equal(partial.incomplete, 1);
  fs.appendFileSync(f.file, bytes.subarray(split));
  assert.equal(f.store.scan(f.config).added, 1);
  assert.equal(f.store.db.prepare("SELECT text FROM messages WHERE source_id='2'").get().text, '龙娘的新消息');
});

test('完整坏行阻止断点推进，修复后补齐', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', '先保存')]);
  f.store.scan(f.config);
  const before = f.store.db.prepare('SELECT offset FROM sources').get().offset;
  fs.appendFileSync(f.file, JSON.stringify(f.message('2', '稍后提交')) + '\n{bad json}\n');
  assert.equal(f.store.scan(f.config).errors.length, 1);
  assert.equal(f.store.db.prepare('SELECT offset FROM sources').get().offset, before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n, 1);
  f.write([f.meta, f.message('1', '先保存'), f.message('2', '稍后提交')]);
  assert.equal(f.store.scan(f.config).added, 1);
});

test('同编号内容冲突整批回滚，保存的原话不被覆盖', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', '最初的原文')]);
  f.store.scan(f.config);
  f.write([f.meta, f.message('2', '不能部分提交'), f.message('1', '被改动的原文')]);
  assert.equal(f.store.scan(f.config).errors.length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT text FROM messages').get().text, '最初的原文');
});

test('日志截断、重放和压缩迁移不会重复或丢历史', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', '曾经'), f.message('2', '留下')]);
  f.store.scan(f.config);
  f.write([f.meta, f.message('2', '留下'), f.message('3', '新的')]);
  assert.equal(f.store.scan(f.config).added, 1);
  fs.writeFileSync(`${f.file}.zst`, zstdCompressSync(fs.readFileSync(f.file)));
  fs.unlinkSync(f.file);
  assert.equal(f.store.scan(f.config).added, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n, 3);
});

test('只导入指定历史聊天和安装后新建的聊天', (t) => {
  const f = fixture(t);
  const old = { type: 'session_meta', payload: { id: 'other-old', timestamp: '2026-11-23T00:00:00Z' } };
  f.write([old, f.message('1', '旧聊天')]);
  assert.equal(f.store.scan(f.config).added, 0);
  const fresh = { type: 'session_meta', payload: { id: 'new-chat', timestamp: '2026-11-24T11:00:00Z' } };
  f.write([fresh, f.message('1', '新聊天')]);
  assert.equal(f.store.scan(f.config).added, 1);
  f.write([f.meta, f.message('1', '指定聊天')]);
  assert.equal(f.store.scan(f.config).added, 1);
});

test('两次扫描之间移动到归档目录的聊天可补齐，已采集消息不重复', (t) => {
  const f = fixture(t);
  const archive = path.join(f.root, 'archived_sessions');
  fs.mkdirSync(archive);
  f.config.sourceDirectories.push(archive);
  f.write([f.meta, f.message('1', '归档之前已保存')]);
  assert.equal(f.store.scan(f.config).added, 1);
  f.write([f.meta, f.message('1', '归档之前已保存'), f.message('2', '归档前最后一句')]);
  fs.renameSync(f.file, path.join(archive, path.basename(f.file)));
  const result = f.store.scan(f.config);
  assert.equal(result.added, 1);
  assert.equal(result.messages, 2);
});

test('无法识别的消息格式报告错误并停在上次成功位置', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', '正常')]);
  f.store.scan(f.config);
  const bad = f.message('2', '变化');
  bad.payload.content = { newFormat: true };
  fs.appendFileSync(f.file, JSON.stringify(bad) + '\n');
  const result = f.store.scan(f.config);
  assert.match(result.errors[0].error, /格式变化/);
  assert.equal(result.messages, 1);
});

test('新的最终回复阶段会显式报错，避免静默漏采', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', 'new format', 'assistant', 'new-final-phase')]);
  const result = f.store.scan(f.config);
  assert.equal(result.messages, 0);
  assert.match(result.errors[0].error, /回复阶段/);
});

test('备份是独立可恢复的 SQLite 文件，导出与消息数一致', (t) => {
  const f = fixture(t);
  f.write([f.meta, f.message('1', '备份恢复测试')]);
  f.store.scan(f.config);
  const backup = f.store.backup();
  const recovered = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(recovered.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(recovered.prepare('SELECT text FROM messages').get().text, '备份恢复测试');
  } finally { recovered.close(); }
  const restoreRoot = path.join(f.root, 'restored');
  fs.mkdirSync(path.join(restoreRoot, 'data'), { recursive: true });
  fs.copyFileSync(backup, path.join(restoreRoot, 'data', 'conversations.sqlite3'));
  const restored = new MemoryStore(restoreRoot);
  try {
    restored.exportThread('conversation-1');
    assert.ok(fs.readFileSync(path.join(restoreRoot, 'exports', 'conversation-1.md'), 'utf8').includes('备份恢复测试'));
  } finally { restored.close(); }
  assert.equal(f.store.backup(), backup);
});
