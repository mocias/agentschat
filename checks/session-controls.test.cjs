'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApplication } = require('../standalone/server.cjs');
const { AgentRoom } = require('../lib/room.cjs');
const { ApprovalRequests } = require('../lib/approval-requests.cjs');
const { validateSessionConfig } = require('../standalone/session-controls.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
const { DshSessionPool } = require('../standalone/dsh-session-pool.cjs');

const caps = backend => ({ backend, permissions: ['read-only', 'workspace-write', 'danger-full-access'].map(id => ({ id, label: id })),
  presets: (backend === 'codex' ? ['default', 'plan'] : ['standard', 'minimal']).map(id => ({ id, label: id })) });
const until = async fn => { for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

test('native session choices persist independently and approval requests are scoped, explicit and cancelled on stop', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-controls-')), captures = [], rooms = new Map();
  let requestOnTurn = false, calls = 0;
  const options = { dataDir: dir, workspaceRoot: path.join(dir, 'agents'), nativeRegistration: false, registerAgent: async () => ({}), inspectDesktop: () => ({}), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {},
    discoveryInventory: async () => ({ rows: [] }), querySessionControls: async backend => caps(backend),
    roomFactory: settings => {
      const room = new AgentRoom(settings); rooms.set(settings.id, room);
      const threads = new Map();
      const pool = { running: true, start: async () => {}, stop: async () => {}, modelCapabilities: async () => new Map(), getThread: key => threads.get(key),
        openThread: async (key, config) => { const value = { id: settings.id, ...config }; threads.set(key, value); captures.push({ room: settings.id, config }); return value; }, closeThread: key => threads.delete(key), interrupt: async () => true,
        runTurn: async (key, input) => {
          calls++; captures.push({ room: settings.id, input });
          if (requestOnTurn) captures.push({ room: settings.id, approval: await room._onServerRequest('item/commandExecution/requestApproval', { command: 'write a fixture file' }) });
          return { text: 'fixture result', usage: {} };
        } };
      for (const member of settings.members) room.pools.set(member.backend, pool);
      return room;
    } };
  let app;
  async function start() { app = createApplication(options); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); }
  await start(); t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (route, body) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, data: await r.json() }; };
  const a = (await call('/agents', { backend: 'codex', label: 'C' })).data;
  const second = (await call('/conversations', { agentId: a.agent.id })).data.conversation;
  const dsh = (await call('/agents', { backend: 'dsh', label: 'D' })).data;
  const config = { preset: 'plan', permission: 'workspace-write' };
  assert.equal((await call('/session-controls', { room: a.conversation.id, config })).status, 200);
  assert.equal((await call('/session-controls', { room: dsh.conversation.id, config: { preset: 'minimal', permission: 'read-only' } })).status, 200);
  assert.equal(calls, 0, 'configuring must not prompt a model');
  assert.equal((await call('/session-controls', { room: a.conversation.id, config: { preset: 'standard', permission: 'workspace-write' } })).status, 400);
  assert.equal((await call('/session-controls', { room: second.id, config: { preset: 'default', permission: 'danger-full-access' } })).status, 400);
  assert.equal((await call('/session-controls?room=' + second.id)).data.config.permission, 'read-only');
  const group = (await call('/groups', { agentIds: [a.agent.id, dsh.agent.id] })).data.conversation;
  assert.equal((await call('/session-controls', { room: group.id, config })).status, 400);
  requestOnTurn = true;
  assert.equal((await call('/say', { room: a.conversation.id, text: 'Plan the fixture' })).status, 202);
  const pending = await until(async () => (await call('/approvals?room=' + a.conversation.id)).data.approvals[0]);
  assert.equal((await call('/stop', {})).status, 404);
  assert.equal((await call('/approvals?room=' + a.conversation.id)).data.approvals.length, 1, 'invalid stop must not cancel another room approval');
  assert.equal((await call('/approvals?room=' + second.id)).data.approvals.length, 0);
  assert.equal((await call('/approvals', { room: second.id, id: pending.id, allow: true })).status, 400);
  assert.equal((await call('/session-controls', { room: a.conversation.id, config })).status, 400, 'busy session rejects configuration changes');
  assert.equal((await call('/approvals', { room: a.conversation.id, id: pending.id, allow: false })).status, 200);
  await until(() => captures.some(c => c.approval));
  assert.deepEqual(captures.find(c => c.approval).approval, { decision: 'decline' });
  await until(() => !rooms.get(a.conversation.id).snapshot().busy.length);
  const opening = captures.find(c => c.config && c.room === a.conversation.id).config;
  const input = captures.find(c => c.input && c.room === a.conversation.id).input;
  assert.equal(opening.sandbox, 'workspace-write'); assert.equal(opening.approvalPolicy, 'on-request');
  assert.equal(input.collaborationMode.mode, 'plan'); assert.equal(input.sandboxPolicy.type, 'workspaceWrite');
  assert.doesNotMatch(input.text, /默认 1-3 句话.*不要使用任何工具/);
  assert.equal((await call('/session-controls', { room: a.conversation.id, config: { ...config, preset: 'default' } })).status, 400);
  assert.equal((await call('/session-controls?room=' + a.conversation.id)).data.presetLocked, true);
  await call('/say', { room: a.conversation.id, text: 'Another request' });
  await until(async () => (await call('/approvals?room=' + a.conversation.id)).data.approvals.length);
  await call('/stop', { room: a.conversation.id });
  await until(() => !rooms.get(a.conversation.id).snapshot().busy.length);
  assert.equal((await call('/approvals?room=' + a.conversation.id)).data.approvals.length, 0);
  await app.close(); await start();
  assert.deepEqual((await call('/session-controls?room=' + a.conversation.id)).data.config, config);
  assert.equal((await call('/session-controls?room=' + second.id)).data.config.permission, 'read-only');
  assert.equal((await call('/session-controls?room=' + dsh.conversation.id)).data.config.preset, 'minimal');
});

