'use strict';
/**
 * The harness registry: which agent harnesses a room can put a member on.
 *
 * Until now the add-member form offered a *protocol* ("acp") as if it were a
 * product. That is the wrong noun for a user: "acp" is how we talk to an agent,
 * not which agent it is, and a roster entry reading `backend: "acp"` says
 * nothing about whether the member will be DSH, Qoder or something else. This
 * module replaces the protocol name with concrete, per-harness identities.
 *
 * Two things are deliberately kept apart:
 *
 *   1. **Protocol** — the wire format the pool speaks. Only two exist:
 *      `codex-app-server` (codex-pool.cjs) and `acp` (acp-backend.cjs). Several
 *      harnesses share the ACP implementation, which is the whole point of
 *      having written it as a protocol rather than as "the DSH backend".
 *   2. **Harness** — the product, with its own id, label, launch line and
 *      detection rule. `dsh` and `qoder` are both ACP harnesses; they differ
 *      only in what binary is started and with which arguments.
 *
 * Native ACP products use descriptors below. Claude Code uses a local bridge
 * from its stream-json CLI to ACP; its desktop executable is not a CLI entry.
 *
 * ## Launching on Windows, which is where the design is constrained
 *
 * Node's `spawn` does not perform PATHEXT lookup, so `spawn('qoder', [...])`
 * fails with ENOENT even when `qoder.cmd` is on PATH; and since Node 20,
 * spawning a `.cmd`/`.bat` without a shell throws `EINVAL` outright. The
 * remaining escape hatch, `{ shell: true }`, is deprecated for argument
 * injection reasons (DEP0190) and mangles any argument containing a space or a
 * quote.
 *
 * So a harness's launcher is always resolved to something that can be spawned
 * directly:
 *
 *   - a native `.exe` (codex's vendor binary, or DSH's own Electron executable);
 *   - or `node <entry.js>`, where an npm `.cmd` shim is *parsed* to recover the
 *     JS entry point it would have run.
 *
 * Nothing here is machine-specific. Paths come from `process.execPath`,
 * `process.resourcesPath`, `DSH_HOME` and PATH, so the shipped plugin stays
 * generic and the personal launch line stays in the profile layer.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_CODEX = 'codex-app-server';
const PROTOCOL_ACP = 'acp';

const WIN = process.platform === 'win32';

/**
 * Backend names that shipped before the registry, and what they now mean.
 *
 * Built with a null prototype so a lookup can never reach `Object.prototype`.
 * With a plain object literal, `LEGACY_BACKENDS['constructor']` returns the
 * `Object` function and `['__proto__']` returns an object: a member or config
 * naming a backend `constructor` would then resolve to a non-string, be used as
 * a pool key, and fail somewhere far from the cause. A null prototype makes the
 * lookup answer only for the keys actually listed.
 */
const LEGACY_BACKENDS = Object.assign(Object.create(null), { acp: 'dsh', 'dsh-acp': 'dsh' });

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** The extensions `cmd.exe` would try, in its own precedence order. */
function pathExtensions() {
  if (!WIN) return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ['', ...exts];
}

/**
 * Absolute-path lookup of a bare command name across PATH.
 *
 * On Windows an *extensionless* hit is skipped: npm installs a POSIX shell
 * script (`codex`, no extension) beside every `.cmd`, and that file is not
 * executable there. Returning it would produce a launcher that always fails,
 * which is worse than reporting "not found".
 */
