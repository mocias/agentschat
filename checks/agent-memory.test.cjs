'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AgentMemoryStore } = require('../lib/agent-memory.cjs');
const { AgentRoom } = require('../lib/room.cjs');
const { createApplication } = require('../standalone/server.cjs');
const { claudeCodeLaunch } = require('../lib/harnesses.cjs');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
const row = (id, agentIds, kind = 'group') => ({ id, title: id, kind, agentIds });
const message = (id, text, extra = {}) => ({ id, text, authorId: 'user', authorLabel: '用户', kind: 'user',
  ts: new Date().toISOString(), visibility: 'public', recipientIds: [], ...extra });

test('history replay batches durable writes and retains privacy, deduplication and live durability', t => {
  const dir = root(), rooms = path.join(dir, 'rooms'); fs.mkdirSync(rooms);
  const room = row('batch', ['a', 'b']);
  const catalog = { agents: [{ id: 'a' }, { id: 'b' }], conversations: [room] };
  const entries = Array.from({ length: 600 }, (_, i) => message('m' + i, 'PUBLIC_' + i));
  entries.push(entries[0], message('private', 'ONLY_A', { visibility: 'private', recipientIds: ['a'] }), message('stream', 'PARTIAL', { partial: true }));
  fs.writeFileSync(path.join(rooms, 'batch.log.jsonl'), entries.map(JSON.stringify).join('\n') + '\n{torn');
  const sync = fs.fsyncSync, writes = t.mock.method(fs, 'fsyncSync', (...args) => sync(...args));
  let store = new AgentMemoryStore(path.join(dir, 'memory')); store.importHistory(catalog, rooms);
  assert.equal(store.stats('a').count, 601); assert.equal(store.stats('b').count, 600);
  assert.ok(writes.mock.callCount() <= 6);
  assert.doesNotMatch(store.context('b', { query: 'ONLY_A' }), /ONLY_A/);
  const before = writes.mock.callCount();
  store = new AgentMemoryStore(path.join(dir, 'memory')); store.importHistory(catalog, rooms);
  assert.equal(writes.mock.callCount(), before);
  store.capture(row('live', ['a']), message('live', 'LIVE_DURABLE'));
  assert.equal(writes.mock.callCount(), before + 1);
  assert.equal(new AgentMemoryStore(path.join(dir, 'memory')).stats('a').count, 602);
});

test('failed history flush is replayable and does not publish unsynced entries', t => {
  const dir = root(), rooms = path.join(dir, 'rooms'); fs.mkdirSync(rooms);
  const catalog = { agents: [{ id: 'a' }], conversations: [row('replay', ['a'])] };
  fs.writeFileSync(path.join(rooms, 'replay.log.jsonl'), JSON.stringify(message('one', 'RECOVERABLE')) + '\n');
  const store = new AgentMemoryStore(path.join(dir, 'memory'));
  const sync = t.mock.method(fs, 'fsyncSync', () => { throw new Error('fixture sync failure'); });
  assert.throws(() => store.importHistory(catalog, rooms), /fixture sync failure/);
  assert.equal(store.stats('a').count, 0);
  sync.mock.restore(); store.importHistory(catalog, rooms);
  assert.equal(store.stats('a').count, 1);
  assert.equal(new AgentMemoryStore(path.join(dir, 'memory')).stats('a').count, 1);
});

test('memory belongs to an Agent across direct/group rooms, never to the harness', () => {
  const dir = root(), store = new AgentMemoryStore(dir);
  store.capture(row('direct-a', ['a'], 'direct'), message('m1', '项目暗号 AURORA_7281'));
  store.capture(row('group-one', ['a', 'b']), message('m1', '上线时间星期五'));
  store.capture(row('group-other', ['b', 'c']), message('m1', '其他项目 HIDDEN_FROM_A'));
  assert.match(store.context('a', { excludeRoomId: 'group-two', query: '项目暗号' }), /AURORA_7281/);
  assert.match(store.context('a', { excludeRoomId: 'direct-a', query: '上线时间' }), /星期五/);
  assert.doesNotMatch(store.context('b'), /AURORA_7281/);
  assert.doesNotMatch(store.context('a'), /HIDDEN_FROM_A/);
  assert.equal(store.stats('a').count, 2);
  assert.equal(store.stats('b').count, 2);
  // Names and workspace paths are not storage keys; a new process sees the same identity.
  assert.equal(new AgentMemoryStore(dir).stats('a').count, 2);
  assert.equal(new AgentMemoryStore(dir).stats('renamed-new-id').count, 0);
});

