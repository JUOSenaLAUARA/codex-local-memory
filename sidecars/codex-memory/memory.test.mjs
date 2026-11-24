import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConversationMemory } from './memory.mjs';
import { externalBackup, restoreExternalSnapshot, verifyExternalSnapshot } from './backup.mjs';
import { runPython } from './upstream-association.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-test-'));
  const config = { sharedThreadIds: ['shared'] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const memory = new ConversationMemory(root, config, options);
  memory.db.prepare('INSERT INTO threads VALUES (?,?,?)').run('shared', '2026-11-24T01:00:00Z', 'D:/Chat');
  memory.db.prepare('INSERT INTO threads VALUES (?,?,?)').run('p1', '2026-11-24T01:00:00Z', 'D:/Project1');
  memory.db.prepare('INSERT INTO threads VALUES (?,?,?)').run('p2', '2026-11-24T01:00:00Z', 'D:/Project2');
  const add = (id, text, role = 'user', thread = 'shared', time = '2026-11-24T01:00:00Z') => {
    memory.insertMessage.run(id, thread, id, time, role, text, '[]', id, 'fixture', memory.db.prepare('SELECT count(*) n FROM messages').get().n);
  };
  add('u1', '我想在周五完成图书归档，需要先核对目录是否齐全');
  add('a1', '把旧目录和书单核对后，再建立可搜索的图书归档索引。', 'assistant');
  add('u2', '我更喜欢用三条清单汇报进度');
  add('a2', '到2027年11月，我预计能完成旧书目录的整理。', 'assistant');
  add('p1msg', '项目1的账户设计', 'user', 'p1');
  add('p2msg', '项目2的账户设计', 'user', 'p2');
  t.after(() => { memory.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, memory, add };
}

test('中文长句和两字关键词可以检索，结果保留来源与说话者', (t) => {
  const { memory } = fixture(t);
  const found = memory.search({ query: '我们为什么先检查书单', keywords: ['图书归档', '目录'] });
  assert.ok(found.results.some((row) => row.message_id === 'u1' && row.speaker === 'user'));
  assert.ok(memory.search({ query: '清单' }).results.some((row) => row.message_id === 'u2'));
  const predictions = memory.search({ query: '你预测明年会怎样', keywords: ['2027', '整理'], speaker: 'assistant' });
  assert.ok(predictions.results.some((row) => row.message_id === 'a2'));
});

test('向量服务离线时，混合检索仍返回原有关键词结果', async (t) => {
  const { memory } = fixture(t);
  memory.config.semantic = {};
  const params = { query: '图书归档', speaker: 'user', limit: 1 };
  const offline = await memory.hybridSearch(params);
  assert.equal(offline.semantic, 'unavailable');
  assert.deepEqual(offline.results, memory.search(params).results);
  assert.deepEqual(await memory.hybridSearch({ ...params, mode: 'keyword' }), memory.search(params));
});

test('话题摘要和共现关系可回查原文，按会话隔离且从原文重建', async (t) => {
  const { memory, root, add } = fixture(t);
  add('private', '项目保密记录中的图书归档实验', 'assistant', 'p2');
  const refresh = (command = 'refresh') => runPython('topics.py', [command, root], {});
  assert.deepEqual(await refresh(), { changed_threads: 3 });
  assert.deepEqual(await refresh(), { changed_threads: 0 });
  const result = await memory.topics({ query: '图书归档' });
  const topic = result.items.find((item) => item.source_message_ids.includes('u1'));
  assert.ok(topic?.routes.includes('summary'));
  assert.ok(topic.routes.includes('graph'));
  assert.equal(new Set(topic.excerpts.map((excerpt) => excerpt.role)).size, 2);
  for (const excerpt of topic.excerpts) {
    const [original] = memory.context({ message_id: excerpt.message_id, before: 0, after: 0 }).messages;
    assert.equal(original.role, excerpt.role);
    assert.equal(original.timestamp, excerpt.timestamp);
    assert.equal([...original.text].slice(excerpt.start, excerpt.start + [...excerpt.text].length).join(''), excerpt.text);
  }
  assert.ok(topic.relationships.length);
  for (const edge of topic.relationships) {
    assert.equal(edge.kind, 'co_occurrence');
    assert.ok(topic.excerpts.some((excerpt) => excerpt.message_id === edge.message_id));
  }
  assert.ok(result.items.every((item) => item.thread_id === 'shared'));
  assert.deepEqual(await memory.topics({ query: '图书归档', thread_id: 'p2', project_path: 'D:/Project1' }), { items: [] });
  assert.ok((await memory.topics({ query: '图书归档', thread_id: 'p2', project_path: 'D:/Project2' })).items.length);
  assert.deepEqual(await refresh('rebuild'), { changed_threads: 3 });
  assert.deepEqual(await memory.topics({ query: '图书归档' }), result);

  add('later', '接着检查图书归档的书单', 'user', 'shared', '2026-11-24T01:10:00Z');
  assert.equal(memory.topicStatus().state, 'indexing');
  assert.deepEqual(await refresh(), { changed_threads: 1 });
  assert.equal(memory.topicStatus().state, 'ready');
  assert.ok((await memory.topics({ limit: 1 })).items[0].source_message_ids.includes('later'));
});

test('续接点保留可见原话和相关决定，助手观察保留来源及历史', (t) => {
  const { memory } = fixture(t);
  memory.captureCheckpoint('shared');
  memory.captureCheckpoint('p1');
  memory.remember({ operation_id: 'checkpoint-decision', kind: 'decision', text: '保持原文作为依据', scope: 'shared',
    source_message_ids: ['u1'] });
  memory.remember({ operation_id: 'checkpoint-open', kind: 'open_question', text: '项目一仍要确认账户范围',
    project_path: 'D:/Project1', source_message_ids: ['p1msg'] });
  const shared = memory.resume({ thread_id: 'shared' }).items[0];
  assert.ok(shared.recent_messages.some((message) => message.message_id === 'u1'));
  assert.equal(shared.decisions[0].text, '保持原文作为依据');
  assert.deepEqual(shared.open_questions, []);
  assert.equal(memory.resume({ thread_id: 'p1', project_path: 'D:/Project1' }).items[0].open_questions.length, 1);
  assert.deepEqual(memory.resume({ thread_id: 'p1', project_path: 'D:/Project2' }), { items: [] });

  const observation = { operation_id: 'observation', text: '我在答复里拆开了核对和归档步骤', kind: 'self_observation',
    scope: 'shared' };
  assert.throws(() => memory.remember({ ...observation, source_message_ids: ['u1'] }), /助手发言/);
  const first = memory.remember({ ...observation, source_message_ids: ['a1'] });
  const next = memory.remember({ ...observation, operation_id: 'observation-updated', supersedes: first.id,
    text: '我先建议核对目录，再建议建立索引', source_message_ids: ['a1'] });
  const startup = memory.bootstrapContext();
  assert.ok(startup.notes.every((note) => note.kind !== 'self_observation'));
  assert.deepEqual(startup.self_observations.map((note) => note.id), [next.id]);
  assert.ok(memory.notes(undefined, true).some((note) => note.id === first.id && note.status === 'superseded'));
});

test('项目产物可保留多版，恢复校验、不覆盖，并随备份带回', (t) => {
  const { memory, root, config, add } = fixture(t);
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  memory.db.prepare('INSERT INTO threads VALUES (?,?,?)').run('artifact-thread', '2026-11-24T01:00:00Z', project);
  add('artifact-source', '用户要求归档这个项目交付物', 'user', 'artifact-thread');
  const report = path.join(project, 'report.bin');
  const firstBytes = Buffer.from([0, 164, 0, 255]);
  const params = { project_path: project, file_path: report, description: '记忆项目交付物', source_message_ids: ['artifact-source'] };
  fs.writeFileSync(report, firstBytes);
  const first = memory.artifacts.save(params);
  assert.equal(memory.artifacts.save(params).id, first.id);
  const escaped = path.join(other, 'outside.bin');
  fs.writeFileSync(escaped, 'outside');
  assert.throws(() => memory.artifacts.save({ ...params, file_path: escaped }), /当前项目目录/);
  const link = path.join(project, 'outside');
  fs.symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => memory.artifacts.save({ ...params, file_path: path.join(link, 'outside.bin') }), /当前项目目录/);
  assert.throws(() => memory.artifacts.save({ ...params, source_message_ids: ['u1'] }), /原文依据/);
  fs.writeFileSync(report, 'second version');
  const latest = memory.artifacts.save(params);
  assert.notEqual(first.id, latest.id);
  assert.deepEqual(memory.artifacts.list({ project_path: project, query: '交付' }).map((item) => item.id), [latest.id, first.id]);
  assert.deepEqual(memory.artifacts.list({ project_path: other }), []);
  assert.throws(() => memory.artifacts.restore({ project_path: other, artifact_id: first.id, destination: escaped }), /项目不符/);
  assert.throws(() => memory.artifacts.restore({ project_path: project, artifact_id: first.id, destination: report }),
    { code: 'EEXIST' });
  assert.equal(fs.readFileSync(report, 'utf8'), 'second version');

  const snapshot = externalBackup(memory.db, { ...config, backup: { directory: path.join(root, 'artifact-backup') } });
  const recovery = path.join(root, 'recovery');
  restoreExternalSnapshot(snapshot.directory, recovery);
  const restored = new ConversationMemory(recovery, config);
  try {
    const destination = path.join(project, 'restored.bin');
    restored.artifacts.restore({ project_path: project, artifact_id: first.id, destination });
    assert.deepEqual(fs.readFileSync(destination), firstBytes);
    const migrated = path.join(recovery, 'migrated.bin');
    restored.artifacts.restore({ project_path: project, artifact_id: first.id, destination: migrated }, recovery);
    assert.deepEqual(fs.readFileSync(migrated), firstBytes);
    restored.db.prepare('UPDATE memory_artifacts SET content=? WHERE id=?').run(Buffer.from([1, 2, 3, 4]), first.id);
    const bad = path.join(project, 'bad.bin');
    assert.throws(() => restored.artifacts.restore({ project_path: project, artifact_id: first.id, destination: bad }),
      /完整性校验失败/);
    assert.equal(fs.existsSync(bad), false);
  } finally { restored.close(); }
});

