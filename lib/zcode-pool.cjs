'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { NativeModePool } = require('../standalone/native-mode-pool.cjs');

const modeLabels = { build: '逐次确认' };
const modelId = ref => ref?.providerId && ref?.modelId ? `${ref.providerId}/${ref.modelId}` : '';
const workspace = cwd => ({ workspacePath: cwd, workspaceKey: 'agentschat-' + createHash('sha256').update(cwd).digest('hex').slice(0, 24) });

// Reuse the pool's NDJSON transport and room lifecycle, translating at the
// boundary. ZCode Protocol v1 is not ACP or Codex app-server.
class ZcodePool extends NativeModePool {
  constructor(options = {}) { super(options); this.nativeSessions = new Map(); this.nativeTurns = new Map(); }
  async start() {
    if (this.commandOptions.zcodeDesktop && !this.hostTransport) {
      this.hostTransportReady ||= require('../standalone/zcode-host-transport.cjs').createHostTransport();
      this.hostTransport = await this.hostTransportReady;
      this.spawnChild = this.hostTransport.spawnChild;
    }
    try { return await super.start(); } catch (error) { await this.stop(); throw error; }
  }
  write(frame) { const { jsonrpc, ...native } = frame; return super.write(native); }
  nativeRequest(method, params, options) { return super.request(method, params, options || { timeoutMs: this.commandOptions.zcodeDesktop ? 60000 : 30000 }); }
  async request(method, params = {}, options) {
    if (method === 'initialize') {
      await this.nativeRequest('workspace/readPresentation', { workspace: workspace(this.cwd) });
      return { protocolVersion: 1, agentInfo: { name: 'zcode', title: 'ZCode' }, agentCapabilities: { sessionCapabilities: { close: {} } } };
    }
    if (method === 'session/new') {
      const snapshot = await this.nativeRequest('session/create', { workspace: workspace(params.cwd || this.cwd), persistence: 'deferred',
        mode: 'build', titleGenerationEnabled: false, mcpServers: params.mcpServers || [] });
      const id = snapshot.session?.sessionId;
      const native = snapshot.protocol?.name === 'ZCode Protocol' && snapshot.protocol.version === 1;
      const desktop = this.commandOptions.zcodeDesktop && snapshot.bridge?.name === 'agentschat-zcode-desktop' && snapshot.bridge.version === 1 && snapshot.bridge.hostVersion === '3.16.3';
      if (!id || !native && !desktop) throw new Error('不支持此 ZCode 协议版本');
      this.nativeSessions.set(id, snapshot);
      try {
        // Verify the underlying build policy; the plan overlay is not exposed
        // as a distinct mode by this version's legacy session snapshot.
        const applied = await this.nativeRequest('session/setMode', { sessionId: id, mode: 'build' });
        this.remember(id, applied);
        if (this.nativeSessions.get(id).settings?.mode?.current !== 'build') throw new Error('ZCode 没有应用逐次确认模式，已阻止发送');
        return { sessionId: id, configOptions: this.configOptions(id) };
      } catch (error) { await this.request('session/close', { sessionId: id }).catch(() => {}); throw error; }
    }
    if (method === 'session/set_config_option') {
      const { sessionId, configId, value } = params;
      let nativeMethod, fields;
      if (configId === 'model') {
        const match = this.nativeSessions.get(sessionId)?.settings?.model?.available?.find(m => modelId(m.ref) === value);
        if (!match || match.disabledReason) throw new Error('ZCode 未提供可用的所选模型；请检查原生模型配置');
        const settings = this.nativeSessions.get(sessionId).settings;
        const current = settings.model.current || settings.model.lastUsed;
        const reasoningLevel = modelId(current) === value ? (current.options?.reasoningLevel || settings.thoughtLevel?.current || settings.thoughtLevel?.defaultLevel) : match.reasoning?.defaultLevel;
        nativeMethod = 'session/setModel'; fields = { model: { ...match.ref, ...(reasoningLevel ? { options: { ...match.ref.options, reasoningLevel } } : {}) } };
      } else if (configId === 'mode' && Object.hasOwn(modeLabels, value)) { nativeMethod = 'session/setMode'; fields = { mode: value }; }
      else if (configId === 'thought_level') { nativeMethod = 'session/setThoughtLevel'; fields = { thoughtLevel: value }; }
      else throw new Error('ZCode 不支持此会话选项');
      this.remember(sessionId, await this.nativeRequest(nativeMethod, { sessionId, ...fields }));
      return { configOptions: this.configOptions(sessionId) };
    }
    if (method === 'session/close') {
      try { return await this.nativeRequest(method, params, { timeoutMs: 5000 }); }
      finally { this.nativeSessions.delete(params.sessionId); this.settleTurn(params.sessionId, new Error('ZCode 会话已关闭')); }
    }
    if (method === 'session/prompt') return this.prompt(params);
    return this.nativeRequest(method, params, options);
  }
  remember(id, result) {
    const snapshot = result?.snapshot || result;
    if (snapshot?.settings) {
      const previous = this.nativeSessions.get(id);
      // setModel may return only the current model. Preserve the queried catalog.
      const available = previous?.settings?.model?.available || snapshot.settings.model?.available || [];
      this.nativeSessions.set(id, { ...snapshot, settings: { ...snapshot.settings, model: { ...snapshot.settings.model, available } } });
    }
  }
  configOptions(id) {
    const settings = this.nativeSessions.get(id)?.settings || {};
    const modes = [{ value: 'build', name: modeLabels.build }];
    // Plan is an overlay in newer runtimes and is not verifiable through this v1 snapshot.
    const config = [{ id: 'mode', category: 'mode', type: 'select', currentValue: settings.mode?.current, options: modes },
      { id: 'model', category: 'model', type: 'select', currentValue: modelId(settings.model?.current || settings.model?.lastUsed),
        options: (settings.model?.available || []).filter(m => modelId(m.ref) && !m.disabledReason).map(m => ({ value: modelId(m.ref), name: m.name || m.label || modelId(m.ref) })) }];
    if (settings.thoughtLevel?.available?.length) config.push({ id: 'thought_level', category: 'thought_level', type: 'select',
      currentValue: settings.thoughtLevel.current || settings.thoughtLevel.defaultLevel, options: settings.thoughtLevel.available.map(e => ({ value: e.value, name: e.label || e.value })) });
    return config;
  }
  async prompt({ sessionId, prompt }) {
    if (this.nativeTurns.has(sessionId)) throw new Error('ZCode 会话正在回复');
    await this.nativeRequest('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: false });
    let entry;
    const done = new Promise((resolve, reject) => { entry = { resolve, reject, queryId: randomUUID() }; });
    done.catch(() => {});
    this.nativeTurns.set(sessionId, entry);
    try {
      await this.nativeRequest('session/send', { sessionId, queryId: entry.queryId, inputId: entry.queryId, content: prompt.map(p => p.text || '').join('\n') });
      return await done;
    } catch (error) {
      this.settleTurn(sessionId, error);
      if (/timed out/i.test(error.message)) {
        // Acceptance is unknown. Release this exact native session before the
        // user can send again; never replay the uncertain prompt automatically.
        await this.request('session/close', { sessionId }).catch(() => {});
        for (const [key, thread] of this.threads) if (thread.id === sessionId) this.threads.delete(key);
      }
      throw error;
    }
  }
  settleTurn(id, error, cancelled = false) {
    const pending = this.nativeTurns.get(id); if (!pending) return;
    this.nativeTurns.delete(id);
    if (pending.cancelRequested) { pending.resolve({ stopReason: 'cancelled' }); return; }
    if (error) pending.reject(error); else pending.resolve({ stopReason: cancelled ? 'cancelled' : 'end_turn' });
  }
  notify(method, params) {
    if (method === 'session/cancel') {
      const pending = this.nativeTurns.get(params.sessionId); if (pending) pending.cancelRequested = true;
      void this.nativeRequest('session/stop', { sessionId: params.sessionId }, { timeoutMs: 5000 })
        .then(() => { if (this.nativeTurns.get(params.sessionId) === pending) this.settleTurn(params.sessionId, null, true); },
          error => { if (this.nativeTurns.get(params.sessionId) === pending) this.settleTurn(params.sessionId, error); });
      return;
    }
    super.notify(method, params);
  }
  _dispatch(frame) {
    if (frame.method === 'session/event' && frame.id === undefined) {
      const event = frame.params, pending = this.nativeTurns.get(event?.sessionId);
      if (!pending) return;
      if (event.queryId && event.queryId !== pending.queryId) return;
      const payload = event.payload || {};
      if (payload.inputId && payload.inputId !== pending.queryId) return;
      if (event.type === 'turn.started') { pending.turnId = event.turnId; return; }
      if (event.turnId && (!pending.turnId || event.turnId !== pending.turnId)) return;
      if (payload.parentToolUseId || payload.parentToolCallId) return;
      if (event.type === 'model.streaming' && ['text_delta', 'reasoning_delta'].includes(payload.kind) && typeof payload.delta === 'string') {
        super._dispatch({ method: 'session/update', params: { sessionId: event.sessionId, update: {
          sessionUpdate: payload.kind === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk', content: { type: 'text', text: payload.delta } } } });
      }
      if (event.type === 'tool.updated') super._dispatch({ method: 'session/update', params: { sessionId: event.sessionId, update: {
        sessionUpdate: 'tool_call_update', toolCallId: payload.toolCallId, title: payload.toolName || payload.name || 'ZCode 工具',
        status: payload.kind === 'result' ? 'completed' : payload.kind === 'error' ? 'failed' : 'in_progress' } } });
      if (event.type === 'turn.completed') this.settleTurn(event.sessionId);
      if (event.type === 'turn.failed') this.settleTurn(event.sessionId, new Error(String(payload.message || payload.error?.message || 'ZCode 本轮执行失败')));
      return;
    }
    super._dispatch(frame);
  }
  async _answerServerRequest(frame) {
    let result;
    try {
      if (frame.method === 'session/requestRuntimePreferences') result = { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false };
      else if (frame.method === 'interaction/requestPermission') {
        const p = frame.params || {};
        const outcome = this.permissionRequestHandler && this.nativeSessions.has(p.sessionId)
          ? await this.permissionRequestHandler({ sessionId: p.sessionId, options: p.options || [], toolCall: { toolCallId: p.toolCallId, title: p.toolName, description: JSON.stringify(p.input || {}).slice(0, 4000) } }) : null;
        const selected = (p.options || []).find(o => o.optionId === outcome?.outcome?.optionId && o.kind === 'allow_once');
        result = { decision: selected ? 'allow' : 'deny' };
      } else { this.write({ id: frame.id, error: { code: -32601, message: '此 ZCode 客户端能力尚未接入' } }); return; }
      this.write({ id: frame.id, result });
    } catch { this.write({ id: frame.id, error: { code: -32603, message: '客户端请求处理失败' } }); }
  }
  _onDeath() { for (const id of this.nativeTurns.keys()) this.settleTurn(id, new Error('ZCode 进程已退出')); this.nativeSessions.clear(); this.hostTransport?.close(); this.hostTransport = null; this.hostTransportReady = null; super._onDeath(); }
  async stop() { for (const id of this.nativeTurns.keys()) this.settleTurn(id, new Error('ZCode 已停止')); try { await super.stop(); } finally { this.nativeSessions.clear(); this.hostTransport?.close(); this.hostTransport = null; this.hostTransportReady = null; } }
}
module.exports = { ZcodePool, modelId, workspace };