test('private records preserve recipients and are not recalled to a wider audience; tools are not memory', () => {
  const store = new AgentMemoryStore(root()), room = row('group-one', ['a', 'b', 'c']);
  store.capture(room, message('m1', 'PRIVATE_FOR_A_USER', { visibility: 'private', recipientIds: ['a'] }));
  store.capture(room, message('m2', 'PRIVATE_A_B', { authorId: 'a', visibility: 'private', recipientIds: ['b'] }));
  store.capture(room, message('m3', 'RAW_ANONYMOUS_BALLOT', { kind: 'system' }));
  assert.equal(store.stats('c').count, 0);
  assert.match(store.context('a', { audienceIds: ['a', 'user'] }), /PRIVATE_FOR_A_USER/);
  assert.doesNotMatch(store.context('a', { audienceIds: ['a', 'b', 'user'] }), /PRIVATE_FOR_A_USER/);
  assert.match(store.context('a', { audienceIds: ['a', 'b', 'user'] }), /PRIVATE_A_B/);
  assert.doesNotMatch(store.context('a', { audienceIds: ['a', 'b', 'c', 'user'] }), /PRIVATE_A_B/);
  assert.doesNotMatch(store.context('a'), /RAW_ANONYMOUS_BALLOT/);
});

test('history backfill is idempotent, respects saved membership, and never rewrites old logs', () => {
  const dir = root(), roomsDir = path.join(dir, 'rooms'); fs.mkdirSync(roomsDir);
  const room = row('old-group', ['a', 'b']);
  const log = [message('m1', 'OLD_FACT'), message('m2', 'BEFORE_B_JOINED', { memoryAgentIds: ['a'] }),
    message('m3', 'ONLY_B', { visibility: 'private', recipientIds: ['b'] })].map(value => JSON.stringify(value)).join('\n') + '\n{"torn';
  const file = path.join(roomsDir, room.id + '.log.jsonl'); fs.writeFileSync(file, log);
  const catalog = { agents: [{ id: 'a' }, { id: 'b' }], conversations: [room] };
  const memoryDir = path.join(dir, 'memory'), store = new AgentMemoryStore(memoryDir);
  store.importHistory(catalog, roomsDir); store.importHistory(catalog, roomsDir);
  const restarted = new AgentMemoryStore(memoryDir); restarted.importHistory(catalog, roomsDir);
  assert.equal(restarted.stats('a').count, 2); assert.equal(restarted.stats('b').count, 2);
  assert.doesNotMatch(restarted.context('b'), /BEFORE_B_JOINED/);
  assert.doesNotMatch(restarted.context('a'), /ONLY_B/);
  assert.equal(fs.readFileSync(file, 'utf8'), log);
});

test('concurrent rooms append without lost updates, survive torn tails and keep Agent paths independent', async () => {
  const dir = root(), store = new AgentMemoryStore(dir);
  await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() =>
    store.capture(row('r' + i, ['../../a', 'b']), message('m1', 'FACT_' + i)))));
  const file = path.join(dir, createHash('sha256').update('../../a').digest('hex'), 'messages.jsonl');
  fs.appendFileSync(file, '{"partial');
  const restored = new AgentMemoryStore(dir);
  assert.equal(restored.stats('../../a').count, 40);
  restored.capture(row('last', ['../../a']), message('m1', 'AFTER_TORN_TAIL'));
  assert.equal(new AgentMemoryStore(dir).stats('../../a').count, 41);
  assert.equal(new AgentMemoryStore(dir).stats('b').count, 40);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('local retrieval finds older Chinese facts and bounds CLI context without a model call', () => {
  const store = new AgentMemoryStore(root());
  store.capture(row('old', ['a']), message('m1', '很长的说明'.repeat(600) + '部署暗号 BLUE_MOON。'));
  for (let i = 0; i < 30; i++) store.capture(row('recent-' + i, ['a']), message('m1', '今天闲聊 ' + i));
  const context = store.context('a', { query: '部署暗号是什么' });
  assert.match(context, /BLUE_MOON/); assert.ok(context.length <= 12000);
  assert.equal(store.search('a', { query: '部署暗号' })[0].roomId, 'old');
});