test('异盘快照恢复原文、记忆和复习状态，损坏快照无法恢复', (t) => {
  const { memory, root, config } = fixture(t);
  const table = { ...config, sourceDirectories: ['live-source'], captureNewChats: true,
    backup: { directory: path.join(root, 'backup') }, unknownSecret: 'excluded' };
  const writer = new ConversationMemory(root, config);
  const operation = { operation_id: 'backup-core', text: '重要的原话', kind: 'shared_event', scope: 'shared',
    source_message_ids: ['u1'], core: true };
  try {
    const added = writer.remember(operation);
    writer.review({ note_id: added.id });
  } finally { writer.close(); }
  const now = new Date('2026-11-24T06:00:00.000Z');
  const first = externalBackup(memory.db, table, { now });
  assert.equal(externalBackup(memory.db, table, { now: new Date(+now + 30000) }).directory, first.directory);
  assert.equal(verifyExternalSnapshot(first.directory).totals.notes, 1);
  const destination = path.join(root, 'restored');
  restoreExternalSnapshot(first.directory, destination);
  assert.throws(() => restoreExternalSnapshot(first.directory, destination), /尚未创建/);
  const restoredConfig = JSON.parse(fs.readFileSync(path.join(destination, 'config.json'), 'utf8'));
  assert.deepEqual(restoredConfig.sourceDirectories, []);
  assert.equal(restoredConfig.captureNewChats, false);
  assert.equal(restoredConfig.backup, undefined);
  assert.equal(restoredConfig.unknownSecret, undefined);
  const restored = new ConversationMemory(destination, restoredConfig);
  try {
    assert.equal(restored.context({ message_id: 'u1', before: 0, after: 0 }).messages[0].text,
      memory.context({ message_id: 'u1', before: 0, after: 0 }).messages[0].text);
    assert.equal(restored.notes()[0].memory.core, true);
    assert.equal(restored.notes()[0].memory.reps, 1);
  } finally { restored.close(); }
  const later = externalBackup(memory.db, table, { now: new Date(+now + 6 * 3600000) });
  assert.notEqual(later.directory, first.directory);
  fs.appendFileSync(path.join(later.directory, 'conversations.sqlite3'), 'damaged');
  const rejected = path.join(root, 'rejected');
  assert.throws(() => restoreExternalSnapshot(later.directory, rejected), /校验失败/);
  assert.equal(fs.existsSync(rejected), false);
});

