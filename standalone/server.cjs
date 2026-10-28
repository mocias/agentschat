'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentRoom } = require('../lib/room.cjs');
const { AlarmStore } = require('../lib/alarms.cjs');
const { AgentMemoryStore } = require('../lib/agent-memory.cjs');
const { PollStore, pollText } = require('../lib/polls.cjs');
const { PollBroker } = require('../lib/poll-mcp.cjs');
const { splitMessages } = require('../lib/message-routing.cjs');
const { RoomApi, readJsonBody, sendJson, sendText } = require('../lib/server.cjs');
const { harnessIds } = require('../lib/harnesses.cjs');
const { BackendDiscovery } = require('./discovery.cjs');
const { queryModels } = require('./models.cjs');
const { defaultSessionConfig, querySessionControls, validateSessionConfig } = require('./session-controls.cjs');
const { ApprovalRequests } = require('../lib/approval-requests.cjs');
const { searchHistory, exportHistory } = require('./history.cjs');
const { createDataLocation } = require('./data-location.cjs');
const { chooseWorkspace, assertWorkspace, assertDeletable } = require('./workspaces.cjs');
const { ensureCodexProject, registerAgent } = require('./desktop-sync.cjs');
const { inspectDesktop } = require('./desktop-state.cjs');
const { createDispatcher } = require('./registration-dispatcher.cjs');

