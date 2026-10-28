'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeModePool } = require('../standalone/native-mode-pool.cjs');
const { ZcodePool } = require('../lib/zcode-pool.cjs');
const { defaultSessionConfig } = require('../standalone/session-controls.cjs');
const { createApplication } = require('../standalone/server.cjs');
const { BackendDiscovery, adapt } = require('../standalone/discovery.cjs');
const { AgentRoom } = require('../lib/room.cjs');

test('Qoder verifies native mode echo, keeps the fixed model, and closes a failed session', async () => {
  const pool = new NativeModePool({}); pool.start = async () => {};
  let mismatch = false; const calls = [];
  pool.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'session/new') return { sessionId: 'native', configOptions: [{ id: 'model', category: 'model', currentValue: 'model', options: [{ value: 'model', name: 'model' }] }] };
    if (params?.configId === 'mode') return { configOptions: [{ id: 'mode', category: 'mode', currentValue: mismatch ? 'yolo' : params.value }] };
    return { configOptions: [{ id: 'model', category: 'model', currentValue: 'model' }] };
  };
  const sessionConfig = { permission: 'default', preset: 'native' };
  const thread = await pool.openThread('a', { model: 'model', strictModel: true, sessionConfig });
  assert.deepEqual(thread.appliedSessionConfig, sessionConfig); assert.ok(thread.appliedModel);
  mismatch = true;
  await assert.rejects(pool.openThread('b', { model: 'model', strictModel: true, sessionConfig }), /没有应用/);
  assert.equal(pool.getThread('b'), undefined);
  assert.equal(calls.some(c => c.params?.value === 'yolo'), false);
});

test('ZCode translates stream, completion, failure and cancellation without mixing sessions', async () => {
  const pool = new ZcodePool(); const frames = [];
  pool.nativeSessions.set('a', { settings: {} }); pool.nativeSessions.set('b', { settings: {} });
  pool.nativeRequest = async (method, params) => { frames.push({ method, params }); return {}; };
  const deltas = []; pool.onNotification((m, p) => { if (m === 'session/update') deltas.push(p.update.content.text); });
  const first = pool.prompt({ sessionId: 'a', prompt: [{ text: 'first' }] });
  const second = pool.prompt({ sessionId: 'b', prompt: [{ text: 'second' }] });
  await new Promise(r => setImmediate(r));
  pool._dispatch({ method: 'session/event', params: { sessionId: 'unknown', type: 'model.streaming', payload: { kind: 'text_delta', delta: 'leak' } } });
  pool._dispatch({ method: 'session/event', params: { sessionId: 'a', queryId: 'old', type: 'turn.completed' } });
  assert.equal(pool.nativeTurns.size, 2);
  pool._dispatch({ method: 'session/event', params: { sessionId: 'a', type: 'model.streaming', payload: { kind: 'text_delta', delta: 'hello' } } });
  pool._dispatch({ method: 'session/event', params: { sessionId: 'a', type: 'turn.completed' } });
  assert.equal((await first).stopReason, 'end_turn'); assert.deepEqual(deltas, ['hello']);
  pool.notify('session/cancel', { sessionId: 'b' }); assert.equal((await second).stopReason, 'cancelled');
  const failed = pool.prompt({ sessionId: 'a', prompt: [] }); await new Promise(r => setImmediate(r));
  pool._dispatch({ method: 'session/event', params: { sessionId: 'a', turnId: 'old-turn', type: 'turn.completed', payload: {} } });
  assert.equal(pool.nativeTurns.size, 1, 'late completion from a cancelled turn cannot finish the next prompt');
  pool._dispatch({ method: 'session/event', params: { sessionId: 'a', type: 'turn.failed', payload: { message: 'fixture failure' } } });
  await assert.rejects(failed, /fixture failure/);
  assert.equal(pool.nativeTurns.size, 0);
  assert.ok(frames.some(f => f.method === 'session/stop' && f.params.sessionId === 'b'));
});

test('ZCode handles only supported reverse requests and requires one-time, bound permission', async () => {
  let response, calls = 0;
  const pool = new ZcodePool({ onPermissionRequest: async () => { calls++; return { outcome: { optionId: 'once' } }; } });
  pool.write = f => { response = f; }; pool.nativeSessions.set('known', {});
  await pool._answerServerRequest({ id: 1, method: 'session/requestRuntimePreferences' });
  assert.equal(response.result.memoryEnabled, false); assert.equal(response.result.askUserQuestionAutoResolutionEnabled, false);
  const params = { sessionId: 'known', options: [{ kind: 'allow_once', optionId: 'once' }] };
  await pool._answerServerRequest({ id: 2, method: 'interaction/requestPermission', params });
  assert.equal(response.result.decision, 'allow');
  await pool._answerServerRequest({ id: 3, method: 'interaction/requestPermission', params: { ...params, sessionId: 'other' } });
  assert.equal(response.result.decision, 'deny'); assert.equal(calls, 1);
  await pool._answerServerRequest({ id: 4, method: 'interaction/requestPermission', params: { ...params, options: [{ kind: 'allow_always', optionId: 'once' }] } });
  assert.equal(response.result.decision, 'deny');
  await pool._answerServerRequest({ id: 5, method: 'interaction/browserExecute' }); assert.equal(response.error.code, -32601);
});