test('项目隔离、共享范围、日期与说话者筛选', (t) => {
  const { memory } = fixture(t);
  assert.equal(memory.search({ query: '账户设计' }).results.length, 0);
  const results = memory.search({ query: '账户设计', project_path: 'd:\\PROJECT1\\' }).results;
  assert.deepEqual(results.map((row) => row.message_id), ['p1msg']);
  assert.equal(memory.search({ query: '图书', from: '2027-01-01' }).results.length, 0);
  assert.equal(memory.search({ query: '2027', speaker: 'user' }).results.length, 0);
  assert.throws(() => memory.context({ message_id: 'p2msg', project_path: 'D:/Project1' }), /可读范围/);
});

test('前后文顺序正确，长消息明确标注截断', (t) => {
  const { memory, add } = fixture(t);
  const rows = memory.context({ message_id: 'a1', before: 1, after: 1 }).messages;
  assert.deepEqual(rows.map((row) => row.id), ['u1', 'a1', 'u2']);
  add('long', '很长的消息'.repeat(2000));
  const long = memory.context({ message_id: 'long', before: 0, after: 0, max_chars: 1000 }).messages[0];
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 1000);
});

test('写入有证据、重试幂等、修订留历史、归档退出启动列表', (t) => {
  const { memory } = fixture(t);
  const note = { operation_id: 'pref-1', text: '偏好简短的三条清单', kind: 'preference', scope: 'shared', source_message_ids: ['u2'] };
  const first = memory.remember(note);
  assert.equal(memory.remember(note).id, first.id);
  assert.equal(memory.remember(note).replayed, true);
  assert.throws(() => memory.remember({ ...note, text: 'different' }), /不同内容/);
  const second = memory.remember({ ...note, operation_id: 'pref-2', text: '用户偏好以三条清单汇报进度', supersedes: first.id });
  assert.equal(memory.notes().length, 1);
  assert.equal(memory.notes(undefined, true).find((n) => n.id === first.id).status, 'superseded');
  assert.deepEqual(memory.notes()[0].source_message_ids, ['u2']);
  memory.archiveNote({ note_id: second.id });
  assert.equal(memory.notes().length, 0);
});