// This host owns contacts and conversations; the existing engine owns turns.
function createApplication(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.AGENT_ROOM_DATA || path.join(__dirname, '..', '.agent-room-data'));
  const workspaceRoot = path.resolve(options.workspaceRoot || process.env.AGENT_ROOM_WORKSPACE_ROOT || path.join(__dirname, '..', 'agents'));
  fs.mkdirSync(dataDir, { recursive: true });
  const catalogFile = path.join(dataDir, 'catalog.json');
  const uiStateFile = path.join(dataDir, 'ui-state.json');
  let catalog = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : { version: 1, agents: [], conversations: [] };
  // Older releases stored the Agent's pin on its sole direct conversation.
  // Materialize it independently before any session pin can change that meaning.
  catalog.agents = catalog.agents.map(agent => !['codex', 'dsh', 'qoder', 'zcode'].includes(agent.backend) || typeof agent.pinned === 'boolean' ? agent : {
    ...agent, pinned: catalog.conversations.some(c => c.kind === 'direct' && c.agentIds[0] === agent.id && c.pinned),
  });
  if (!fs.existsSync(catalogFile)) fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
  const configFile = path.join(dataDir, 'backends.json');
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  const consentFile = path.join(dataDir, 'discovery-consent.json');
  let discoveryChoice = fs.existsSync(consentFile) ? JSON.parse(fs.readFileSync(consentFile, 'utf8')).choice : null;
  const discovery = new BackendDiscovery({ dir: dataDir, legacy: config, inventory: options.discoveryInventory, allowAuto: discoveryChoice === 'automatic' });
  let configuring = false;
  const roomsDir = path.join(dataDir, 'rooms');
  fs.mkdirSync(roomsDir, { recursive: true });
  const workspaceDirs = {};
  for (const backend of harnessIds()) {
    workspaceDirs[backend] = path.join(dataDir, 'workspaces', backend);
    if (catalog.agents.some(a => a.backend === backend && !a.workspace)) fs.mkdirSync(workspaceDirs[backend], { recursive: true });
  }
  const api = new RoomApi({ roomsDir, idleRoomTtlMs: 0, maxUploadBytes: 20 * 1024 * 1024 });
  const memory = new AgentMemoryStore(path.join(dataDir, 'memory'));
  if (!fs.existsSync(path.join(dataDir, 'agent-room-theme', 'theme.json'))) api.theme.update({ preset: 'paper' });
  const runtimes = new Map();
  const deletingRooms = new Set();
  const syncingAgents = new Set();
  const registrationTasks = new Map();
  const modelCache = new Map();
  const controlCache = new Map();
  const approvals = new ApprovalRequests(publish);
  async function controlsFor(agent, refresh = false) {
    const key = JSON.stringify([agent.backend, agent.workspace]);
    const cached = controlCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 30000) return cached.value;
    const backend = (await discovery.scan()).find(r => r.id === agent.backend);
    if (!backend?.selected && !options.querySessionControls) throw new Error('后端未配置，无法读取原生会话选项');
    // Respect project-scoped Codex requirements; never recreate a missing workspace.
    if (!options.querySessionControls) {
      checkWorkspace(agent);
      if (!agent.workspace || !fs.existsSync(agent.workspace)) throw new Error('工作区已不存在，请先在 Agent 设置中选择有效目录');
    }
    const value = await (options.querySessionControls || querySessionControls)(agent.backend, backend?.selected?.launch, agent.workspace || dataDir, dataDir);
    controlCache.set(key, { at: Date.now(), value }); return value;
  }
  async function modelsFor(id, model, refresh = false) {
    if (!harnessIds().includes(id)) throw new Error('该后端尚未接入模型查询');
    const key = JSON.stringify([id, model || null]);
    const cached = modelCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 300000) return cached.value;
    const row = (await discovery.scan()).find(r => r.id === id);
    if (!row?.selected && !options.queryModels) throw new Error(row?.detail || '后端不可用');
    const value = await (options.queryModels || queryModels)(id, row?.selected?.launch, dataDir, model);
    modelCache.set(key, { at: Date.now(), value });
    return value;
  }
  const clients = new Set();
  let closing = false;
  const polls = new PollStore(path.join(dataDir, 'polls.json'), options.pollOptions);
  const pollBroker = new PollBroker(({ roomId, memberId }, name, args) => {
    if (closing || configuring) throw new Error('应用正在更新或退出，请稍后重试');
    const row = conversation(roomId);
    if (row.kind !== 'group') throw new Error('投票仅在群聊可用');
    return polls.call(roomId, memberId, name, args, row.agentIds.map(id => catalog.agents.find(a => a.id === id)).filter(Boolean));
  });
  polls.on('change', ({ roomId }) => {
    publish({ type: 'polls', room: roomId, polls: polls.items.filter(p => p.roomId === roomId).map(p => polls.view(p, 'user')) });
  });
  const factory = options.roomFactory || ((settings) => new AgentRoom(settings));
  function save(next) {
    const tmp = catalogFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, catalogFile);
    catalog = next;
  }
  function publish(event) {
    if (closing) return;
    const wire = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const client of clients) {
      if (client.destroyed || client.writableEnded) { clients.delete(client); continue; }
      client.write(wire);
    }
  }
  function changed() { publish({ type: 'catalog', catalog }); }
  function syncAgent(agent) {
    if (syncingAgents.has(agent.id)) throw new Error('正在同步，请稍后');
    syncingAgents.add(agent.id);
    const task = (async () => {
    try {
      const row = (await discovery.scan()).find(r => r.id === agent.backend);
      const result = await (options.registerAgent || registerAgent)(agent, row?.selected?.launch, { dataDir, conversations: catalog.conversations });
      await registrationDispatcher.kick();
      return result;
    } catch (error) { return { status: 'error', detail: '桌面同步失败：' + error.message }; }
    finally { syncingAgents.delete(agent.id); }
    })();
    registrationTasks.set(agent.id, task);
    return task.finally(() => registrationTasks.delete(agent.id));
  }
  // Registration runs only inside Room. Durable queues resume next launch.
  const registrationDispatcher = options.nativeRegistration === false || options.roomFactory
    ? { kick: async () => {}, close: async () => {} }
    : (options.registrationDispatcher || createDispatcher)(dataDir);
  const registrationTimers = new Map();
  function scheduleRegistration(agentId) {
    if (options.nativeRegistration === false || options.roomFactory || closing) return;
    clearTimeout(registrationTimers.get(agentId));
    const timer = setTimeout(async () => {
      registrationTimers.delete(agentId);
      const agent = catalog.agents.find(a => a.id === agentId);
      if (!agent || closing) return;
      const desktopSync = await syncAgent(agent);
      if (!closing && catalog.agents.some(a => a.id === agentId && a.workspace === agent.workspace)) {
        save({ ...catalog, agents: catalog.agents.map(a => a.id === agentId ? { ...a, desktopSync } : a) }); changed();
      }
    }, 1500);
    timer.unref?.(); registrationTimers.set(agentId, timer);
  }
  for (const agent of catalog.agents) if (['codex', 'dsh', 'workbuddy', 'workbuddy-ai', 'qoder', 'claude'].includes(agent.backend)) scheduleRegistration(agent.id);
  // Preserve old contacts' actual directories; new contacts get their own folder.
  if (catalog.agents.some(a => !a.workspace)) save({ ...catalog, agents: catalog.agents.map(a => a.workspace ? a : { ...a, workspace: workspaceDirs[a.backend] || dataDir }) });
  // Backfill is additive and idempotent. Never rewrite room logs or workspace files.
  memory.importHistory(catalog, roomsDir);
  function workspaceConstraints(exceptId) {
    const appRoot = path.join(__dirname, '..');
    return {
      otherWorkspaces: catalog.agents.filter(agent => agent.id !== exceptId).map(agent => agent.workspace),
      protectedPaths: [dataDir, appRoot],
      reservedDirs: ['memory', 'rooms', 'agent-room-files', 'agent-room-theme'].map(name => path.join(dataDir, name))
        .concat(['standalone', 'lib', 'desktop', 'resources'].map(name => path.join(appRoot, name))),
    };
  }
  function checkWorkspace(member) {
    const agent = catalog.agents.find(entry => entry.id === member.id);
    if (!agent) throw new Error('Agent 不存在');
    assertWorkspace(agent.workspace, workspaceConstraints(agent.id));
  }
  function workspaceIssue(agent) {
    try { checkWorkspace(agent); return null; } catch (error) { return error.message; }
  }
  function conversation(id) {
    const found = catalog.conversations.find((row) => row.id === id);
    if (!found || deletingRooms.has(id)) throw Object.assign(new Error('会话不存在或正在删除'), { status: 404 });
    return found;
  }
  async function runtime(id, allowUnavailable = false) {
    const row = conversation(id);
    if (runtimes.has(id)) return runtimes.get(id);
    const detected = await discovery.scan();
    conversation(id); // Do not resurrect a room removed while discovery was pending.
    if (!allowUnavailable && !options.roomFactory && !discovery.allowAuto && row.agentIds.some(key => !detected.find(b => b.id === catalog.agents.find(a => a.id === key)?.backend)?.found)) throw new Error('请先在后端管理中允许扫描或手动配置程序路径');
    if (runtimes.has(id)) return runtimes.get(id);
    const backends = {};
    for (const backend of detected) if (backend.selected) backends[backend.id] = backend.selected.launch;
    const members = row.agentIds.map((key) => ({ ...catalog.agents.find((agent) => agent.id === key),
      ...(row.efforts && Object.hasOwn(row.efforts, key) ? { effort: row.efforts[key] } : {}) }));
    const room = factory({ id, title: row.title, kind: row.kind, members, backend: members[0]?.backend || 'codex', memory, checkWorkspace,
      sessionConfig: row.sessionConfig || null,
      requestApproval: (backend, method, params) => approvals.request(id, backend, method, params),
      createAlarms: (roomId, creatorId, commands) => alarms.createBatch(roomId, creatorId, commands),
      ...(row.kind === 'group' ? {
        pollTools: member => pollBroker.bind(id, member.id),
        pollView: (pollId, actor) => polls.view(polls.find(id, pollId), actor),
        pollList: () => polls.items.filter(p => p.roomId === id).map(p => polls.view(p, 'user')),
      } : {}),
      cwd: dataDir, workspaceDirs, backends, codexPath: backends.codex?.codexPath,
      logFile: path.join(roomsDir, id + '.log.jsonl'), mode: 'chat', prewarm: false,
      replyPolicy: row.kind === 'direct' ? 'everyone' : 'addressed', projectName: null,
      prepareNativeSession: options.prepareNativeSession || (async (member, pool) => {
        if (member.backend !== 'codex') return {};
        const agent = catalog.agents.find(a => a.id === member.id);
        try { return { projectId: await ensureCodexProject(pool, agent) }; }
        catch (error) {
          const desktopSync = { status: 'error', detail: '项目同步失败，对话仍可继续：' + error.message };
          save({ ...catalog, agents: catalog.agents.map(a => a.id === agent.id ? { ...a, desktopSync } : a) }); changed();
          room.pushSystem(desktopSync.detail); return {};
        }
      }),
      afterNativeTurn: options.afterNativeTurn || (async (member, pool, thread) => {
        if (member.backend === 'codex') await pool.request('thread/name/set', { threadId: thread.id, name: conversation(id).title + ' · ' + member.label });
      }),
      segmentMs: 1200, maxRelayHops: 2 });
    for (const record of room.log) api.attachments.rehydrate(record);
    const state = { room, connecting: null, pending: false, lastUsed: Date.now() };
    runtimes.set(id, state);
    room.on('session', event => {
      // Save the native identity for verification and future resume support.
      const next = { ...catalog, conversations: catalog.conversations.map(c => c.id === id ? {
        ...c, nativeSessions: { ...c.nativeSessions, [event.memberId]: { backend: event.backend, id: event.sessionId, cwd: event.cwd } },
      } : c) };
      save(next);
      scheduleRegistration(event.memberId);
    });
    room.on('update', (snapshot) => publish({ type: 'snapshot', room: id, snapshot: api._publicSnapshot(snapshot) }));
    room.on('stream', (event) => {
      if (event.type === 'agent-end') approvals.cancel(id);
      publish({ type: 'stream', room: id, event });
      if (event.type === 'agent-end' && event.error) {
        const name = members.find((member) => member.id === event.memberId)?.label || 'Agent';
        room.pushSystem(`${name} 回复失败：${event.error}`);
      }
    });
    room.on('message', (record) => {
      const current = conversation(id);
      const automaticTitle = current.kind === 'direct' && current.titleSource === 'automatic' && record.kind === 'user'
        ? String(record.text || record.attachments?.[0]?.name || '文件对话').replace(/\s+/g, ' ').trim().slice(0, 36) : null;
      if (automaticTitle) room.title = automaticTitle;
      const next = { ...catalog, conversations: catalog.conversations.map((entry) => entry.id !== id ? entry : {
        ...entry, ...(automaticTitle ? { title: automaticTitle, titleSource: 'generated' } : {}), updatedAt: record.ts, preview: record.pollId ? '投票：' + (polls.items.find(p => p.id === record.pollId)?.question || record.text).slice(0, 90) : record.text.slice(0, 100),
      }) };
      save(next);
      publish({ type: 'message', room: id, record: api._publicRecord(record) });
      changed();
    });
    return state;
  }
  async function release(state) {
    approvals.cancel(state.room.id);
    pollBroker.revokeRoom(state.room.id);
    if (state.room.tickTimer) clearInterval(state.room.tickTimer);
    if (state.room._groupTimer) clearTimeout(state.room._groupTimer);
    await state.room.dispose();
  }
  const sweeper = setInterval(() => {
    for (const [id, state] of runtimes) {
      if (!state.pending && !state.room.snapshot().busy.length && Date.now() - state.lastUsed > 30 * 60 * 1000) {
        runtimes.delete(id);
        void release(state);
      }
    }
  }, 60000);
  sweeper.unref();
  const alarms = new AlarmStore(path.join(dataDir, 'alarms.json'), async alarm => {
    if (configuring) throw new Error('正在更新会话配置，稍后重试');
    const row = catalog.conversations.find(c => c.id === alarm.roomId);
    if (!row || (!['user', 'all'].includes(alarm.targetId) && !row.agentIds.includes(alarm.targetId))) return false;
    const state = await runtime(alarm.roomId, true);
    state.lastUsed = Date.now();
    const seen = state.room.log.some(record => record.alarmId === alarm.id);
    const record = state.room.fireAlarm(alarm);
    if (!record) return false;
    if (!seen && record.mentions.length) {
      state.room.cascadeRemaining = state.room.maxRelayHops;
      // The reminder is durable before models are woken. Model failures do not
      // create duplicate reminders or block other due alarms.
      void state.room._serveNow(record.mentions).catch(error => state.room.pushSystem('闹钟回复失败：' + error.message));
    }
    return true;
  }, options.alarmOptions);
  let pollTickRunning = null;
  const announcedPolls = new Set();
  async function tickPolls() {
    if (closing || configuring) return;
    polls.expire();
    for (const roomId of new Set(polls.items.map(p => p.roomId))) {
      const row = catalog.conversations.find(c => c.id === roomId);
      if (!row || deletingRooms.has(roomId)) continue;
      polls.syncMembers(roomId, row.agentIds);
      const roomPolls = polls.items.filter(p => p.roomId === roomId);
      if (roomPolls.every(p => p.status !== 'open' && announcedPolls.has(p.id + ':' + p.status))) continue;
      const state = await runtime(roomId, true);
      if (closing || configuring || !catalog.conversations.some(c => c.id === roomId)) return;
      for (const p of polls.items.filter(p => p.roomId === roomId)) {
        const phase = p.status;
        if (!state.room.log.some(r => r.pollId === p.id && r.pollPhase === phase)) {
          const record = state.room.append({ authorId: 'system', authorLabel: '系统', kind: 'system',
            pollId: p.id, pollPhase: phase, text: pollText(polls.view(p)) });
          // Result context is delivered once with no @ relay. Invitations use
          // separate turns, so ordinary backlog trimming cannot lose them.
          if (phase === 'closed') for (const member of state.room.members) state.room._addLineToSegment(member, record);
        }
        announcedPolls.add(p.id + ':' + phase);
        if (p.status !== 'open' || options.pollScheduling === false) continue;
        for (const member of state.room.members) {
          if (state.pending || member.running || state.room._hasPending(member) || state.room.busy.size >= state.room.maxParallel) continue;
          if (!polls.claim(p.id, member.id)) continue;
          state.lastUsed = Date.now();
          void state.room.inviteToPoll(member, p.id)?.catch(() => {});
        }
      }
    }
  }
  const pollTimer = setInterval(() => {
    if (pollTickRunning || closing) return;
    pollTickRunning = tickPolls().catch(() => {
      // Do not expose internal file contents or ballot details on failure.
      publish({ type: 'poll-error', message: '投票同步暂未完成，将自动重试' });
    }).finally(() => { pollTickRunning = null; });
  }, 1000);
  pollTimer.unref();
  const assetRoutes = new Set(['/api/theme', '/api/attach', '/api/background', '/api/theme/background']);
  const server = http.createServer(async (req, res) => {
    try {
      if (options.accessToken && req.headers['x-agent-room-token'] !== options.accessToken) {
        return sendJson(res, 403, { error: '仅限桌面客户端访问' });
      }
      // Loopback only, with same-origin checks against browser cross-site requests.
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return sendJson(res, 403, { error: '不允许的主机' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { error: '不允许跨站请求' });
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (req.method === 'GET' && route === '/api/polls') {
        const row = conversation(url.searchParams.get('room'));
        return sendJson(res, 200, { polls: polls.list(row.id, 'user') });
      }
      if (req.method === 'POST' && ['/api/polls/create', '/api/polls/close', '/api/polls/cancel', '/api/polls/retry'].includes(route)) {
        if (configuring || closing) throw new Error('应用正在更新或退出');
        const body = await readJsonBody(req), row = conversation(body.room);
        if (row.kind !== 'group') throw new Error('投票仅在群聊可用');
        const members = row.agentIds.map(id => catalog.agents.find(a => a.id === id)).filter(Boolean);
        if (route.endsWith('/retry')) { polls.retry(row.id, body.id); return sendJson(res, 200, { ok: true }); }
        const name = 'poll_' + route.split('/').pop();
        const result = polls.call(row.id, 'user', name, name === 'poll_create' ? body.poll : { poll_id: body.id }, members);
        return sendJson(res, 200, { poll: result });
      }
      if (req.method === 'GET' && route === '/api/alarms') {
        const room = url.searchParams.get('room'); conversation(room);
        return sendJson(res, 200, { alarms: alarms.items.filter(a => a.roomId === room) });
      }
      if (req.method === 'POST' && route === '/api/alarms/cancel') {
        const body = await readJsonBody(req); conversation(body.room);
        alarms.cancel(body.id, body.room); return sendJson(res, 200, { ok: true });
      }
      if (assetRoutes.has(route) || route.startsWith('/api/attachment/')) {
        if (await api.handle(req, res, { prefix: '/api' })) return;
      }
      if (route === '/api/data-location') {
        if (req.method === 'GET') return sendJson(res, 200, { ...(options.dataLocation?.status() || { current: dataDir }), configurable: Boolean(options.dataLocation), canBrowse: Boolean(options.chooseWorkspaceDirectory), autoRestart: Boolean(options.restartForMigration) });
        if (req.method === 'POST') {
          if (!options.dataLocation) throw new Error('此启动方式不支持保存数据目录设置');
          const body = await readJsonBody(req);
          if (!body.cancel && [...runtimes.values()].some(s => s.pending || s.room.snapshot().busy.length)) throw new Error('请等待 Agent 回复结束后再迁移数据');
          const result = body.cancel ? options.dataLocation.cancel() : options.dataLocation.schedule(body.path);
          sendJson(res, 200, { ...result, restarting: Boolean(result.pending && options.restartForMigration) });
          if (result.pending && options.restartForMigration) {
            configuring = true;
            setTimeout(options.restartForMigration, 200);
          }
          return;
        }
      }
      if (req.method === 'GET' && route === '/api/catalog') {
        const agents = catalog.agents.map(agent => ({ ...agent, memory: memory.stats(agent.id), workspaceIssue: workspaceIssue(agent), desktopSync: (options.inspectDesktop || inspectDesktop)(agent, { dataDir, conversations: catalog.conversations }) || agent.desktopSync }));
        return sendJson(res, 200, { ...catalog, agents, discoveryChoice, canChooseWorkspace: Boolean(options.chooseWorkspaceDirectory), workspaceRoot, harnesses: discovery.publicRows(await discovery.scan()) });
      }
      if (route === '/api/ui-state' && ['GET', 'POST'].includes(req.method)) {
        let input = {};
        if (req.method === 'POST') input = await readJsonBody(req);
        else { try { input = JSON.parse(fs.readFileSync(uiStateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; } }
        const agents = new Set(catalog.agents.map(a => a.id));
        const selected = catalog.conversations.some(c => c.id === input?.selected) ? input.selected : null;
        const expanded = Object.fromEntries(Object.entries(input?.expanded || {}).filter(([id, value]) => agents.has(id) && typeof value === 'boolean'));
        const lastSessions = Object.fromEntries(Object.entries(input?.lastSessions || {}).filter(([id, value]) => agents.has(id) && catalog.conversations.some(c => c.id === value && c.kind === 'direct' && c.agentIds[0] === id)));
        const view = { selected, expanded, lastSessions };
        if (req.method === 'POST') {
          fs.writeFileSync(uiStateFile + '.tmp', JSON.stringify(view, null, 2) + '\n');
          fs.renameSync(uiStateFile + '.tmp', uiStateFile);
        }
        return sendJson(res, 200, view);
      }
      if (req.method === 'GET' && route === '/api/agents/memory') {
        const agent = catalog.agents.find(entry => entry.id === url.searchParams.get('id'));
        if (!agent) throw Object.assign(new Error('Agent 不存在'), { status: 404 });
        const query = (url.searchParams.get('q') || '').trim();
        if (query.length > 2000) throw new Error('记忆搜索内容不能超过 2000 个字符');
        return sendJson(res, 200, { ...memory.stats(agent.id), entries: memory.search(agent.id, { query, limit: 50, recentFallback: false }) });
      }
      if (req.method === 'POST' && route === '/api/models') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await modelsFor(body.backend, body.model, Boolean(body.refresh)));
      }
      if (req.method === 'GET' && route === '/api/session-controls') {
        const row = conversation(url.searchParams.get('room'));
        const agent = catalog.agents.find(a => row.kind === 'direct' && row.agentIds[0] === a.id);
        if (!agent || !defaultSessionConfig(agent.backend)) throw new Error('此会话不支持原生输入配置');
        const capabilities = await controlsFor(agent, url.searchParams.get('refresh') === '1');
        const active = await runtime(row.id, true);
        return sendJson(res, 200, { ...capabilities, config: row.sessionConfig || defaultSessionConfig(agent.backend), legacy: !row.sessionConfig,
          presetLocked: active.room.log.some(record => record.kind === 'user'), model: agent.modelName || agent.model || '后端默认' });
      }
      if (req.method === 'POST' && route === '/api/session-controls') {
        const body = await readJsonBody(req), row = conversation(body.room);
        const agent = catalog.agents.find(a => row.kind === 'direct' && row.agentIds[0] === a.id);
        if (!agent || !defaultSessionConfig(agent.backend)) throw new Error('此会话不支持原生输入配置');
        const config = validateSessionConfig(body.config, await controlsFor(agent));
        const active = await runtime(row.id, true), current = conversation(row.id);
        if (configuring || active.pending || active.room.snapshot().busy.length || approvals.list(row.id).length) throw new Error('请等待当前会话完成或停止回复后修改');
        const old = current.sessionConfig || defaultSessionConfig(agent.backend);
        if (old.preset !== config.preset && active.room.log.some(record => record.kind === 'user')) throw new Error('预设需在首条消息前选择，请新建会话使用其他预设');
        if (['danger-full-access', 'yolo'].includes(config.permission) && old.permission !== config.permission && body.confirmFullAccess !== true) throw new Error('请明确确认完整访问权限');
        configuring = true;
        try {
          await release(active); runtimes.delete(row.id);
          save({ ...catalog, conversations: catalog.conversations.map(c => c.id === row.id ? { ...c, sessionConfig: config, nativeSessions: {} } : c) });
          changed(); return sendJson(res, 200, { config });
        } finally { configuring = false; }
      }
      if (req.method === 'GET' && route === '/api/approvals') {
        const row = conversation(url.searchParams.get('room')); return sendJson(res, 200, { approvals: approvals.list(row.id) });
      }
      if (req.method === 'POST' && route === '/api/approvals') {
        const body = await readJsonBody(req); conversation(body.room); approvals.answer(body.room, body.id, body.allow); return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/api/backend-login') {
        throw new Error('群聊复用 WorkBuddy 桌面现有登录，请在桌面应用中管理登录');
      }
      if (req.method === 'POST' && route === '/api/backend-login') {
        throw new Error('群聊复用 WorkBuddy 桌面现有登录，请在桌面应用中管理登录');
      }
      if (req.method === 'POST' && route === '/api/workspace/browse') {
        if (!options.chooseWorkspaceDirectory) throw new Error('浏览器版请填写文件夹的完整路径');
        return sendJson(res, 200, { path: await options.chooseWorkspaceDirectory() });
      }
      if (req.method === 'POST' && route === '/api/member-effort') {
        const body = await readJsonBody(req);
        if (Object.hasOwn(body, 'model')) throw new Error('群聊不能修改 Agent 模型');
        const row = conversation(body.room);
        const agent = catalog.agents.find(a => a.id === body.agent && row.agentIds.includes(a.id));
        if (!agent?.model) throw new Error('请先创建已选择固定模型的 Agent');
        const capabilities = await modelsFor(agent.backend, agent.model);
        const model = capabilities.models.find(m => m.id === agent.model);
        if (!model || !model.efforts.includes(body.effort)) throw new Error('该模型不支持所选推理强度');
        const active = runtimes.get(row.id);
        if (active && (active.pending || active.room.snapshot().busy.length)) throw new Error('请等待当前回复结束后再修改');
        save({ ...catalog, conversations: catalog.conversations.map(r => r.id === row.id ? { ...r, efforts: { ...r.efforts, [agent.id]: body.effort } } : r) });
        if (active) active.room.members.find(m => m.id === agent.id).effort = body.effort;
        changed();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/api/backends') {
        return sendJson(res, 200, { discoveryChoice, harnesses: discovery.publicRows(await discovery.scan(url.searchParams.get('refresh') === '1')), canBrowse: Boolean(options.chooseBackendFile) });
      }
      if (req.method === 'POST' && route === '/api/discovery-consent') {
        const body = await readJsonBody(req);
        if (!['automatic', 'manual'].includes(body.choice)) throw new Error('请选择扫描或手动配置');
        if (configuring) throw new Error('正在更新配置，请稍后');
        for (const state of runtimes.values()) if (state.pending || state.room.snapshot().busy.length) throw new Error('请等待回复结束后再修改');
        configuring = true;
        try {
          if (discovery.inflight) await discovery.inflight;
          fs.writeFileSync(consentFile + '.tmp', JSON.stringify({ choice: body.choice }));
          fs.renameSync(consentFile + '.tmp', consentFile);
          discoveryChoice = body.choice;
          discovery.allowAuto = body.choice === 'automatic'; discovery.cached = null; modelCache.clear();
          for (const state of runtimes.values()) await release(state);
          runtimes.clear();
          return sendJson(res, 200, { discoveryChoice });
        } finally { configuring = false; }
      }
      if (req.method === 'POST' && route === '/api/backends/browse') {
        if (!options.chooseBackendFile) throw new Error('浏览器版请粘贴本机程序的完整路径；桌面版支持直接选择文件');
        return sendJson(res, 200, { path: await options.chooseBackendFile() });
      }
      if (req.method === 'POST' && route === '/api/backends') {
        const body = await readJsonBody(req);
        if (configuring) throw new Error('正在更新配置，请稍后');
        for (const state of runtimes.values()) if (state.pending || state.room.snapshot().busy.length) throw new Error('有 Agent 正在回复，请等待结束后再修改后端');
        configuring = true;
        try {
          const rows = await discovery.save(body.id, body.automatic ? null : { path: body.path,
            ...(body.args === undefined ? {} : { args: body.args }), ...(body.proxy === undefined ? {} : { proxy: body.proxy }) });
          modelCache.clear();
          for (const [id, state] of runtimes) {
            if (!state.room.members.some((m) => m.backend === body.id)) continue;
            await release(state);
            runtimes.delete(id);
          }
          publish({ type: 'backends' });
          return sendJson(res, 200, { harnesses: discovery.publicRows(rows) });
        } finally { configuring = false; }
      }
      if (req.method === 'GET' && route === '/api/events') {
        if (closing) return sendJson(res, 503, { error: '应用正在退出' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 1500\n\n');
        clients.add(res);
        const timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 20000);
        const cleanup = () => { clearInterval(timer); clients.delete(res); };
        res.on('close', cleanup);
        res.on('error', cleanup);
        return;
      }
      if (req.method === 'GET' && route === '/api/history/search') {
        const id = url.searchParams.get('room');
        const rows = id ? [conversation(id)] : catalog.conversations.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const query = (url.searchParams.get('q') || '').trim();
        if (query.length > 200) throw new Error('搜索内容不能超过 200 个字符');
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的分页参数');
        return sendJson(res, 200, await searchHistory(roomsDir, rows, query, offset));
      }
      if (req.method === 'GET' && route === '/api/history/export') {
        const row = conversation(url.searchParams.get('room'));
        const format = url.searchParams.get('format') || 'md';
        if (!['md', 'json'].includes(format)) throw new Error('请选择 Markdown 或 JSON 格式');
        const filename = String(row.title).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80) + '-聊天记录.' + format;
        res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
          'Content-Disposition': "attachment; filename=chat-history." + format + "; filename*=UTF-8''" + encodeURIComponent(filename), 'Cache-Control': 'no-store' });
        try {
          for await (const chunk of exportHistory(roomsDir, row, format)) {
            if (res.destroyed) break;
            if (!res.write(chunk)) await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
          }
          res.end();
        } catch { res.destroy(); }
        return;
      }
      if (req.method === 'GET' && route === '/api/conversation') {
        const state = await runtime(url.searchParams.get('id'), true);
        state.lastUsed = Date.now();
        return sendJson(res, 200, { snapshot: api._publicSnapshot(state.room.snapshot()), pending: state.pending });
      }
      if (req.method === 'POST' && route === '/api/agents') {
        if (configuring) throw new Error('正在更新配置，请稍后');
        const body = await readJsonBody(req);
        const label = String(body.label || '').trim();
        if (!label || label.length > 40 || /[\r\n@]/.test(label)) throw new Error('名称需为 1–40 个字符，不能包含 @ 或换行');
        if (catalog.agents.some((a) => a.label.toLowerCase() === label.toLowerCase())) throw new Error('Agent 名称已存在');
        if (!harnessIds().includes(body.backend)) throw new Error('不支持的后端');
        let chosen;
        if (body.model && harnessIds().includes(body.backend)) {
          const capabilities = await modelsFor(body.backend, body.model);
          chosen = capabilities.models.find(m => m.id === body.model);
          if (!chosen) throw new Error('请选择后端返回的有效模型');
          if (configuring) throw new Error('正在更新配置，请稍后');
          if (catalog.agents.some(a => a.label.toLowerCase() === label.toLowerCase())) throw new Error('Agent 名称已存在');
        }
        const agent = { id: 'agent-' + randomUUID(), label, backend: body.backend, pinned: false,
          workspace: chooseWorkspace(workspaceRoot, body.backend, label, body.workspace, workspaceConstraints()),
          model: chosen?.id || String(body.model || '').trim().slice(0, 120) || null,
          modelLocked: Boolean(chosen), modelName: chosen ? [chosen.provider, chosen.name].filter(Boolean).join(' · ') : null,
          ...(chosen ? { effort: chosen.defaultEffort || null } : {}),
          persona: String(body.persona || '').trim().slice(0, 2000), aliases: [label], createdAt: new Date().toISOString() };
        const direct = { id: 'chat-' + randomUUID(), kind: 'direct', title: label, agentIds: [agent.id], updatedAt: agent.createdAt, preview: '开始聊天吧', ...(defaultSessionConfig(agent.backend) ? { sessionConfig: defaultSessionConfig(agent.backend) } : {}) };
        save({ ...catalog, agents: [...catalog.agents, agent], conversations: [...catalog.conversations, direct] });
        changed();
        agent.desktopSync = await syncAgent(agent);
        if (catalog.agents.some(a => a.id === agent.id)) { save({ ...catalog, agents: catalog.agents.map(a => a.id === agent.id ? agent : a) }); changed(); }
        return sendJson(res, 201, { agent, conversation: direct });
      }
      if (req.method === 'POST' && route === '/api/conversations') {
        const body = await readJsonBody(req);
        if (configuring || closing) throw new Error('应用正在更新或退出');
        const agent = catalog.agents.find(a => a.id === body.agentId);
        if (!agent || !['codex', 'dsh', 'qoder', 'zcode'].includes(agent.backend)) throw new Error('此后端暂不支持多个单聊会话');
        const title = String(body.title || '').trim();
        if (title.length > 60 || /[\r\n]/.test(title)) throw new Error('会话名称不能超过 60 个字符或包含换行');
        const row = { id: 'chat-' + randomUUID(), kind: 'direct', title: title || '新会话', titleSource: title ? 'custom' : 'automatic',
          agentIds: [agent.id], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), preview: '开始新的对话', sessionConfig: defaultSessionConfig(agent.backend) };
        // A new index entry only. Native sessions are opened lazily on the first send.
        save({ ...catalog, conversations: [...catalog.conversations, row] });
        changed(); return sendJson(res, 201, { conversation: row });
      }
      if (req.method === 'POST' && route === '/api/conversation/title') {
        const body = await readJsonBody(req), row = conversation(body.id);
        const agent = catalog.agents.find(a => a.id === row.agentIds[0]);
        if (row.kind !== 'direct' || !['codex', 'dsh', 'qoder', 'zcode'].includes(agent?.backend)) throw new Error('当前会话不支持单独命名');
        const title = String(body.title || '').trim();
        if (!title || title.length > 60 || /[\r\n]/.test(title)) throw new Error('请输入 1–60 个字符的会话名称，不能包含换行');
        if (configuring || closing) throw new Error('应用正在更新或退出');
        save({ ...catalog, conversations: catalog.conversations.map(c => c.id === row.id ? { ...c, title, titleSource: 'custom' } : c) });
        if (runtimes.has(row.id)) runtimes.get(row.id).room.title = title;
        changed(); return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/agents/pin') {
        const body = await readJsonBody(req);
        if (!catalog.agents.some(a => a.id === body.id) || typeof body.pinned !== 'boolean') throw new Error('请选择有效的 Agent 和置顶状态');
        if (configuring || closing) throw new Error('应用正在更新或退出');
        save({ ...catalog, agents: catalog.agents.map(a => a.id === body.id ? { ...a, pinned: body.pinned } : a) });
        changed(); return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/conversation/rename') {
        const body = await readJsonBody(req); const row = conversation(body.id);
        const name = String(body.name || '').trim();
        if (!name || name.length > (row.kind === 'direct' ? 40 : 60) || /[\r\n@]/.test(name)) throw new Error('名称不能为空、过长或包含 @、换行');
        if (configuring) throw new Error('正在更新配置，请稍后');
        const agent = row.kind === 'direct' ? catalog.agents.find(a => a.id === row.agentIds[0]) : null;
        if (row.kind === 'direct' && !agent) throw new Error('Agent 不存在');
        if (agent && catalog.agents.some(a => a.id !== agent.id && a.label.toLowerCase() === name.toLowerCase())) throw new Error('Agent 名称已存在');
        if (agent && syncingAgents.has(agent.id)) throw new Error('正在同步，请稍后');
        const affected = agent ? catalog.conversations.filter(c => c.agentIds.includes(agent.id)) : [row];
        for (const c of affected) {
          const active = runtimes.get(c.id);
          if (active && (active.pending || active.room.snapshot().busy.length)) throw new Error('请等待相关会话回复结束后再重命名');
        }
        configuring = true;
        try {
          if (agent) for (const c of affected) { const active = runtimes.get(c.id); if (active) await release(active); runtimes.delete(c.id); }
          save({ ...catalog,
            agents: catalog.agents.map(a => a.id === agent?.id ? { ...a, label: name, aliases: [name] } : a),
            conversations: catalog.conversations.map(c => {
              let next = c;
              if (agent && c.agentIds.includes(agent.id)) next = { ...next, nativeSessions: {} };
              if ((!agent && c.id === row.id) || (agent && c.kind === 'direct' && c.agentIds.includes(agent.id) && !c.titleSource && c.title === agent.label)) next = { ...next, title: name };
              return next;
            }) });
          if (!agent && runtimes.has(row.id)) runtimes.get(row.id).room.title = name;
          changed(); return sendJson(res, 200, { ok: true });
        } finally { configuring = false; }
      }
      if (req.method === 'POST' && route === '/api/conversation/pin') {
        const body = await readJsonBody(req);
        const row = conversation(body.id);
        if (typeof body.pinned !== 'boolean') throw new Error('请选择有效的置顶状态');
        if (configuring) throw new Error('正在更新配置，请稍后');
        save({ ...catalog, conversations: catalog.conversations.map(c => c.id === row.id ? { ...c, pinned: body.pinned } : c) });
        changed(); return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/groups/delete') {
        const body = await readJsonBody(req);
        const row = conversation(body.id);
        if (row.kind !== 'group') throw new Error('只能通过此入口删除群聊');
        if (configuring) throw new Error('正在更新配置，请稍后');
        const active = runtimes.get(row.id);
        if (active && (active.pending || active.room.snapshot().busy.length)) throw new Error('请等待群聊回复结束后再删除');
        if (alarms.items.some(a => a.roomId === row.id && a.id === alarms.activeId)) throw new Error('群聊闹钟正在投递，请稍后删除');
        configuring = true; deletingRooms.add(row.id);
        try {
          if (active) await release(active);
          runtimes.delete(row.id);
          const before = alarms.items;
          alarms.save(before.map(a => a.roomId === row.id && a.status === 'pending' ? { ...a, status: 'cancelled' } : a));
          try { save({ ...catalog, conversations: catalog.conversations.filter(c => c.id !== row.id) }); }
          catch (error) { alarms.save(before); throw error; }
          changed(); return sendJson(res, 200, { ok: true });
        } finally { deletingRooms.delete(row.id); configuring = false; }
      }
      if (req.method === 'POST' && route === '/api/agents/settings') {
        const body = await readJsonBody(req);
        if (Object.hasOwn(body, 'model')) throw new Error('不能修改 Agent 的固定模型');
        let agent = catalog.agents.find(a => a.id === body.id);
        const row = conversation(body.room);
        if (!agent || !row.agentIds.includes(agent.id)) throw new Error('会话成员不存在');
        if (Object.hasOwn(body, 'effort')) {
          const capabilities = await modelsFor(agent.backend, agent.model);
          if (!capabilities.models.find(m => m.id === agent.model)?.efforts.includes(body.effort)) throw new Error('该模型不支持所选推理强度');
        }
        agent = catalog.agents.find(a => a.id === body.id);
        if (!agent || configuring || syncingAgents.has(agent.id)) throw new Error('Agent 不存在或正在更新配置');
        if (typeof body.workspace !== 'string' || !body.workspace.trim()) throw new Error('请填写工作区完整路径');
        const affected = catalog.conversations.filter(c => c.agentIds.includes(agent.id));
        for (const c of affected) {
          const active = runtimes.get(c.id);
          if (active && (active.pending || active.room.snapshot().busy.length)) throw new Error('请等待相关会话回复结束后再修改');
        }
        const workspace = chooseWorkspace(workspaceRoot, agent.backend, agent.label, body.workspace, workspaceConstraints(agent.id));
        const moved = workspace !== agent.workspace;
        configuring = true;
        try {
          if (moved) for (const c of affected) { const active = runtimes.get(c.id); if (active) await release(active); runtimes.delete(c.id); }
          save({ ...catalog, agents: catalog.agents.map(a => a.id === agent.id ? { ...a, workspace, ...(moved ? { desktopSync: { status: 'pending', detail: '工作区已更改，尚未同步原桌面项目' } } : {}) } : a), conversations: catalog.conversations.map(c => {
            let next = c;
            if (moved && c.agentIds.includes(agent.id)) next = { ...next, nativeSessions: {} };
            if (c.id === row.id && Object.hasOwn(body, 'effort')) next = { ...next, efforts: { ...next.efforts, [agent.id]: body.effort } };
            return next;
          }) });
          const active = runtimes.get(row.id);
          if (active && Object.hasOwn(body, 'effort')) active.room.members.find(m => m.id === agent.id).effort = body.effort;
          if (moved) scheduleRegistration(agent.id);
          changed(); return sendJson(res, 200, { ok: true });
        } finally { configuring = false; }
      }
      if (req.method === 'POST' && route === '/api/agents/sync') {
        const body = await readJsonBody(req);
        const agent = catalog.agents.find(a => a.id === body.id);
        if (!agent || configuring) throw new Error('Agent 不存在或正在更新配置');
        const desktopSync = await syncAgent(agent);
        save({ ...catalog, agents: catalog.agents.map(a => a.id === agent.id ? { ...a, desktopSync } : a) }); changed();
        return sendJson(res, 200, { desktopSync });
      }
      if (req.method === 'POST' && route === '/api/agents/delete') {
        const body = await readJsonBody(req);
        const agent = catalog.agents.find(a => a.id === body.id);
        if (!agent) throw new Error('Agent 不存在');
        if (syncingAgents.has(agent.id)) throw new Error('正在同步项目，请完成后再删除');
        if (typeof body.deleteWorkspace !== 'boolean') throw new Error('请选择是否删除工作区');
        if (configuring) throw new Error('正在更新配置，请稍后');
        const affected = catalog.conversations.filter(c => c.agentIds.includes(agent.id));
        for (const c of affected) {
          const active = runtimes.get(c.id);
          if (active && (active.pending || active.room.snapshot().busy.length)) throw new Error('请等待相关会话回复结束后再删除 Agent');
        }
        let target;
        if (body.deleteWorkspace) {
          if (body.confirmWorkspace !== agent.workspace) throw new Error('请输入完整工作区路径以确认删除');
          target = assertDeletable(agent.workspace, {
            protectedPaths: [dataDir, workspaceRoot, path.resolve(__dirname, '..'), process.env.USERPROFILE, process.env.SystemRoot, process.env.ProgramFiles].filter(Boolean),
            otherWorkspaces: catalog.agents.filter(a => a.id !== agent.id).map(a => a.workspace),
          });
        }
        configuring = true;
        try {
          for (const c of affected) { const active = runtimes.get(c.id); if (active) await release(active); runtimes.delete(c.id); }
          // Move the exact verified folder aside before committing catalog changes.
          // A failed catalog write can restore it; a failed cleanup is surfaced.
          const staged = target && fs.existsSync(target) ? target + '.agent-room-delete-' + randomUUID() : null;
          if (staged) fs.renameSync(target, staged);
          try {
            save({ ...catalog, agents: catalog.agents.filter(a => a.id !== agent.id), conversations: catalog.conversations
              .filter(c => !(c.kind === 'direct' && c.agentIds.includes(agent.id)))
              .map(c => ({ ...c, agentIds: c.agentIds.filter(id => id !== agent.id), efforts: Object.fromEntries(Object.entries(c.efforts || {}).filter(([id]) => id !== agent.id)) })) });
          } catch (error) { if (staged) fs.renameSync(staged, target); throw error; }
          let warning = null;
          if (staged) { try { fs.rmSync(staged, { recursive: true }); } catch { warning = 'Agent 已删除，但工作区清理未完成，请手动处理：' + staged; } }
          changed(); return sendJson(res, 200, { ok: true, warning });
        } finally { configuring = false; }
      }
      if (req.method === 'POST' && route === '/api/groups') {
        if (configuring) throw new Error('正在更新配置，请稍后');
        const body = await readJsonBody(req);
        const ids = [...new Set(Array.isArray(body.agentIds) ? body.agentIds : [])];
        if (ids.length < 2 || ids.length > 12 || ids.some((id) => !catalog.agents.some((agent) => agent.id === id))) throw new Error('请选择 2–12 个有效 Agent');
        const row = { id: 'chat-' + randomUUID(), kind: 'group', title: String(body.title || '').trim().slice(0, 60) || '新的群聊',
          agentIds: ids, updatedAt: new Date().toISOString(), preview: `${ids.length} 位 Agent 已加入` };
        save({ ...catalog, conversations: [...catalog.conversations, row] });
        changed();
        return sendJson(res, 201, { conversation: row });
      }
      if (req.method === 'POST' && route === '/api/say') {
        if (configuring) throw new Error('正在更新后端配置，请稍后发送');
        const body = await readJsonBody(req);
        const onlyAlarms = splitMessages(String(body.text || '')).length > 0 && splitMessages(String(body.text || '')).every(block => block.startsWith('/alarm'));
        const state = await runtime(body.room, onlyAlarms);
        if (!state.room.members.length) throw new Error('该群聊已没有 Agent，仅保留历史记录');
        if (!onlyAlarms) for (const member of state.room.members) checkWorkspace(member);
        if (!onlyAlarms && !state.room.ready) for (const backend of await discovery.scan()) if (backend.status === 'invalid' && state.room.members.some((m) => m.backend === backend.id)) throw new Error(backend.detail);
        if (configuring) throw new Error('正在更新后端配置，请稍后发送');
        const text = String(body.text || '').trim();
        if (text.length > 50000) throw new Error('消息过长');
        const ids = [...new Set((Array.isArray(body.attachments) ? body.attachments : []).map((a) => typeof a === 'string' ? a : a.id))];
        const attachments = api._resolveAttachments(ids);
        if (ids.length !== attachments.length) throw new Error('附件不存在，请重新上传');
        if (!text && !attachments.length) throw new Error('请输入消息或添加附件');
        if (state.pending) return sendJson(res, 409, { error: '上一条消息仍在处理，请稍后再发' });
        state.pending = true;
        state.lastUsed = Date.now();
        publish({ type: 'pending', room: body.room, pending: true });
        // Accept quickly; completion, connection failures and streaming use SSE.
        sendJson(res, 202, { ok: true });
        void (async () => {
          try {
            if (!onlyAlarms && !state.room.ready) await state.room.connect({ tolerateFailures: true });
            await state.room.say(text, { attachments, waitForReply: false });
          } catch (error) {
            state.room.pushSystem('发送失败：' + error.message);
            publish({ type: 'failure', room: body.room, text, attachments: attachments.map((a) => api._publicAttachment(a)), error: error.message });
          } finally {
            state.pending = false;
            state.lastUsed = Date.now();
            publish({ type: 'pending', room: body.room, pending: false });
          }
        })();
        return;
      }
      if (req.method === 'POST' && route === '/api/stop') {
        const body = await readJsonBody(req);
        const state = await runtime(body.room);
        approvals.cancel(body.room);
        polls.pauseRoom(body.room);
        for (const member of state.room.members) member.segments = [];
        await state.room.interruptAll();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'], '/chat-layout.css': ['chat-layout.css', 'text/css'] };
        const asset = assets[route];
        if (asset) {
          res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
          return sendText(res, 200, fs.readFileSync(path.join(__dirname, 'public', asset[0]), 'utf8'), asset[1] + '; charset=utf-8');
        }
      }
      sendJson(res, 404, { error: '接口不存在' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 400, { error: error.message });
      else res.end();
    }
  });
  async function close() {
    for (const timer of registrationTimers.values()) clearTimeout(timer);
    registrationTimers.clear();
    closing = true;
    approvals.cancel();
    clearInterval(pollTimer);
    await pollTickRunning;
    await pollBroker.close();
    await registrationDispatcher.close();
    await alarms.close();
    clearInterval(sweeper);
    for (const client of clients) client.end();
    clients.clear();
    await Promise.all([...runtimes.values()].map(release));
    await Promise.all([...registrationTasks.values()]);
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await api.dispose();
  }
  return { server, close, dataDir };
}
if (require.main === module) {
  const defaultDir = process.env.AGENT_ROOM_DATA || path.join(__dirname, '..', '.agent-room-data');
  const dataLocation = createDataLocation(defaultDir, path.join(__dirname, '..', '.agent-room-location.json'));
  const app = createApplication({ dataDir: dataLocation.current, dataLocation });
  const port = Number(process.env.PORT || 4318);
  app.server.listen(port, '127.0.0.1', () => console.log(`agentschat: http://127.0.0.1:${port}\nData: ${app.dataDir}`));
  app.server.on('error', (error) => { console.error(error.message); process.exitCode = 1; void app.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}
module.exports = { createApplication };