async function boot(t, dataDir, useCli = false, captured = []) {
  const fixture = path.join(__dirname, 'fixtures/claude-stream-fixture.cjs');
  const roomFactory = settings => {
    const room = new AgentRoom({ ...settings, segmentMs: 0, queueStallMs: 0, maxRelayHops: 0,
      ...(useCli ? { backends: { claude: claudeCodeLaunch(fixture) } } : {}) });
    if (!useCli) {
      const threads = new Map();
      room.pool = { running: false, pid: null, supportsInject: false,
        async start() { this.running = true; }, async stop() {}, async modelCapabilities() { return new Map(); },
        getThread(id) { return threads.get(id); }, closeThread(id) { threads.delete(id); },
        async openThread(id, options) { const value = { ...options, id: settings.id + ':' + id }; threads.set(id, value); return value; },
        async runTurn(id, input) { captured.push({ id, room: settings.id, input }); return { text: '已收到', usage: {} }; },
        async interrupt() { return true; } };
    }
    return room;
  };
  const app = createApplication({ dataDir, workspaceRoot: path.join(dataDir, 'agents'), roomFactory,
    queryModels: async () => ({ models: [{ id: 'sonnet-test', name: 'Fixture' }] }),
    registerAgent: async () => ({ status: 'cli-only' }), discoveryInventory: async () => ({ rows: [] }), nativeRegistration: false });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const call = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + route,
      body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const send = async (room, text) => {
    assert.equal((await call('/say', { room, text })).status, 202);
    for (let i = 0; i < 150; i++) {
      const snapshot = (await call('/conversation?id=' + room)).data;
      if (!snapshot.pending && !snapshot.snapshot.busy.length) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Fixture turn timed out');
  };
  return { app, call, send };
}

test('HTTP memory shares across warm rooms, survives rename/workspace change/restart and keeps original data', async t => {
  const dataDir = root(), captured = [];
  let env = await boot(t, dataDir, false, captured);
  const one = (await env.call('/agents', { label: 'Alpha', backend: 'claude' })).data;
  const two = (await env.call('/agents', { label: 'Beta', backend: 'claude' })).data;
  const group = (await env.call('/groups', { agentIds: [one.agent.id, two.agent.id] })).data.conversation;
  await env.send(group.id, '@Alpha 先打招呼'); // Warm before new direct-chat memory exists.
  fs.writeFileSync(path.join(one.agent.workspace, 'keep.txt'), 'ORIGINAL_WORKSPACE');
  await env.send(one.conversation.id, '项目暗号是 AURORA_7281');
  await env.send(group.id, '@Alpha 项目暗号是什么？');
  assert.match(captured.filter(item => item.id === one.agent.id && item.room === group.id).at(-1).input.text, /AURORA_7281/);
  await env.send(two.conversation.id, '项目暗号是什么？');
  assert.doesNotMatch(captured.at(-1).input.text, /AURORA_7281/);
  const memoryBefore = (await env.call('/agents/memory?id=' + one.agent.id)).data.count;
  assert.equal((await env.call('/conversation/rename', { id: one.conversation.id, name: 'Alpha改名' })).status, 200);
  const nextWorkspace = path.join(dataDir, 'new-independent'); fs.mkdirSync(nextWorkspace);
  assert.equal((await env.call('/agents/settings', { id: one.agent.id, room: one.conversation.id, workspace: nextWorkspace })).status, 200);
  const file = path.join(dataDir, 'rooms', one.conversation.id + '.log.jsonl'), oldLog = fs.readFileSync(file, 'utf8');
  await env.app.close();
  env = await boot(t, dataDir, false, captured);
  assert.equal((await env.call('/agents/memory?id=' + one.agent.id)).data.count, memoryBefore);
  assert.equal(fs.readFileSync(file, 'utf8'), oldLog);
  assert.equal(fs.readFileSync(path.join(one.agent.workspace, 'keep.txt'), 'utf8'), 'ORIGINAL_WORKSPACE');
  await env.send(group.id, '@Alpha改名 项目暗号是什么？');
  assert.match(captured.filter(item => item.id === one.agent.id && item.room === group.id).at(-1).input.text, /AURORA_7281/);
  const catalog = (await env.call('/catalog')).data;
  const directSession = catalog.conversations.find(item => item.id === one.conversation.id).nativeSessions?.[one.agent.id];
  const groupSession = catalog.conversations.find(item => item.id === group.id).nativeSessions[one.agent.id];
  assert.ok(groupSession.id); assert.notEqual(directSession?.id, groupSession.id);
  assert.equal((await env.call('/agents/memory?id=unknown')).status, 404);
  await env.call('/groups/delete', { id: group.id });
  assert.match(JSON.stringify((await env.call('/agents/memory?id=' + one.agent.id)).data), /AURORA_7281/);
});

test('Claude CLI fixture receives cross-room memory with separate native sessions and working directories', async t => {
  const env = await boot(t, root(), true);
  const one = (await env.call('/agents', { label: 'CC甲', backend: 'claude', model: 'sonnet-test' })).data;
  const two = (await env.call('/agents', { label: 'CC乙', backend: 'claude', model: 'sonnet-test' })).data;
  const group = (await env.call('/groups', { agentIds: [one.agent.id, two.agent.id] })).data.conversation;
  await env.send(one.conversation.id, '项目暗号是 CLI_CROSS_ROOM_921');
  const a = await env.send(group.id, '@CC甲 MEMORY_INSPECT 项目暗号是什么？');
  const reply = JSON.parse(a.snapshot.log.filter(record => record.authorId === one.agent.id).at(-1).text);
  assert.match(reply.memoryContext, /CLI_CROSS_ROOM_921/);
  assert.equal(reply.cwd, one.agent.workspace);
  const b = await env.send(two.conversation.id, 'MEMORY_INSPECT 项目暗号是什么？');
  const other = JSON.parse(b.snapshot.log.filter(record => record.authorId === two.agent.id).at(-1).text);
  // CC乙 saw the public group reply, so use a fresh private fact it never received.
  await env.send(one.conversation.id, '个人暗号是 PRIVATE_AGENT_ONLY_842');
  const bAgain = await env.send(two.conversation.id, 'MEMORY_INSPECT 个人暗号是什么？');
  assert.doesNotMatch(JSON.parse(bAgain.snapshot.log.filter(record => record.authorId === two.agent.id).at(-1).text).memoryContext, /PRIVATE_AGENT_ONLY_842/);
  assert.notEqual(reply.sessionId, other.sessionId); assert.notEqual(reply.cwd, other.cwd);
  const catalog = (await env.call('/catalog')).data;
  assert.notEqual(catalog.conversations.find(item => item.id === one.conversation.id).nativeSessions[one.agent.id].id, reply.sessionId);
});

test('HTTP prevents new shared workspaces and blocks legacy collisions without moving any files or logs', async t => {
  const dataDir = root(), captured = [];
  let env = await boot(t, dataDir, false, captured);
  const one = (await env.call('/agents', { label: 'One', backend: 'claude' })).data;
  const two = (await env.call('/agents', { label: 'Two', backend: 'claude' })).data;
  fs.writeFileSync(path.join(one.agent.workspace, 'preserved.txt'), 'KEEP_ALL_FILES');
  await env.send(one.conversation.id, '旧聊天 LEGACY_CHAT_115');
  const logFile = path.join(dataDir, 'rooms', one.conversation.id + '.log.jsonl');
  const oldLog = fs.readFileSync(logFile, 'utf8');
  assert.equal((await env.call('/agents', { label: 'Three', backend: 'dsh', workspace: one.agent.workspace })).status, 400);
  assert.equal((await env.call('/agents/settings', { id: two.agent.id, room: two.conversation.id, workspace: one.agent.workspace })).status, 400);
  await env.app.close();
  const catalogFile = path.join(dataDir, 'catalog.json'), catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  catalog.agents.find(agent => agent.id === two.agent.id).workspace = one.agent.workspace;
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const oldCatalog = fs.readFileSync(catalogFile, 'utf8');
  env = await boot(t, dataDir, false, captured);
  const status = (await env.call('/catalog')).data;
  assert.ok(status.agents.every(agent => agent.workspaceIssue?.includes('其他 Agent')));
  const before = captured.length;
  const rejected = await env.call('/say', { room: one.conversation.id, text: '不能调用后端' });
  assert.equal(rejected.status, 400); assert.match(rejected.data.error, /其他 Agent/);
  assert.equal(captured.length, before);
  assert.equal(fs.readFileSync(logFile, 'utf8'), oldLog);
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), oldCatalog);
  assert.equal(fs.readFileSync(path.join(one.agent.workspace, 'preserved.txt'), 'utf8'), 'KEEP_ALL_FILES');
  // Resolving one assignment uses an existing independent folder; neither old
  // folder is moved or erased, and memory continues to use the original IDs.
  assert.equal((await env.call('/agents/settings', { id: two.agent.id, room: two.conversation.id, workspace: two.agent.workspace })).status, 200);
  await env.send(one.conversation.id, '现在继续');
  assert.match(JSON.stringify((await env.call('/agents/memory?id=' + one.agent.id)).data), /LEGACY_CHAT_115/);
});

test('a memory write failure preserves chat and prevents generation until persistence recovers', async t => {
  const dataDir = root(), captured = [], env = await boot(t, dataDir, false, captured);
  const one = (await env.call('/agents', { label: '保存检查', backend: 'claude' })).data;
  const blocked = path.join(dataDir, 'memory'); fs.writeFileSync(blocked, 'not a directory');
  const failed = await env.send(one.conversation.id, 'KEEP_FAILED_MEMORY_MESSAGE');
  assert.equal(captured.length, 0);
  assert.ok(failed.snapshot.members[0].error);
  const history = fs.readFileSync(path.join(dataDir, 'rooms', one.conversation.id + '.log.jsonl'), 'utf8');
  assert.match(history, /KEEP_FAILED_MEMORY_MESSAGE/);
  fs.unlinkSync(blocked);
  await env.send(one.conversation.id, '保存恢复后继续');
  assert.equal(captured.length, 1);
  assert.match(JSON.stringify((await env.call('/agents/memory?id=' + one.agent.id)).data), /KEEP_FAILED_MEMORY_MESSAGE/);
});