test('错误证据、范围及过期修订被拒绝，事务无部分写入', (t) => {
  const { memory } = fixture(t);
  const note = { operation_id: 'x', text: '偏好', kind: 'preference', scope: 'shared', source_message_ids: ['a2'] };
  assert.throws(() => memory.remember(note), /用户发言/);
  assert.throws(() => memory.remember({ ...note, source_message_ids: ['missing'] }), /来源/);
  assert.throws(() => memory.remember({ ...note, source_message_ids: ['p1msg'] }), /范围/);
  assert.equal(memory.notes(undefined, true).length, 0);
  const first = memory.remember({ ...note, source_message_ids: ['u2'] });
  const revision = { ...note, operation_id: 'r', source_message_ids: ['u2'], supersedes: first.id };
  memory.remember(revision);
  assert.throws(() => memory.remember({ ...revision, operation_id: 'late' }), /不可用/);
  assert.equal(memory.notes().length, 1);
});

test('重开后记忆与索引可读，采集器连接新增消息同步进入索引', (t) => {
  const { memory, root, config } = fixture(t);
  memory.remember({ operation_id: 'save', text: '关于图书归档的讨论', kind: 'shared_event', scope: 'shared', source_message_ids: ['u1'] });
  const another = new ConversationMemory(root, config);
  try {
    assert.equal(another.notes().length, 1);
    memory.insertMessage.run('later', 'shared', 'later', '2026-11-24T02:00:00Z', 'user', '星河回忆录', '[]', 'later', 'fixture', 999);
    assert.equal(another.search({ query: '星河回忆录' }).results[0].message_id, 'later');
  } finally { another.close(); }
});