test('a late stop acknowledgement cannot settle the following ZCode turn', async () => {
  const pool = new ZcodePool(); let stopAck;
  pool.nativeRequest = async method => method === 'session/stop' ? new Promise(resolve => { stopAck = resolve; }) : {};
  const first = pool.prompt({ sessionId: 'a', prompt: [] }); await new Promise(r => setImmediate(r));
  pool.notify('session/cancel', { sessionId: 'a' });
  pool._dispatch({ method: 'session/event', params: { sessionId: 'a', type: 'turn.completed' } });
  assert.equal((await first).stopReason, 'cancelled');
  const next = pool.prompt({ sessionId: 'a', prompt: [] }); await new Promise(r => setImmediate(r));
  stopAck({}); await new Promise(r => setImmediate(r));
  assert.equal(pool.nativeTurns.size, 1, 'late stop ACK must remain bound to its original pending turn');
  pool._dispatch({ method: 'session/event', params: { sessionId: 'a', type: 'turn.completed' } });
  assert.equal((await next).stopReason, 'end_turn');
});

test('new native mode APIs are isolated and bypass requires explicit confirmation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-harness-controls-'));
  const app = createApplication({ dataDir: dir, workspaceRoot: path.join(dir, 'agents'), nativeRegistration: false,
    discoveryInventory: async () => ({ rows: [] }), registerAgent: async () => ({}), inspectDesktop: () => ({}),
    querySessionControls: async backend => ({ backend, presets: [{ id: 'native' }], permissions: (backend === 'qoder' ? ['default', 'dontAsk', 'yolo'] : ['plan', 'build']).map(id => ({ id })) }),
    roomFactory: options => new AgentRoom({ ...options, prewarm: false }) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (route, body) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, data: await r.json() }; };
  for (const backend of ['qoder', 'zcode']) {
    const initial = (await call('/agents', { backend, label: backend })).data;
    const second = (await call('/conversations', { agentId: initial.agent.id })).data.conversation;
    const permission = backend === 'qoder' ? 'dontAsk' : 'build';
    assert.equal((await call('/session-controls', { room: second.id, config: { preset: 'native', permission } })).status, 200);
    assert.deepEqual((await call('/session-controls?room=' + initial.conversation.id)).data.config, defaultSessionConfig(backend));
    assert.equal((await call('/session-controls', { room: second.id, config: { preset: 'native', permission: 'read-only' } })).status, 400);
    if (backend === 'qoder') {
      assert.equal((await call('/session-controls', { room: second.id, config: { preset: 'native', permission: 'yolo' } })).status, 400);
      assert.equal((await call('/session-controls', { room: second.id, config: { preset: 'native', permission: 'yolo' }, confirmFullAccess: true })).status, 200);
    }
  }
});

test('ZCode manual discovery never scans and rejects a desktop without its runtime', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'ZCode.exe'); fs.writeFileSync(exe, 'fixture'); fs.mkdirSync(path.join(dir, 'resources')); fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'fixture');
  assert.throws(() => adapt('zcode', exe), /缺少/);
  let scanned = 0;
  const discovery = new BackendDiscovery({ dir, allowAuto: false, inventory: async () => { scanned++; return { rows: [] }; }, detect: () => { scanned++; return []; }, lookup: () => { scanned++; return null; } });
  assert.ok((await discovery.scan()).some(r => r.id === 'zcode')); assert.equal(scanned, 0);
});

test('desktop transport rejects an unauthenticated connection and closes its owned streams', async t => {
  const { createHostTransport } = require('../standalone/zcode-host-transport.cjs');
  const transport = await createHostTransport(); t.after(() => transport.close());
  const fixture = `const net=require('node:net');const port=Number(process.env.AGENT_ROOM_ZCODE_BRIDGE_PORT);const bad=net.connect(port,'127.0.0.1');bad.on('connect',()=>bad.end(JSON.stringify({token:'wrong'})+'\\n'));bad.on('close',()=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>s.write(JSON.stringify({token:process.env.AGENT_ROOM_ZCODE_BRIDGE_TOKEN})+'\\n'));s.on('data',b=>s.write(b));s.on('end',()=>s.end());});`;
  const child = transport.spawnChild(process.execPath, ['-e', fixture], { env: process.env, cwd: process.cwd() });
  t.after(() => child.kill());
  const response = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('transport timeout')), 5000); child.stdout.once('data', c => { clearTimeout(timer); resolve(c.toString()); }); });
  child.stdin.write('authenticated-pipe\n');
  assert.equal(await response, 'authenticated-pipe\n');
  child.stdin.end();
  await new Promise(resolve => child.once('exit', resolve));
});
