'use strict';
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
const { harnessIds } = require('../lib/harnesses.cjs');
const { WorkbuddyPool } = require('../lib/workbuddy-pool.cjs');
function choices(option) {
  return (option?.options || []).flatMap(group => Array.isArray(group.options)
    ? group.options.map(item => ({ ...item, provider: group.name || group.group })) : [group]);
}
async function queryModels(id, launch, cwd, selected) {
  if (!harnessIds().includes(id)) throw new Error('该后端尚未接入模型查询');
  const Pool = id === 'zcode' ? require('../lib/zcode-pool.cjs').ZcodePool : id === 'codex' ? CodexThreadPool : launch?.workbuddySupervisor ? WorkbuddyPool : AcpPool;
  const pool = new Pool({ ...launch, cwd });
  try {
    await pool.start();
    if (id === 'codex') {
      const models = (await pool.listModels()).filter(m => !m.hidden).map(m => ({ id: m.model || m.id, name: m.displayName || m.id,
        efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort || null, isDefault: Boolean(m.isDefault) }));
      if (selected && !models.some(m => m.id === selected)) throw new Error('所选模型已不在后端列表中');
      return { models, selected: selected || models.find(m => m.isDefault)?.id || models[0]?.id };
    }
    const session = await pool.request('session/new', { cwd, mcpServers: [] });
    let config = session.configOptions || [];
    const modelOption = config.find(o => o.category === 'model');
    const models = choices(modelOption).map(m => ({ id: m.value, name: m.name || m.value, provider: m.provider || '', efforts: [], defaultEffort: null }));
    const wanted = selected || (pool.desktopCatalogStatus?.source === 'desktop-cache' && !models.some(m => m.id === modelOption?.currentValue) ? models[0]?.id : modelOption?.currentValue);
    if (!models.some(m => m.id === wanted)) throw new Error(id === 'zcode' ? 'ZCode app-server 未返回可用模型。请先在原生 ZCode CLI 配置模型/登录；桌面登录不等于 CLI 模型已就绪。' : '后端没有返回可用的所选模型');
    // Claude exposes no model-dependent effort options. A catalogue read must
    // not call set_model (the CLI may validate it with an upstream request).
    // Access and the fixed model are still enforced when opening the real chat.
    if (id !== 'claude' && (selected || wanted !== modelOption?.currentValue)) {
      const updated = await pool.request('session/set_config_option', { sessionId: session.sessionId, configId: modelOption.id, value: wanted });
      if (updated.configOptions) config = updated.configOptions;
    }
    const effortOption = config.find(o => o.category === 'thought_level');
    const active = models.find(m => m.id === wanted);
    active.efforts = choices(effortOption).map(e => e.value).filter(Boolean);
    active.defaultEffort = effortOption?.currentValue || null;
    if (pool.info?.agentCapabilities?.sessionCapabilities?.close) await pool.request('session/close', { sessionId: session.sessionId });
    return { models, selected: wanted, ...(pool.desktopCatalogStatus ? { catalog: pool.desktopCatalogStatus } : {}) };
  } finally { await pool.stop(); }
}
module.exports = { queryModels };