test('遗忘曲线影响启动摘要，显式检索仍能找到原话，复习后恢复', (t) => {
  let clock = Date.parse('2026-11-24T00:00:00Z');
  const { memory } = fixture(t, { now: () => clock });
  const note = memory.remember({ operation_id: 'aged', text: '图书归档的旧讨论', kind: 'shared_event', scope: 'shared', source_message_ids: ['u1'] });
  assert.equal(memory.bootstrap().length, 1);
  clock += 365 * 86400000;
  assert.equal(memory.notes()[0].memory.frozen, true);
  assert.equal(memory.bootstrap().length, 0);
  assert.ok(memory.search({ query: '图书归档' }).results.some((r) => r.message_id === 'u1'));
  const recalled = memory.review({ note_id: note.id, rating: 'hard' });
  assert.equal(recalled.state.R, 1);
  assert.ok(recalled.state.S > 14);
  assert.equal(memory.bootstrap()[0].id, note.id);
});

test('核心记忆和未完话题豁免淡出，修订继承核心标记', (t) => {
  let clock = Date.parse('2026-11-24T00:00:00Z');
  const { memory } = fixture(t, { now: () => clock });
  const args = { text: '喜欢清单格式的进度汇报', kind: 'preference', scope: 'shared', source_message_ids: ['u2'] };
  const core = memory.remember({ ...args, operation_id: 'core', core: true });
  const open = memory.remember({ operation_id: 'open', text: '图书归档的目录还要核对', kind: 'open_question', scope: 'shared', source_message_ids: ['u1'] });
  clock += 2000 * 86400000;
  assert.ok(memory.bootstrap().some((n) => n.id === core.id));
  assert.ok(memory.bootstrap().some((n) => n.id === open.id));
  const revised = memory.remember({ ...args, operation_id: 'revised-core', text: '优先使用三条进度清单', supersedes: core.id });
  assert.equal(memory.notes().find((n) => n.id === revised.id).memory.core, true);
  assert.throws(() => memory.review({ note_id: core.id }), /有效/);
});

test('复习记录跨连接持久化，冷却阻止重试和不同进程重复增强', (t) => {
  let clock = Date.parse('2026-11-24T00:00:00Z');
  const { memory, root, config } = fixture(t, { now: () => clock });
  const saved = memory.remember({ operation_id: 'review', text: '图书归档', kind: 'shared_event', scope: 'shared', source_message_ids: ['u1'] });
  const other = new ConversationMemory(root, config, { now: () => clock });
  try {
    assert.equal(memory.review({ note_id: saved.id }).applied, true);
    assert.equal(other.review({ note_id: saved.id }).applied, false);
    assert.equal(other.notes()[0].memory.reps, 1);
    clock += 3600001;
    assert.equal(other.review({ note_id: saved.id }).applied, true);
    assert.equal(memory.notes()[0].memory.reps, 2);
  } finally { other.close(); }
});

test('旧版写入重试保持兼容，核心设置按项目检查', (t) => {
  const { memory } = fixture(t);
  const args = { operation_id: 'legacy', text: '旧版记忆', kind: 'shared_event', scope: 'shared', source_message_ids: ['u1'] };
  const saved = memory.remember(args);
  const payload = JSON.parse(memory.db.prepare('SELECT payload FROM memory_notes WHERE id=?').get(saved.id).payload);
  delete payload.core;
  memory.db.prepare('UPDATE memory_notes SET payload=? WHERE id=?').run(JSON.stringify(payload), saved.id);
  assert.equal(memory.remember(args).id, saved.id);
  const privateNote = memory.remember({ ...args, operation_id: 'project-note', scope: 'project', project_path: 'D:/Project2', source_message_ids: ['p2msg'] });
  assert.throws(() => memory.setCore({ note_id: privateNote.id, project_path: 'D:/Project1', core: true }), /项目/);
});

