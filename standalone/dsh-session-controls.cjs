'use strict';
// Scoped to the ACP child launched by this app; never modifies a DSH profile.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function prepareDshControls(launch, root) {
  if (!launch?.agentCommand || !Array.isArray(launch.agentArgs)) throw new Error('DSH 启动入口不可用');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'dsh-controls-'));
  const cli = launch.agentArgs.find(arg => /[\\/]dsh[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]/.test(arg));
  if (!cli) throw new Error('此 DSH 入口未提供可读取的原生预设目录');
  const nativeRoot = cli.slice(0, cli.indexOf('dsh-desktop-host')) + 'dsh-web-app';
  // Read installed recipes with DSH's own Electron filesystem support (ASAR).
  execFileSync(launch.agentCommand, [__filename, '--prepare', dir, nativeRoot], {
    env: { ...process.env, ...launch.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 15000, stdio: 'pipe',
  });
  const recipes = JSON.parse(fs.readFileSync(path.join(dir, 'recipes.json'), 'utf8'));
  const token = randomBytes(32).toString('hex'), endpoint = path.join(dir, 'endpoint.json');
  const shim = path.join(dir, 'plugin.mjs'), patch = path.join(dir, 'patch.yml');
  fs.writeFileSync(shim, `import { createRequire } from 'node:module';\nconst bridge = createRequire(import.meta.url)(${JSON.stringify(__filename)});\nexport const inject = ['agents', 'agentPresets', 'permissionPresets'];\nexport const apply = bridge.apply;\n`);
  fs.writeFileSync(patch, JSON.stringify([{ insert: [{ id: 'agentschat-session-controls', name: shim, config: { token, endpoint } }] }]));
  const request = async (route, body) => {
    let info;
    for (let i = 0; i < 150; i++) {
      try { info = JSON.parse(fs.readFileSync(endpoint, 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!info) throw new Error('DSH 会话配置服务未就绪；请检查当前 DSH 版本是否提供原生预设和权限服务');
    const response = await fetch(`http://127.0.0.1:${info.port}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'DSH 配置失败'); return data;
  };
  return { launch: { ...launch, agentArgs: [...launch.agentArgs, ...recipes.flatMap(file => ['--patch', file]), '--patch', patch] }, request,
    resetEndpoint() { fs.rmSync(endpoint, { force: true }); },
    dispose() {
      const parent = path.resolve(root), target = path.resolve(dir);
      if (!target.startsWith(parent + path.sep) || !path.basename(target).startsWith('dsh-controls-')) throw new Error('Invalid control directory');
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Linked control directory');
      fs.rmSync(target, { recursive: true, force: true });
    } };
}

function apply(ctx, config) {
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + config.token || req.headers.origin) return reply(res, 403, { error: 'Unauthorized' });
    try {
      if (req.method === 'GET' && req.url === '/catalog') return reply(res, 200, {
        presets: await ctx.agentPresets.remoteExportList(), permissions: ctx.permissionPresets.catalog(),
      });
      if (req.method !== 'POST' || req.url !== '/session') return reply(res, 404, { error: 'Unknown operation' });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw new Error('Request too large'); }
      const body = JSON.parse(raw), agent = ctx.agents.get(body.sessionId);
      if (!agent) throw new Error('会话不属于当前 DSH 进程');
      if (body.preset !== undefined) await ctx.agentPresets.select(agent, body.preset);
      if (body.permission !== undefined) ctx.permissionPresets.set(agent.session, body.permission);
      reply(res, 200, { preset: ctx.agentPresets.composedPreset(agent.ctx), permission: ctx.permissionPresets.current(agent.session) });
    } catch (error) { reply(res, 400, { error: error.message }); }
  });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(config.endpoint, JSON.stringify({ port: server.address().port })));
  ctx.effect(() => () => { server.closeAllConnections?.(); server.close(); });
}
module.exports = { prepareDshControls, apply };

if (require.main === module && process.argv[2] === '--prepare') {
  const [dir, nativeRoot] = process.argv.slice(3);
  const manifest = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'package.json'), 'utf8'));
  const patches = manifest.dsh?.bundle?.patch;
  if (!Array.isArray(patches)) throw new Error('DSH 未提供可识别的原生预设清单');
  const presets = patches.filter(file => /^\.\/presets\/[^/]+\.patch\.yml$/.test(file)).map(file => path.join(nativeRoot, file));
  if (!presets.length || !presets.some(file => path.basename(file) === 'standard.patch.yml')) throw new Error('DSH 标准预设不可用');
  for (const file of presets) fs.accessSync(file);
  const transition = path.join(dir, 'preset-plane.yml');
  const ids = ['tool-plugin-manager', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'agent-instructions', 'tool-todo', 'tool-web'];
  fs.writeFileSync(transition, JSON.stringify([...ids.map(id => ({ id, disabled: true })), { insert: [{ id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' }, { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } }] }]));
  fs.writeFileSync(path.join(dir, 'recipes.json'), JSON.stringify([transition, ...presets]));
}