test('permission broker never grants standing approval and rejects unavailable native choices', async () => {
  const broker = new ApprovalRequests(() => {});
  const promise = broker.request('a', 'dsh', 'session/request_permission', {});
  const id = broker.list('a')[0].id;
  assert.throws(() => broker.answer('b', id, true));
  broker.answer('a', id, true); assert.equal(await promise, true);
  const cancelled = broker.request('a', 'dsh', 'session/request_permission', {}); broker.cancel('a'); assert.equal(await cancelled, false);
  const room = new AgentRoom({ kind: 'direct', sessionConfig: { permission: 'workspace-write', preset: 'standard' }, requestApproval: async () => true, prewarm: false });
  assert.deepEqual(await room._onServerRequest('session/request_permission', { options: [{ kind: 'allow_always', optionId: 'forever' }, { kind: 'allow_once', optionId: 'once' }] }), { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.deepEqual(await room._onServerRequest('session/request_permission', { options: [{ kind: 'allow_always', optionId: 'forever' }] }), { outcome: { outcome: 'cancelled' } });
  const unavailable = caps('dsh'); unavailable.presets[0].unavailable = 'native plugin missing';
  assert.throws(() => validateSessionConfig({ preset: 'standard', permission: 'read-only' }, unavailable));
  assert.throws(() => validateSessionConfig({ preset: 'minimal', permission: 'read-only', injected: true }, unavailable));
});

test('DSH applies native preset and permissions before a session is usable, and fails closed on mismatch', async () => {
  const pool = new DshSessionPool({ agentCommand: 'fixture', dshControlsRoot: 'unused' });
  pool.start = async () => {}; const calls = [];
  pool.request = async (method, params) => { calls.push({ method, params }); if (method === 'session/new') return { sessionId: 'native-id' }; return {}; };
  pool.controls = { request: async (route, body) => { calls.push({ route, body }); return { preset: body.preset, permission: body.permission }; } };
  const config = { preset: 'minimal', permission: 'read-only' };
  const thread = await pool.openThread('a', { cwd: 'fixture', sessionConfig: config });
  assert.deepEqual(thread.appliedSessionConfig, config); assert.equal(calls[0].method, 'session/new'); assert.equal(calls[1].body.sessionId, 'native-id');
  pool.controls.request = async () => ({ preset: 'standard', permission: 'danger-full-access' });
  await assert.rejects(pool.openThread('b', { cwd: 'fixture', sessionConfig: config }), /没有应用/);
  assert.equal(pool.getThread('b'), undefined);
  const acp = new AcpPool({ onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }) });
  let response; acp.write = value => { response = value; };
  await acp._answerServerRequest({ id: 1, method: 'session/request_permission', params: { options: [{ kind: 'allow_once', optionId: 'yes' }] } });
  assert.deepEqual(response.result, { outcome: { outcome: 'cancelled' } });
});
