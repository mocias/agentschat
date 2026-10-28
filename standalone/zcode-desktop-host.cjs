'use strict';
const { app, utilityProcess, MessageChannelMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const resources = process.env.AGENT_ROOM_ZCODE_RESOURCES;
const cwd = process.cwd();

const sessions = new Map(), reverse = new Map();
const disposables = [];
let child, port, client, agent, closing = false;
const clientId = 'agentschat-' + randomUUID();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentschat-zcode-host-'));
app.setPath('userData', temporary);
app.disableHardwareAcceleration();
const connection = require('node:net').connect({ port: Number(process.env.AGENT_ROOM_ZCODE_BRIDGE_PORT), host: '127.0.0.1' });
connection.on('connect', () => connection.write(JSON.stringify({ token: process.env.AGENT_ROOM_ZCODE_BRIDGE_TOKEN }) + '\n'));
connection.on('error', () => void shutdown(1));
connection.on('close', () => void shutdown());
const send = frame => { if (!closing) connection.write(JSON.stringify(frame) + '\n'); };
const failure = error => String(error?.message || error).replace(/(?:Bearer\s+|sk-)[\w.+\/-]+/gi, '[redacted]').slice(0, 1200);
async function shutdown(code = 0) {
  if (closing) return; closing = true;
  for (const d of disposables) d.dispose();
  for (const session of sessions.values()) session.subscription?.dispose();
  reverse.clear(); client?.dispose(); port?.close();
  child?.postMessage({ type: 'dispose' });
  setTimeout(() => { child?.kill(); app.exit(code); }, 1200).unref();
  // The temporary Electron profile contains no account data. Keep it on an
  // abnormal exit rather than deleting a directory still held by Chromium.
}
connection.on('end', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdout.on('error', () => void shutdown());
const ready = app.whenReady().then(async () => {
  if (closing) throw new Error('ZCode 桥接已停止');
  if (!resources || !path.isAbsolute(resources)) throw new Error('缺少 ZCode 安装路径');
  const archive = path.join(resources, 'app.asar');
  const version = JSON.parse(fs.readFileSync(path.join(archive, 'package.json'), 'utf8')).version;
  // Private host integration is deliberately version-gated. Unknown releases
  // must not be reported as working just because their executable exists.
  if (version !== '3.16.3') throw new Error(`ZCode 桌面账号桥接尚未验证版本 ${version}（当前支持 3.16.3）`);
  const native = await import(pathToFileURL(path.join(archive, 'out', 'host', 'chunk-ZDLGWCUS.js')).href);
  const ChannelClient = Object.values(native).find(v => v?.name === 'ChannelClient');
  const Protocol = Object.values(native).find(v => v?.name === 'MessagePortProtocol');
  if (!ChannelClient || !Protocol) throw new Error('ZCode 宿主 RPC 结构不兼容');
  if (closing) throw new Error('ZCode 桥接已停止');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENT_ROOM_ZCODE_BRIDGE_PORT; delete env.AGENT_ROOM_ZCODE_BRIDGE_TOKEN;
  child = utilityProcess.fork(path.join(__dirname, 'zcode-host-worker.cjs'), [], { cwd, env, stdio: 'pipe', serviceName: 'agentschat ZCode account host' });
  // The native host owns authentication. Its logs are not protocol frames and
  // no credential values or provider headers are sent back to agentschat.
  child.stdout.resume(); child.stderr.resume();
  child.on('exit', () => { if (!closing) { send({ method: 'agentschat/hostExited' }); void shutdown(1); } });
  const channel = new MessageChannelMain(); port = channel.port1;
  client = new ChannelClient(new Protocol({ addEventListener: (n, h) => port.on(n, h), removeEventListener: (n, h) => port.off(n, h),
    postMessage: value => port.postMessage(value), start: () => port.start(), close: () => port.close() }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ZCode 宿主启动超时')), 15000);
    child.on('message', m => { if (m.type === 'agentschat-host-ready') { clearTimeout(timer); resolve(); } else if (m.type === 'agentschat-host-error') { clearTimeout(timer); reject(new Error('ZCode 宿主加载失败')); } });
  });
  child.postMessage({ type: 'init-local', agentSpawnFallbackCwd: cwd,
    zcodeBuiltinProviderConfigFilePath: path.join(resources, 'config', 'provider', 'zcode-builtin.json') }, [channel.port2]);
  agent = client.getChannel('zcode-agent');
  const hello = await agent.call('helloConversationV4', []);
  await agent.call('initializeConversationV4', [{ kind: 'clientHello', protocolVersion: hello.protocolVersion, clientId, clientKind: 'desktop', appVersion: require('../package.json').version }]);
  disposables.push(agent.listen('onDynamicSessionRuntimePreferencesRequest')((p) => {
    void agent.call('respondSessionRuntimePreferences', [{ requestId: p.requestId, resolution: { status: 'resolved',
      preferences: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } } }]).catch(() => {});
  }));
  await agent.call('syncAppRuntimePreferences', [{ askUserQuestionAutoResolutionEnabled: false }]);
  return { version };
});
ready.catch(() => {});
const call = (method, params) => agent.call(method, [params]);
function target(id) { const s = sessions.get(id); if (!s) throw new Error('ZCode 会话不属于当前连接'); return s.target; }
async function command(id, type, payload) {
  const result = await call('sendConversationCommandV4', { ...target(id), envelope: { commandId: randomUUID(), clientId, sessionId: id, type, payload, issuedAt: Date.now() } });
  if (result.status === 'rejected' || result.accepted === false) throw new Error(result.message || result.reasonCode || 'ZCode 拒绝命令');
  return result;
}
function forwardEvent(id, event) {
  if (!sessions.has(id)) return;
  if (event.type === 'session.event') send({ method: 'session/event', params: event.event });
  if (event.type === 'permission.request') {
    const p = event.request, requestId = 'zcode-permission-' + randomUUID();
    reverse.set(requestId, { sessionId: id, nativeRequestId: p.requestId, options: p.options || [] });
    send({ id: requestId, method: 'interaction/requestPermission', params: { ...p, sessionId: id } });
  }
  if (event.type === 'userInput.request') void command(id, 'resolveInteraction', { interactionId: event.request.requestId, answer: { action: 'decline' } }).catch(() => {});
  if (event.type === 'providerRuntimeHeaders.request') {
    // Native request-auth normally resolves this inside the host. A challenge
    // requires the real desktop verification UI; never fabricate its result.
    void call('respondProviderRuntimeHeaders', { ...target(id), requestId: event.request.requestId,
      response: { headersApplied: false, errorMessage: '请在 ZCode 桌面完成账号验证后重试' } }).catch(() => {});
  }
}
async function handle(method, params = {}) {
  const { version } = await ready;
  if (method === 'workspace/readPresentation') return call('readWorkspacePresentation', { workspacePath: cwd });
  if (method === 'session/create') {
    const workspacePath = params.workspace?.workspacePath;
    if (!workspacePath || !path.isAbsolute(workspacePath) || !fs.statSync(workspacePath).isDirectory()) throw new Error('ZCode Agent 工作区不存在');
    // A mixed room shares a backend pool, but each member supplies its own
    // validated workspace. Bind subsequent calls to that session's path.
    const snapshot = await call('createSession', { workspacePath, mode: 'build', persistence: 'deferred', titleGenerationEnabled: false, mcpServers: params.mcpServers || [] });
    const id = snapshot.session?.sessionId; if (!id) throw new Error('ZCode 未返回会话 ID');
    sessions.set(id, { target: { workspacePath, sessionId: id }, subscription: null });
    return { ...snapshot, bridge: { name: 'agentschat-zcode-desktop', version: 1, hostVersion: version } };
  }
  const nativeTarget = target(params.sessionId);
  if (method === 'session/subscribe') {
    const session = sessions.get(params.sessionId);
    session.subscription ||= agent.listen('onDynamicSessionEvent', { ...nativeTarget, deliveryKind: 'desktop-continuous', includeSnapshot: false })(e => forwardEvent(params.sessionId, e));
    return {};
  }
  if (method === 'session/send') return call('sendPrompt', { ...nativeTarget, content: params.content, inputId: params.inputId, queryId: params.queryId });
  if (method === 'session/setModel') return call('setModel', { ...nativeTarget, model: params.model });
  if (method === 'session/setThoughtLevel') return call('setThoughtLevel', { ...nativeTarget, thoughtLevel: params.thoughtLevel });
  if (method === 'session/setMode') {
    if (params.mode !== 'build') throw new Error('首版 ZCode 桌面桥接只开放逐次确认');
    return call('readSession', nativeTarget); // create already pins build; do not mutate native workspace defaults.
  }
  if (method === 'session/stop') {
    await command(params.sessionId, 'stop', {});
    for (let i = 0; i < 60; i++) {
      const snapshot = await call('readSession', nativeTarget);
      if (!['running', 'waiting'].includes(snapshot.session?.status)) return {};
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('ZCode 尚未确认停止，请稍后重试');
  }
  if (method === 'session/close') {
    try { await call('closeSession', nativeTarget); return {}; }
    finally { sessions.get(params.sessionId)?.subscription?.dispose(); sessions.delete(params.sessionId); for (const [id, p] of reverse) if (p.sessionId === params.sessionId) reverse.delete(id); }
  }
  throw new Error('不支持的 ZCode 桌面桥接方法');
}
readline.createInterface({ input: connection }).on('line', line => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.id !== undefined && !frame.method) {
    const p = reverse.get(frame.id); if (!p) return; reverse.delete(frame.id);
    const option = p.options.find(o => frame.result?.decision === 'allow' ? o.kind === 'allow_once' : ['deny', 'reject_once'].includes(o.kind));
    void command(p.sessionId, 'resolveInteraction', { interactionId: p.nativeRequestId, answer: option ? { optionId: option.optionId } : { action: 'decline' } }).catch(() => {});
    return;
  }
  if (typeof frame.method !== 'string' || frame.id === undefined) return;
  void handle(frame.method, frame.params).then(result => send({ id: frame.id, result }), error => send({ id: frame.id, error: { code: -32000, message: failure(error) } }));
});