function which(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return isFile(name) ? name : null;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = pathExtensions();
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      if (WIN && ext === '') continue;
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Recover the JS entry point an npm `.cmd` shim would have executed.
 *
 * Every shim npm writes ends in a line like
 *   `"%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`
 * so the entry is the `.js` path relative to the shim's own directory. Parsing
 * it is what makes a shim-only install launchable without a shell.
 */
function shimEntryPoint(shim) {
  let text;
  try {
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(/"[%~]*dp0%\\([^"]+?\.(?:js|cjs|mjs))"/i);
  if (!match) return null;
  const entry = path.join(path.dirname(shim), match[1]);
  return isFile(entry) ? entry : null;
}

/**
 * A `node` that can be spawned directly, plus the env that makes it node.
 *
 * Preference order matters. A real `node.exe` beside the running executable is
 * the bundled DSH runtime and is the most predictable choice. Falling back to
 * `process.execPath` means "we are running inside the Electron desktop host",
 * which only behaves as node with `ELECTRON_RUN_AS_NODE=1`.
 */
function nodeRunner() {
  const beside = path.join(path.dirname(process.execPath), WIN ? 'node.exe' : 'node');
  if (isFile(beside)) return { binary: beside, env: {} };
  const onPath = which('node');
  if (onPath) return { binary: onPath, env: {} };
  return { binary: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * Turn a discovered launcher into a spawnable `{ binary, argv, env }`.
 *
 * Returns null when the hit is a `.ps1` or an unusable shim, so callers can
 * report "installed but not launchable" instead of spawning something doomed.
 */
function launchableFrom(hit) {
  if (!hit) return null;
  const ext = path.extname(hit).toLowerCase();
  if (WIN && (ext === '.cmd' || ext === '.bat')) {
    const entry = shimEntryPoint(hit);
    if (!entry) return null;
    const node = nodeRunner();
    return { binary: node.binary, argv: [entry], env: node.env, via: `node ${entry}` };
  }
  if (ext === '.ps1') return null;
  // The default branch still verifies the file is there. Callers normally pass a
  // hit from `which()` or a detector, which already checked — but this is the
  // last gate before `spawn`, and a path that does not exist fails there with an
  // error that says nothing about which harness was misconfigured.
  return isFile(hit) ? { binary: hit, argv: [], env: {}, via: hit } : null;
}

/** `$DSH_HOME`, defaulting the same way DSH itself does. */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? path.join(home, '.dsh') : null;
}

/** The profile whose `package.json` proves the ACP bundle is installed. */
function dshAcpProfileDir() {
  const home = dshHome();
  if (!home) return null;
  return path.join(home, 'profiles', 'acp');
}

/**
 * The signed-in-account route patch, when the user has placed one beside the
 * profile config.
 *
 * Shipped DSH targets its API-key route, while the desktop app is signed in on
 * the account route; without this patch an ACP child starts and then cannot
 * authenticate.
 *
 * This is deliberately a PROFILE-layer file and is not shipped: the account and
 * model names in it are the user's own, so the plugin only DISCOVERS it. A
 * profile that never needed it is never handed a stray `--patch`.
 */
function peerAccountPatch() {
  const dir = process.env.DSH_PROFILE_DIR;
  if (!dir) return null;
  const candidate = path.join(dir, 'dsh-peer-account-route.yml');
  return isFile(candidate) ? candidate : null;
}

/* -------------------------------------------------------------------------- */
/* Per-harness detection and launch                                            */
/* -------------------------------------------------------------------------- */

function detectCodex() {
  const { resolveCodexBinary } = require('./codex-pool.cjs');
  const resolved = resolveCodexBinary(null);
  if (resolved && (resolved.includes('/') || resolved.includes('\\')) && isFile(resolved)) {
    return { found: true, detail: '找到 codex 可执行文件', binary: resolved };
  }
  const hit = which('codex');
  if (hit) {
    const launch = launchableFrom(hit);
    if (launch) return { found: true, detail: '找到 codex 启动器', binary: launch.binary };
    return { found: false, detail: '找到了 codex 脚本，但无法直接启动（缺少 .js 入口或 node）', binary: hit };
  }
  return { found: false, detail: '未检测到 codex（npm i -g @openai/codex）', binary: null };
}

function launchCodex(context) {
  const configured = context.configured || {};
  if (configured.codexPath || configured.agentCommand || configured.agentPath) return {};
  const detection = detectCodex();
  if (!detection.found) return {};
  // Hand the pool the absolute path we verified. `resolveCodexBinary` would find
  // the same file, but only by repeating the search; more importantly a bare
  // name there would reach `spawn` and fail with ENOENT on Windows.
  return { codexPath: detection.binary };
}

function isDshDesktopHost() {
  // Electron is also used by Agent Room itself; only DSH's actual CLI proves
  // this is a host we may relaunch as a DSH ACP peer.
  return Boolean(process.versions.electron && process.resourcesPath && fs.existsSync(path.join(
    process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js',
  )));
}

function detectDsh() {
  // Running inside DSH counts as "present" by definition; what can still be
  // missing is the ACP profile that an ACP child needs.
  if (isDshDesktopHost()) {
    const profile = dshAcpProfileDir();
    if (profile && isFile(path.join(profile, 'package.json'))) {
      return { found: true, detail: '当前进程即 DSH，且 acp profile 已安装', binary: process.execPath };
    }
    return {
      found: true,
      detail: '当前进程即 DSH，但未找到 acp profile（可用 dsh 安装 @deepseek-ai/dsh-acp-app）',
      binary: process.execPath,
    };
  }
  const hit = which('dsh');
  if (hit) {
    const launch = launchableFrom(hit);
    if (launch) return { found: true, detail: '在 PATH 中找到 dsh', binary: launch.binary };
  }
  return { found: false, detail: '未检测到 dsh（本机 PATH 上没有 dsh，且当前进程不是 DSH 桌面端）', binary: null };
}

function launchDsh(context) {
  const configured = context.configured || {};
  // An explicit launch line always wins: a user who wrote `agentCommand` has an
  // install we cannot guess better than they can.
  if (configured.agentCommand || configured.agentPath || configured.agentArgs) return {};

  // Inside the desktop host: re-launch our own executable as node and let it
  // boot the ACP profile. Built from `process.execPath`/`resourcesPath`, so the
  // same line works from any install directory.
  //
  // The `cli.js` path is deliberately NOT existence-checked, and neither is the
  // asar by type. Whether these paths stat at all — and whether `app.asar`
  // reports as a file or as a directory — depends on Electron's asar patch being
  // active in the current process, so a type check here measures the probe
  // rather than the install. `existsSync` is true under both readings, which is
  // the only question worth asking: is this an Electron/desktop install at all?
  if (isDshDesktopHost()) {
    const cli = path.join(
      process.resourcesPath,
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js',
    );
    if (!fs.existsSync(path.join(process.resourcesPath, 'app.asar'))) return {};
    const argv = ['--expose-internals', cli, '--profile', 'acp'];
    const patch = peerAccountPatch();
    if (patch) argv.push('--patch', patch);
    return {
      agentCommand: process.execPath,
      agentArgs: argv,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      // DSH's ACP profile refuses SOCKS and logs a warning per start, so the
      // ambient socks5h default is actively harmful for this harness.
      proxy: false,
    };
  }

  const hit = which('dsh');
  if (hit) {
    const launch = launchableFrom(hit);
    if (launch) {
      return {
        agentCommand: launch.binary,
        agentArgs: [...launch.argv, '--profile', 'acp'],
        env: launch.env,
        proxy: false,
      };
    }
  }
  return {};
}

function detectQoder() {
  // `qodercli` is the same package's second bin, so either name is a hit.
  for (const name of ['qoder', 'qodercli']) {
    const hit = which(name);
    if (!hit) continue;
    const launch = launchableFrom(hit);
    if (launch) return { found: true, detail: `在 PATH 中找到 ${name}`, binary: launch.binary };
    return { found: false, detail: `找到了 ${name}，但无法直接启动`, binary: hit };
  }
  return { found: false, detail: '未检测到 Qoder（npm i -g @qoder-ai/qodercli）', binary: null };
}

function launchQoder(context) {
  const configured = context.configured || {};
  if (configured.agentCommand || configured.agentPath || configured.agentArgs) return {};
  const hit = which('qoder') || which('qodercli');
  if (!hit) return {};
  const launch = launchableFrom(hit);
  if (!launch) return {};
  return {
    agentCommand: launch.binary,
    // Qoder's ACP mode is a flag, not a subcommand: `qoder --acp`.
    agentArgs: [...launch.argv, '--acp'],
    env: launch.env,
    proxy: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

function claudeCodeLaunch(target, args = []) {
  let desktopDataDir, desktopExecutable;
  if (fs.existsSync(path.join(path.dirname(target), 'resources', 'app.asar'))) {
    if (args.length) throw new Error('Claude 桌面入口自动选择 Code 运行程序，请清空高级启动参数');
    const desktop = require('../standalone/claude-desktop.cjs').resolveDesktopCode(target);
    desktopExecutable = target;
    target = desktop.binary; desktopDataDir = desktop.desktopDataDir;
  }
  // The bridge itself lives inside app.asar in desktop builds. A system Node
  // cannot read that virtual path, even when it is available on PATH.
  const runner = process.versions.electron
    ? { binary: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } } : nodeRunner();
  const cli = /\.(?:js|cjs|mjs)$/i.test(target) ? { binary: runner.binary, argv: [target], env: runner.env } : launchableFrom(target);
  if (!cli) throw new Error('无法识别 Claude Code 终端入口');
  return { agentCommand: runner.binary,
    agentArgs: [path.join(__dirname, '../standalone/claude-acp.cjs'), JSON.stringify({ binary: cli.binary, args: [...cli.argv, ...args], ...(desktopDataDir ? { desktopDataDir, desktopExecutable } : {}) })],
    env: { ...cli.env, ...runner.env }, proxy: false, claudeCode: true, ...(desktopDataDir ? { claudeDesktop: true } : {}) };
}
function detectClaude() {
  const hit = which('claude');
  if (!hit) return { found: false, binary: null, detail: '未发现 Claude Code 终端版；可手动选择 claude 程序' };
  try { claudeCodeLaunch(hit); return { found: true, binary: hit, detail: '找到 Claude Code 终端入口；连接与登录尚未验证' }; }
  catch (error) { return { found: false, binary: hit, detail: error.message }; }
}
function launchClaude(context) {
  if (context.configured?.agentCommand || context.configured?.agentPath || context.configured?.agentArgs) return {};
  const hit = which('claude');
  return hit ? claudeCodeLaunch(hit) : {};
}

/**
 * Every harness the plugin can run, in the order they are offered.
 *
 * `protocol` selects the pool implementation; it is the only field the engine
 * looks at. Everything else is presentation or launching.
 */
const HARNESSES = [
  {
    id: 'zcode', label: 'ZCode（本机 app-server）', short: 'ZCode', protocol: PROTOCOL_ACP,
    detect: () => ({ found: false, detail: '请在后端管理中发现或选择 ZCode 桌面或官方 CLI', binary: null }),
    launch: () => ({}),
  },
  {
    id: 'codex',
    label: 'codex（本机 codex 会话）',
    short: 'codex',
    protocol: PROTOCOL_CODEX,
    detect: detectCodex,
    launch: launchCodex,
  },
  {
    id: 'dsh',
    label: 'DSH（DeepSeek Harness，ACP）',
    short: 'DSH',
    protocol: PROTOCOL_ACP,
    detect: detectDsh,
    launch: launchDsh,
  },
  {
    id: 'qoder',
    label: 'Qoder（qoder --acp）',
    short: 'Qoder',
    protocol: PROTOCOL_ACP,
    detect: detectQoder,
    launch: launchQoder,
  },
  { id: 'claude', label: 'Claude Code（本机终端 / 桌面 API）', short: 'Claude Code',
    protocol: PROTOCOL_ACP, detect: detectClaude, launch: launchClaude },
  ...['workbuddy', 'workbuddy-ai'].map(id => ({
    id, label: id === 'workbuddy' ? 'WorkBuddy（国内版，本机）' : 'WorkBuddy AI（国际版，本机）',
    short: id === 'workbuddy' ? 'WorkBuddy' : 'WorkBuddy AI', protocol: PROTOCOL_ACP,
    detect: () => ({ found: false, detail: '请在后端管理中发现或选择本机 WorkBuddy 程序', binary: null }),
    launch: () => ({}),
  })),
];

function harnessIds() {
  return HARNESSES.map((entry) => entry.id);
}

function harnessById(id) {
  return HARNESSES.find((entry) => entry.id === id) || null;
}

/**
 * Fold a backend name onto its canonical harness id.
 *
 * Two jobs, both about the same failure — one harness ending up with two pools,
 * or a member pointing at a pool that does not exist:
 *
 *   1. **Legacy names.** The persisted roster on disk still says
 *      `backend: "acp"` for the member that was running DSH, and a room's saved
 *      config may say the same. An unknown backend throws in `_createPool`, so
 *      without this a restart would take the whole room down.
 *   2. **Case.** `Qoder`, `qoder` and `QODER` must be one harness. Backend names
 *      are used as pool keys, config keys and directory names, so a difference
 *      in case would silently produce a second pool with no launch line, and a
 *      member on it would fail for no visible reason. Names are therefore
 *      lowercased, including unknown ones, so a hand-registered `MyAgent` and
 *      `myagent` also collapse together.
 */
function canonicalBackend(name) {
  const key = name == null ? '' : String(name);
  if (!key) return '';
  const lower = key.toLowerCase();
  const mapped = LEGACY_BACKENDS[lower];
  return typeof mapped === 'string' && mapped ? mapped : lower;
}

/** Run every detection rule. Fast and side-effect free: filesystem and PATH. */
function detectHarnesses() {
  return HARNESSES.map((entry) => {
    let result;
    try {
      result = entry.detect();
    } catch (error) {
      result = { found: false, detail: `检测失败：${error.message}`, binary: null };
    }
    return {
      id: entry.id,
      label: entry.label,
      short: entry.short,
      protocol: entry.protocol,
      found: !!result.found,
      detail: result.detail,
      binary: result.binary || null,
    };
  });
}

/**
 * Pool options contributed by a harness: the raw default layer, unmerged.
 *
 * Returns `{}` for an unknown harness, and for one whose launcher cannot be
 * resolved on this machine — in which case the pool's own "no ACP agent
 * configured" error is the right thing for the user to see.
 */
function launchOptions(id, configured) {
  const entry = harnessById(canonicalBackend(id));
  if (!entry || typeof entry.launch !== 'function') return {};
  try {
    return entry.launch({ configured: configured || {} }) || {};
  } catch {
    return {};
  }
}

/**
 * Layer a harness's default launch line under the user's configuration.
 *
 * The rule is per-key: anything the configuration set wins, so a user who wrote
 * `agentCommand` gets exactly the command they wrote. The single exception is
 * `env`, which MERGES — a harness may need `ELECTRON_RUN_AS_NODE` to be a
 * working node at all, and a config that adds one variable of its own must not
 * silently drop that. Keeping this rule in one function is what stops the two
 * call sites from drifting apart.
 */
function mergeLaunch(derived, configured) {
  const own = configured || {};
  const out = { ...(derived || {}) };
  for (const [key, value] of Object.entries(own)) {
    if (key === 'env') continue;
    out[key] = value;
  }
  const env = { ...((derived && derived.env) || {}), ...(own.env || {}) };
  if (Object.keys(env).length) out.env = env;
  else delete out.env;
  return out;
}

/** A one-line, UI-safe description of what a harness would be started with. */
function describeLaunch(options) {
  if (!options) return null;
  const binary = options.agentCommand || options.agentPath || options.codexPath || null;
  if (!binary) return null;
  const argv = Array.isArray(options.agentArgs) ? options.agentArgs : [];
  return [binary, ...argv].join(' ');
}

/**
 * Which harnesses the add-member form offers, and the user's say in it.
 *
 * The rule is "detected by default, overridable by hand":
 *
 *   - No stored choice (`enabled === null`) means AUTOMATIC: offer exactly what
 *     detection found on this machine. An install therefore works with no
 *     configuration, and a harness the user installs later appears on its own.
 *   - A stored list means the user decided: offer those, whether or not
 *     detection agrees. Enabling a harness that was not found is legitimate —
 *     detection is a guess about paths, and a user who launches a harness
 *     through a wrapper script knows something we do not.
 *
 * `codex` is never dropped from the automatic set even when its binary is not
 * found, because it is the room's primary backend and a room with no backend at
 * all would fail to construct rather than fail informatively at a turn.
 */
class HarnessStore {
  constructor(options = {}) {
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.dir = options.dir || null;
    this.file = this.dir ? path.join(this.dir, 'harnesses.json') : null;
    /** `null` means "automatic": follow detection. See the class comment. */
    this.enabled = null;
    this.load();
  }

  load() {
    if (!this.file) return this.enabled;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.(`harnesses read failed: ${error.message}`);
      return this.enabled;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = parsed && parsed.enabled;
      // An explicit empty array is a real choice ("offer nothing"), so it must
      // survive; only a missing/invalid value falls back to automatic.
      if (Array.isArray(list)) this.enabled = this._sanitize(list);
    } catch (error) {
      this.logger?.(`harnesses parse failed: ${error.message}`);
    }
    return this.enabled;
  }

  /** Keep only known harness ids, canonicalised and de-duplicated. */
  _sanitize(list) {
    const out = [];
    for (const entry of list) {
      const id = canonicalBackend(entry);
      if (!harnessById(id)) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  get() {
    return this.enabled;
  }

  update(patch) {
    const raw = patch && Object.prototype.hasOwnProperty.call(patch, 'enabled') ? patch.enabled : undefined;
    if (raw === null || raw === undefined) this.enabled = null;
    else if (Array.isArray(raw)) this.enabled = this._sanitize(raw);
    else this.enabled = null;
    this.save();
    return this.enabled;
  }

  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, enabled: this.enabled }, null, 2) + '\n', 'utf8');
      fs.renameSync(temp, this.file);
      return true;
    } catch (error) {
      this.logger?.(`harnesses save failed: ${error.message}`);
      return false;
    }
  }

  /**
   * The harness rows to show: every registry entry, plus what was detected and
   * whether it is currently offered.
   */
  rows(detections) {
    const found = detections || detectHarnesses();
    const offered = this.effective(found);
    return found.map((row) => ({
      ...row,
      enabled: offered.includes(row.id),
      // Distinguishes "the user turned it on even though we could not find it"
      // from an ordinary row, so the UI can warn instead of silently offering
      // a harness that will fail at its first turn.
      forced: offered.includes(row.id) && !row.found,
    }));
  }

  /** The ids the add-member form should offer, given what detection found. */
  effective(detections) {
    if (this.enabled) return this.enabled.slice();
    const found = detections || detectHarnesses();
    const ids = found.filter((row) => row.found).map((row) => row.id);
    if (!ids.includes('codex')) ids.unshift('codex');
    return ids;
  }
}

/** Where the harness selection lives: its own directory beside the rooms. */
function defaultHarnessDir(roomsDir) {
  if (!roomsDir) return null;
  return path.join(path.dirname(roomsDir), 'agent-room-harnesses');
}

module.exports = {
  HARNESSES,
  HarnessStore,
  PROTOCOL_ACP,
  PROTOCOL_CODEX,
  canonicalBackend,
  claudeCodeLaunch,
  defaultHarnessDir,
  describeLaunch,
  detectHarnesses,
  dshAcpProfileDir,
  harnessById,
  harnessIds,
  launchOptions,
  launchableFrom,
  mergeLaunch,
  nodeRunner,
  shimEntryPoint,
  which,
};