test('实际调用原项目关联函数，带出新概念、去重并隔离项目', async (t) => {
  const { memory } = fixture(t);
  const save = (operation_id, text) => memory.remember({ operation_id, text, kind: 'shared_event', scope: 'shared', source_message_ids: ['u1'] });
  const seed = save('seed', '图书归档前需要核对旧目录');
  const linked = save('linked', '图书归档时发现了一批破损纸本');
  const unrelated = save('unrelated', '海边徒步需要防晒和饮水');
  const duplicate = save('duplicate', '图书归档前需要核对旧目录');
  const hidden = memory.remember({ operation_id: 'hidden', text: '图书归档与秘密项目', kind: 'decision', scope: 'project', project_path: 'D:/Project2', source_message_ids: ['p2msg'] });
  const result = await memory.associate({ note_id: seed.id });
  assert.equal(result.engine, 'upstream memory_rag.recall.associate');
  assert.ok(result.items.some((item) => item.note.id === linked.id && item.via.length > 0));
  assert.ok(result.items.every((item) => ![seed.id, duplicate.id, unrelated.id, hidden.id].includes(item.note.id)));
  assert.deepEqual((await memory.associate({ note_id: seed.id, min_age_days: 2 })).items, []);
});

test('真实 MCP stdio 握手、工具发现、搜索、上下文、写入和校验', async (t) => {
  const { root } = fixture(t);
  await runPython('topics.py', ['refresh', root], {});
  const client = new Client({ name: 'memory-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url)), root], stderr: 'pipe' });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 15);
    assert.ok(listed.tools.some((tool) => tool.name === 'memory_topics'));
    assert.ok(listed.tools.some((tool) => tool.name === 'memory_resume'));
    assert.ok(listed.tools.some((tool) => tool.name === 'memory_artifact_restore'));
    const search = await client.callTool({ name: 'memory_search', arguments: { query: '图书归档' } });
    const data = JSON.parse(search.content[0].text);
    assert.equal(data.association_error, undefined);
    assert.equal(data.results[0].message_id, 'u1');
    assert.ok(data.related_topics.some((item) => item.source_message_ids.includes('u1')));
    const filtered = await client.callTool({ name: 'memory_search', arguments: { query: '图书归档', speaker: 'user' } });
    assert.equal(JSON.parse(filtered.content[0].text).related_topics, undefined);
    const topics = await client.callTool({ name: 'memory_topics', arguments: { query: '图书归档', thread_id: 'shared' } });
    assert.ok(JSON.parse(topics.content[0].text).items.some((item) => item.source_message_ids.includes('u1')));
    const context = await client.callTool({ name: 'memory_context', arguments: { message_id: 'u1' } });
    assert.ok(JSON.parse(context.content[0].text).messages[0].text.includes('图书归档'));
    const saved = await client.callTool({ name: 'memory_remember', arguments: { operation_id: 'mcp-save', text: '喜欢三条进度清单', kind: 'preference', scope: 'shared', source_message_ids: ['u2'] } });
    assert.ok(!saved.isError);
    const bootstrap = await client.callTool({ name: 'memory_bootstrap', arguments: {} });
    assert.equal(JSON.parse(bootstrap.content[0].text).notes.length, 1);
    const noteId = JSON.parse(saved.content[0].text).id;
    const pinned = await client.callTool({ name: 'memory_set_core', arguments: { note_id: noteId, core: true } });
    assert.equal(JSON.parse(pinned.content[0].text).memory.core, true);
    const review = await client.callTool({ name: 'memory_review', arguments: { note_id: noteId } });
    assert.equal(JSON.parse(review.content[0].text).applied, true);
    const invalid = await client.callTool({ name: 'memory_search', arguments: { query: '主题', limit: 2000 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});
