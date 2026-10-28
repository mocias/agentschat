'use strict';
const fs = require('node:fs');
// Electron virtualizes ASAR paths; inspecting an archive itself needs raw disk I/O.
const archiveFs = process.versions.electron ? require('original-fs') : fs;
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { which, launchableFrom, nodeRunner, detectHarnesses, harnessIds, claudeCodeLaunch } = require('../lib/harnesses.cjs');
const { editions, isWorkbuddy, desktopLaunch } = require('./workbuddy.cjs');
const run = promisify(execFile);
const DSH_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isArchive = (p) => { try { return archiveFs.statSync(p).isFile(); } catch { return false; } };

// Read just an ASAR header, so discovery works both in plain Node and Electron.
function archiveHas(archive, entry) {
  let fd;
  try {
    fd = archiveFs.openSync(archive, 'r');
    const prefix = Buffer.alloc(16);
    if (archiveFs.readSync(fd, prefix, 0, 16, 0) !== 16) return false;
    const length = prefix.readUInt32LE(12);
    if (length < 2 || length > 32 * 1024 * 1024) return false;
    const data = Buffer.alloc(length);
    if (archiveFs.readSync(fd, data, 0, length, 16) !== length) return false;
    let node = JSON.parse(data.toString('utf8'));
    for (const part of entry.split('/')) node = node?.files?.[part];
    return Boolean(node && !node.files && !node.link);
  } catch { return false; } finally { if (fd !== undefined) archiveFs.closeSync(fd); }
}
function walk(root, accept, depth = 6, budget = 3500) {
  const hits = [];
  let visited = 0;
  function visit(dir, left) {
    if (left < 0 || visited >= budget) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })); } catch { return; }
    for (const entry of entries) {
      if (++visited > budget) break;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && accept(entry.name, full)) hits.push(full);
      else if (entry.isDirectory() && !['.git', 'Cache', 'GPUCache', 'logs'].includes(entry.name)) visit(full, left - 1);
    }
  }
  if (isDir(root)) visit(root, depth);
  return hits;
}
async function windowsInventory() {
  if (process.platform !== 'win32') return { rows: [], warning: '' };
  try {
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // File contents are static application code; user-supplied paths never become shell text.
    // EncodedCommand also works when the application script lives inside app.asar.
    const script = fs.readFileSync(path.join(__dirname, 'windows-harnesses.ps1'), 'utf8');
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    const rows = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
    return { rows: Array.isArray(rows) ? rows : [rows], warning: '' };
  } catch { return { rows: [], warning: '部分系统安装信息读取失败，仍可使用 PATH、常见目录或手动配置。' }; }
}
function normalizePath(value) {
  const expanded = String(value || '').trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (all, key) => process.env[key] || all);
  if (!path.isAbsolute(expanded)) throw new Error('请填写程序或安装目录的完整绝对路径');
  return path.normalize(expanded);
}
function normalizeProxy(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === false) return false;
  let url;
  try { if (typeof value !== 'string' || value.length > 2048) throw new Error(); url = new URL(value.trim()); }
  catch { throw new Error('代理地址必须是完整的 HTTP、HTTPS 或 SOCKS URL'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.pathname && url.pathname !== '/' || url.search || url.hash) {
    throw new Error('代理地址必须是 HTTP、HTTPS 或 SOCKS URL，不能包含账号密码、路径或查询参数');
  }
  return value.trim();
}
function dshLaunch(exe, home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')) {
  const archive = path.join(path.dirname(exe), 'resources', 'app.asar');
  if (!archiveHas(archive, DSH_ENTRY)) return null;
  const args = ['--expose-internals', path.join(archive, ...DSH_ENTRY.split('/')), '--profile', 'acp'];
  const profile = process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop');
  const patch = path.join(profile, 'dsh-peer-account-route.yml');
  if (isFile(patch)) args.push('--patch', patch);
  return { agentCommand: exe, agentArgs: args, env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, proxy: false };
}
function adapt(id, input, source = '手动指定', args) {
  let target = normalizePath(input);
  if (isDir(target)) {
    const names = id === 'zcode' ? /^zcode(?:-agent)?(?:\.exe|\.cmd|\.cjs)?$/i : id === 'claude' ? /^claude(?:\.exe|\.cmd)?$/i : isWorkbuddy(id) ? new RegExp('^' + editions[id].exe.replace('.', '\\.') + '$', 'i') : id === 'codex' ? /^(codex\.exe|codex)$/i : id === 'dsh' ? /^(DeepSeek Harness\.exe|dsh\.exe|dsh\.cmd)$/i : /^(qodercli(?:\.exe|\.cmd)?|qoder\.cmd|Qoder(?: CN)?\.exe)$/i;
    for (const candidate of walk(target, (name) => names.test(name))) {
      try { return adapt(id, candidate, source, args); } catch { /* Continue past desktop-only executables. */ }
    }
    throw new Error('该目录中没有找到可用的后端入口，请选择具体程序');
  }
  if (!isFile(target)) throw new Error('程序路径不存在，请重新选择');
  if (args !== undefined && (!Array.isArray(args) || args.length > 40 || args.some((x) => typeof x !== 'string' || x.length > 4096 || x.includes('\0')))) throw new Error('启动参数必须是字符串 JSON 数组');
  let launch;
  let kind = 'CLI';
  if (id === 'zcode') { launch = require('./zcode.cjs').zcodeLaunch(target, args); kind = launch.zcodeDesktop ? '桌面后端' : 'CLI'; }
  else if (isWorkbuddy(id)) { launch = desktopLaunch(id, target); kind = '桌面后端'; }
  else if (id === 'claude') {
    if (!/^(claude(?:\.exe|\.cmd|\.js)?|cli\.(?:js|cjs|mjs))$/i.test(path.basename(target)) && args === undefined) throw new Error('请选择终端版 Claude Code 的 claude 程序');
    launch = claudeCodeLaunch(target, args || []);
    if (launch.claudeDesktop) kind = '桌面 API 后端';
  }
  else if (id === 'dsh' && (launch = dshLaunch(target))) kind = '桌面后端';
  else if (id === 'qoder' && (launch = qoderDesktopLaunch(target))) kind = '桌面后端';
  else {
    if (!/\.(exe|cmd|bat|js|cjs|mjs)$/i.test(target) && process.platform === 'win32') throw new Error('请选择 exe、npm cmd 启动器或 JavaScript 入口');
    if (id === 'codex' && !/^codex(?:\.exe|\.cmd|\.js)?$/i.test(path.basename(target)) && args === undefined) throw new Error('请选择 codex 后端入口，而不是桌面窗口程序');
    if (id === 'codex' && args === undefined && isArchive(path.join(path.dirname(target), 'resources', 'app.asar'))) throw new Error('这是 Codex 桌面窗口程序，请选择其内置的 codex 后端入口');
    if (id === 'dsh' && !/^dsh(?:\.exe|\.cmd|\.js)?$/i.test(path.basename(target)) && args === undefined) throw new Error('找到了桌面程序，但缺少可识别的 DSH ACP 入口');
    if (id === 'qoder' && args === undefined && (!/^qoder(?:cli)?(?:\.exe|\.cmd|\.js)?$/i.test(path.basename(target)) || isArchive(path.join(path.dirname(target), 'resources', 'app.asar')))) throw new Error('该程序可能是 Qoder 桌面界面，请选择 qodercli 或在高级参数中明确指定 ACP 启动方式');
    const executable = /\.(js|cjs|mjs)$/i.test(target) ? { ...nodeRunner(), argv: [target] } : launchableFrom(target);
    if (!executable) throw new Error('无法解析启动器，请选择其实际 exe 或 JavaScript 入口');
    const defaults = id === 'dsh' ? ['--profile', 'acp'] : id === 'qoder' ? ['--acp'] : [];
    launch = id === 'codex'
      ? { codexPath: executable.binary, codexArgs: [...executable.argv, ...(args || [])], env: executable.env }
      : { agentCommand: executable.binary, agentArgs: [...executable.argv, ...(args || defaults)], env: executable.env, proxy: false };
  }
  if (kind === '桌面后端' && args !== undefined) launch.agentArgs = args;
  return { path: target, source, kind, launch };
}
function qoderDesktopLaunch(exe) {
  if (!/^Qoder(?: CN)?\.exe$/i.test(path.basename(exe))) return null;
  const resources = path.join(path.dirname(exe), 'resources');
  for (const sdk of ['qoder-cn-agent-sdk', 'qoder-agent-sdk']) {
    const entry = path.join(resources, 'app.asar.unpacked', 'node_modules', '@qoder-ai', sdk, 'dist', '_worker', 'qoder-worker-runtime.obf.mjs');
    if (!isFile(entry) || !archiveHas(path.join(resources, 'app.asar'), `node_modules/@qoder-ai/${sdk}/dist/index.js`)) continue;
    return { agentCommand: exe, agentArgs: [path.join(__dirname, 'qoder-worker.cjs'), entry], env: { ELECTRON_RUN_AS_NODE: '1' }, proxy: false };
  }
  return null;
}
class BackendDiscovery {
  constructor({ dir, inventory = windowsInventory, roots, legacy = {}, detect = detectHarnesses, lookup = which, allowAuto = true }) {
    this.allowAuto = allowAuto;
    this.dir = dir;
    this.file = path.join(dir, 'backend-preferences.json');
    this.inventory = inventory;
    this.roots = roots;
    this.detect = detect;
    this.lookup = lookup;
    this.legacy = legacy;
    this.preferences = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.cached = null;
    this.inflight = null;
  }
  async scan(force = false) {
    if (this.inflight) return this.inflight;
    if (!force && this.cached && Date.now() - this.cached.at < 60000) return this.cached.rows;
    this.inflight = this.discover().then((rows) => { this.cached = { at: Date.now(), rows }; return rows; }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async discover() {
    const inventory = this.allowAuto ? await this.inventory() : { rows: [], warning: '' };
    const rows = [];
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const local = process.env.LOCALAPPDATA || home;
    const roaming = process.env.APPDATA || home;
    const base = this.allowAuto ? this.detect() : [];
    for (const id of harnessIds()) {
      const candidates = [];
      const installed = [];
      const add = (p, source, args) => {
        if (!p) return;
        try { const candidate = adapt(id, p, source, args); if (!candidates.some((c) => c.path.toLowerCase() === candidate.path.toLowerCase())) candidates.push(candidate); }
        catch { if (isFile(p)) installed.push(p); }
      };
      const cliNames = id === 'zcode' ? ['zcode', 'zcode-agent'] : id === 'claude' ? ['claude'] : isWorkbuddy(id) ? [editions[id].exe] : id === 'codex' ? ['codex'] : id === 'dsh' ? ['dsh'] : ['qodercli', 'qoder'];
      if (id === 'codex') add(base.find((row) => row.id === id)?.binary, 'Codex 安装目录');
      if (this.allowAuto) for (const name of cliNames) add(this.lookup(name), 'PATH');
      const roots = this.roots?.[id] ? [...this.roots[id]] : (id === 'codex' ? [path.join(home, '.codex', 'packages', 'app-server-daemon', 'releases'), path.join(local, 'OpenAI', 'Codex'), path.join(roaming, 'npm', 'node_modules', '@openai', 'codex')] : id === 'dsh' ? [path.join(local, 'Programs', 'DeepSeek Harness'), path.join(local, 'DeepSeek Harness'), path.join(roaming, 'npm')] : [path.join(home, '.qoder', 'bin'), path.join(home, '.local', 'bin'), path.join(local, 'Programs', 'Qoder'), path.join(roaming, 'npm')]);
      if (isWorkbuddy(id) && !this.roots?.[id]) roots.splice(0, roots.length, path.join(local, 'Programs', id === 'workbuddy' ? 'WorkBuddy' : 'WorkBuddyAI'), path.join(local, id));
      if (id === 'claude' && !this.roots?.[id]) roots.splice(0, roots.length, path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(roaming, 'npm'));
      if (id === 'zcode' && !this.roots?.[id]) roots.splice(0, roots.length, path.join(local, 'Programs', 'ZCode'), path.join(local, 'ZCode'));
      const pattern = id === 'zcode' ? /zcode/i : id === 'claude' ? /claude/i : isWorkbuddy(id) ? /workbuddy/i : id === 'codex' ? /codex/i : id === 'dsh' ? /deepseek|\bdsh\b/i : /qoder/i;
      for (const item of inventory.rows) {
        if (!pattern.test(item.name || '')) continue;
        add(item.exe, item.source);
        for (const root of [item.location, item.exe && path.dirname(item.exe)]) if (root && isDir(root) && !roots.includes(root)) roots.push(root);
      }
      const namePattern = id === 'zcode' ? /^zcode(?:-agent)?(?:\.exe|\.cmd|\.cjs)?$/i : id === 'claude' ? /^claude(?:\.exe|\.cmd)?$/i : isWorkbuddy(id) ? new RegExp('^' + editions[id].exe.replace('.', '\\.') + '$', 'i') : id === 'codex' ? /^codex(?:\.exe|\.cmd)?$/i : id === 'dsh' ? /^(DeepSeek Harness\.exe|dsh(?:\.exe|\.cmd)?)$/i : /^(qodercli(?:\.exe|\.cmd)?|qoder\.cmd|Qoder(?: CN)?\.exe)$/i;
      if (this.allowAuto) for (const root of roots) for (const file of walk(root, (name) => namePattern.test(name))) add(file, '安装目录扫描');
      if (id === 'codex') {
        const running = new Set(inventory.rows.filter(row => row.source === '运行中的进程' && row.exe).map(row => path.normalize(row.exe).toLowerCase()));
        const rank = candidate => {
          const file = candidate.path.replace(/\\/g, '/').toLowerCase();
          const managed = file.includes('/.codex/packages/app-server-daemon/releases/');
          const desktop = managed || file.includes('/openai/codex/bin/') || /\/windowsapps\/openai\.codex_[^/]+\/app\/resources\/codex\.exe$/.test(file);
          if (desktop && running.has(path.normalize(candidate.path).toLowerCase())) return managed ? 0 : 1;
          return desktop ? (managed ? 2 : 3) : 4;
        };
        candidates.sort((a, b) => rank(a) - rank(b) || (rank(a) < 4 ? b.path.localeCompare(a.path, undefined, { numeric: true }) : 0));
      }
      if (id === 'qoder') {
        const running = new Set(inventory.rows.filter(r => r.source === '运行中的进程').map(r => r.exe?.toLowerCase()));
        const rank = c => c.kind === '桌面后端' ? (running.has(c.path.toLowerCase()) ? 0 : 1) : 2;
        candidates.sort((a, b) => rank(a) - rank(b));
      }
      let selected = candidates[0] || null;
      let error = '';
      const preference = this.preferences[id]?.automatic ? null : this.preferences[id];
      if (preference) {
        try {
          if (!this.allowAuto && isDir(preference.path)) throw new Error('手动模式请选择具体程序文件，不扫描目录');
          selected = adapt(id, preference.path, '手动指定', preference.args);
          const proxy = normalizeProxy(preference.proxy);
          if (proxy !== undefined) {
            if (isWorkbuddy(id)) throw new Error('WorkBuddy 使用桌面现有网络配置，请在其桌面应用中设置代理');
            selected.launch.proxy = proxy;
          }
        }
        catch (failure) { selected = null; error = '手动配置已失效：' + failure.message; }
      } else if (!this.preferences[id]?.automatic) {
        const old = this.legacy.backends?.[id];
        const oldPath = id === 'codex' ? (this.legacy.codexPath || old?.codexPath) : old?.agentCommand;
        if (oldPath) {
          try { if (!this.allowAuto && isDir(oldPath)) throw new Error('手动模式请选择具体程序文件'); selected = adapt(id, oldPath, '已有 backends.json 配置', id === 'codex' ? old?.codexArgs : old?.agentArgs); selected.launch = { ...selected.launch, ...old, ...(id === 'codex' ? { codexPath: oldPath } : {}) }; }
          catch (failure) { selected = null; error = '已有配置不可用：' + failure.message; }
        }
      }
      const label = id === 'claude' ? 'Claude Code' : isWorkbuddy(id) ? editions[id].label : id === 'dsh' ? 'DSH' : id === 'codex' ? 'Codex' : 'Qoder';
      rows.push({ id, label, found: Boolean(selected), configured: Boolean(preference), binary: selected?.launch.codexPath || selected?.launch.agentCommand || null,
        status: selected ? 'detected' : error ? 'invalid' : installed.length ? 'installed' : 'missing',
        detail: error || (selected ? `已找到${selected.kind}入口；连接与登录尚未验证` : id === 'claude' && installed.length ? '已发现 Claude 桌面应用，请先配置 Gateway API 并准备 Code，或选择终端版 claude 程序' : installed.length ? '已找到桌面程序，但未识别到聊天后端，请手动补充' : '未发现后端，请手动选择程序或安装目录'),
        selected, candidates, preference: preference || null, warning: inventory.warning });
    }
    return rows;
  }
  async save(id, value) {
    if (this.inflight) await this.inflight;
    if (!harnessIds().includes(id)) throw new Error('不支持的后端');
    const next = { ...this.preferences };
    if (value === null) next[id] = { automatic: true };
    else {
      if (!this.allowAuto && isDir(normalizePath(value.path))) throw new Error('手动模式请选择具体程序文件，不扫描安装目录');
      const candidate = adapt(id, value.path, '手动指定', value.args);
      const proxy = normalizeProxy(value.proxy);
      if (isWorkbuddy(id) && proxy !== undefined) throw new Error('WorkBuddy 使用桌面现有网络配置，请在其桌面应用中设置代理');
      next[id] = { path: normalizePath(value.path), ...(value.args === undefined ? {} : { args: value.args }), ...(proxy === undefined ? {} : { proxy }) };
      if (!candidate.launch) throw new Error('没有可用启动方式');
    }
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(this.file + '.tmp', this.file);
    this.preferences = next;
    this.cached = null;
    return this.scan(true);
  }
  publicRows(rows) {
    return rows.map(({ selected, candidates, ...row }) => ({ ...row, selected: selected && { path: selected.path, source: selected.source, kind: selected.kind }, candidates: candidates.map(({ path, source, kind }) => ({ path, source, kind })) }));
  }
}
module.exports = { BackendDiscovery, windowsInventory, adapt, archiveHas, walk };
