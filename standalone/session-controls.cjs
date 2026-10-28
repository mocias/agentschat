'use strict';
const path = require('node:path');
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
const { prepareDshControls } = require('./dsh-session-controls.cjs');

const permissionLabels = { 'read-only': '只读', 'workspace-write': '工作区内修改', 'danger-full-access': '完整访问' };
const presetLabels = { standard: '标准模式', ptc: '程序化工具模式', minimal: '精简模式', cordis: 'Cordis 模式', default: '默认模式', plan: '规划模式' };
function defaultSessionConfig(backend) {
  if (backend === 'qoder') return { permission: 'default', preset: 'native' };
  if (backend === 'zcode') return { permission: 'build', preset: 'native' };
  return ['codex', 'dsh'].includes(backend) ? { permission: 'read-only', preset: backend === 'dsh' ? 'standard' : 'default' } : null;
}
async function querySessionControls(backend, launch, cwd, root) {
  if (!defaultSessionConfig(backend)) throw new Error('此后端暂未接入会话配置');
  let bridge, pool;
  try {
    if (['qoder', 'zcode'].includes(backend)) {
      const Pool = backend === 'zcode' ? require('../lib/zcode-pool.cjs').ZcodePool : AcpPool;
      pool = new Pool({ ...launch, cwd }); await pool.start();
      const session = await pool.request('session/new', { cwd, mcpServers: [] });
      try {
        const option = session.configOptions?.find(o => o.category === 'mode' && o.id === 'mode');
        const labels = { default: '逐次确认', acceptEdits: '自动批准编辑', auto: '原生安全判断', dontAsk: '拒绝未授权操作', yolo: '跳过权限确认', plan: '规划（原生限制）', build: '逐次确认' };
        const permissions = (option?.options || []).filter(o => typeof o.value === 'string').map(o => ({ id: o.value, label: labels[o.value] || o.name || o.value, ...(o.value === 'yolo' ? { requiresConfirmation: true } : {}) }));
        if (!permissions.some(p => p.id === defaultSessionConfig(backend).permission)) throw new Error('此后端版本未提供默认的原生权限模式');
        return { backend, presets: [{ id: 'native', label: '原生会话' }], permissions, defaultConfig: defaultSessionConfig(backend), source: backend === 'qoder' ? 'Qoder ACP 模式目录' : 'ZCode app-server（build）', note: '原生模式不是操作系统沙箱；工具仍受原生规则约束。' };
      } finally { if (pool.info?.agentCapabilities?.sessionCapabilities?.close) await pool.request('session/close', { sessionId: session.sessionId }); }
    }
    bridge = backend === 'dsh' ? prepareDshControls(launch, path.join(root, 'session-controls')) : null;
    pool = backend === 'codex' ? new CodexThreadPool({ ...launch, cwd }) : new AcpPool({ ...bridge.launch, cwd });
    await pool.start();
    if (bridge) {
      const data = await bridge.request('/catalog');
      return { backend, presets: data.presets.presets.map(p => ({ id: p.id, label: p.name || presetLabels[p.id] || p.id, ...(p.broken ? { unavailable: p.broken } : {}), isDefault: p.isDefault })),
        permissions: data.permissions.options.map(p => ({ id: p.value, label: permissionLabels[p.value] || p.name })),
        defaultConfig: defaultSessionConfig(backend), source: 'DSH 原生预设与权限服务' };
    }
    const [modes, requirements] = await Promise.all([pool.request('collaborationMode/list', {}), pool.request('configRequirements/read', {})]);
    const constraints = requirements.requirements;
    const approvals = constraints?.allowedApprovalPolicies;
    const sandboxes = constraints?.allowedSandboxModes;
    const permissions = Object.keys(permissionLabels).filter(id => (!sandboxes || sandboxes.includes(id)) && (!approvals || approvals.includes(id === 'danger-full-access' ? 'never' : 'on-request')))
      .map(id => ({ id, label: permissionLabels[id] }));
    return { backend, presets: (modes.data || []).filter(m => ['default', 'plan'].includes(m.mode)).map(m => ({ id: m.mode, label: presetLabels[m.mode] || m.name })), permissions,
      defaultConfig: defaultSessionConfig(backend), source: 'Codex app-server 协作模式与管理约束' };
  } finally { await pool?.stop(); bridge?.dispose(); }
}
function validateSessionConfig(value, capabilities) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['permission', 'preset'].includes(key))) throw new Error('无效的会话配置');
  for (const [key, list] of [['permission', capabilities.permissions], ['preset', capabilities.presets]]) {
    const row = list.find(p => p.id === value[key]);
    if (!row || row.unavailable) throw new Error(key === 'preset' ? '所选预设在当前后端不可用' : '所选权限被后端限制或不支持');
  }
  return { permission: value.permission, preset: value.preset };
}
module.exports = { defaultSessionConfig, querySessionControls, validateSessionConfig };
