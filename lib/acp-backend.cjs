'use strict';

/**
 * ACP (Agent Client Protocol) backend for the agent room.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND THE ONE THING IT CANNOT DO
 * ---------------------------------------------------------------------------
 * The room used to speak exactly one agent dialect: the codex app-server,
 * driven by `lib/codex-pool.cjs`. This file adds a second dialect, ACP
 * (https://agentclientprotocol.com), so a room member can be an arbitrary
 * agent harness (Claude Code, Gemini CLI, another DSH, ...) instead of codex.
 *
 * `AcpPool` deliberately mirrors `CodexThreadPool`'s PUBLIC METHOD SURFACE one
 * for one, because `lib/room.cjs` holds pools of both kinds in the same Map
 * and calls the same methods on each without asking which kind it has:
 *
 *     start, stop, pid, binary, listModels, modelCapabilities,
 *     openThread, getThread, closeThread, runTurn, flush,
 *     supportsInject, inject, injectItems, interrupt
 *
 * NO CONTEXT INJECTION. This is the one place ACP cannot do what codex does,
 * and it is a property of the protocol, not an oversight here. codex has
 * `thread/inject_items`/`thread/inject` — a way to push a transcript line into
 * a live thread without producing a turn. ACP has NO equivalent method: the
 * agent-method set is `initialize`, `authenticate`, `session/new`,
 * `session/load`, `session/set_mode`, `session/set_config_option`,
 * `session/prompt`, `session/cancel`, `session/list`, `session/resume`,
 * `session/close` (+ providers/*, mcp/*, nes/*), and none of them accepts
 * caller-supplied context. The only way to get text in front of an ACP agent
 * is to send it as a `session/prompt`.
 *
 * So:
 *   - `supportsInject` is `false`.
 *   - `inject()` and `injectItems()` resolve immediately and do nothing.
 *   - `injectItems()` returns `{ injected: 0, skipped: 'unsupported' }` (falsy
 *     `injected`) rather than throwing. R3 removed the real-time push path
 *     (`room.cjs#_overhear` is gone — every backend now receives callers' text
 *     as a segment at delivery time), so nothing calls this any more; it stays
 *     because the pool method face is shared with `CodexThreadPool` and a
 *     caller probing for it must get an honest "cannot" rather than a crash.
 *     It must NOT report `{ error }`: a probe that reads a falsy `injected` is
 *     asking whether pushing is possible, not reporting a failure.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS VERIFIED AGAINST REAL SOURCES (see the report for full detail)
 * ---------------------------------------------------------------------------
 * Method names: `_research/asar24/dsh/node_modules/@agentclientprotocol/sdk/
 * dist/schema/index.js` (AGENT_METHODS/CLIENT_METHODS), cross-checked against
 * `_research/asar23/dsh/node_modules/@agentclientprotocol/sdk/dist/acp.js`.
 * Payload shapes: DSH's own ACP *server*, `_research/asar3/dsh/node_modules/
 * @deepseek-ai/dsh-acp/lib/index.js` — that is the implementation this backend
 * most needs to interoperate with, so its shapes win where anything disagrees.
 *
 *   initialize            client->agent request. params
 *                         `{ protocolVersion: 1, clientCapabilities, clientInfo }`;
 *                         result carries `agentCapabilities`, `agentInfo`,
 *                         `authMethods`, `protocolVersion`.
 *   session/new           `{ cwd, mcpServers: [] }` -> `{ sessionId, configOptions? }`
 *   session/prompt        `{ sessionId, prompt: [{ type: 'text', text }] }`
 *                         -> `{ stopReason }`; assistant text arrives as
 *                         `session/update` notifications BEFORE that response.
 *   session/cancel        NOTIFICATION (no id): `{ sessionId }`.
 *   session/close         request `{ sessionId }` -> `{}`; optional, and it
 *                         throws on an unknown session, so errors are swallowed.
 *   session/update        agent->client notification: `{ sessionId, update }`
 *                         where `update.sessionUpdate` is one of
 *                         agent_message_chunk / agent_thought_chunk / tool_call /
 *                         tool_call_update / plan / usage_update / ... .
 *   session/request_permission
 *                         agent->client REQUEST: `{ sessionId, toolCall,
 *                         options: [{ optionId, name, kind }] }` with
 *                         `kind` in allow_once|allow_always|reject_once|
 *                         reject_always. The reply is the NESTED form
 *                         `{ outcome: { outcome: 'selected', optionId } }` —
 *                         dsh-acp destructures `({ outcome }) => ... outcome
 *                         .optionId` (index.js:1135-1137). The flat
 *                         `{ outcome: 'selected', optionId }` is wrong.
 *
 * MODELS ARE NOT IN `initialize`. There is no `availableModels` field anywhere
 * in the ACP schema; the only standard place model information appears is the
 * `session/new` response's `configOptions` array (`category: 'model'` /
 * `category: 'thought_level'`), which by definition cannot be read until a
 * session exists — and `room.cjs` calls `modelCapabilities()` right after
 * `start()`, before any session. `modelCapabilities()` therefore opportunistically
 * learns from `initialize` if a nonstandard agent does advertise a list (via
 * `agentCapabilities.models`, `agentCapabilities.availableModels`, `models`, or
 * `_meta.*`), and otherwise falls back to a sane default catalogue. When a
 * session is later opened, the `configOptions` catalogue is folded in, so a
 * second `modelCapabilities()` call reflects what the agent actually offers.
 * `room.cjs` explicitly tolerates an empty map (room.cjs:369-374) and an empty
 * `efforts` array, so neither fallback can wedge the room.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROXY = process.env.AGENT_ROOM_PROXY || null;
const { childEnv } = require('./backend-env.cjs');
const PROTOCOL_VERSION = 1;

/** Default reasoning efforts, used when (as with every real ACP agent) the
 *  agent advertises no catalogue at `initialize` time. */
const DEFAULT_EFFORTS = ['low', 'medium', 'high'];
const DEFAULT_EFFORT = 'medium';

/** Standalone spawner: a plain pipe-backed child, same surface the host passes. */
function defaultSpawn(binary, argv, options) {
  return spawn(binary, argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

class AcpError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AcpError';
    this.detail = detail;
  }
}

// Provider refusal metadata is not a public diagnostic dump. Read only its
// message/code, discard other fields, and redact common credential formats.
function refusalDetail(result) {
  let value = result?.errorMessage ?? result?._meta?.['codebuddy.ai/errorMessage'] ?? result?._meta?.errorMessage;
  if (!value) return '';
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch {}
  }
  if (value && typeof value === 'object') {
    const error = value.error && typeof value.error === 'object' ? value.error : value;
    value = typeof error.message === 'string' ? [typeof error.code === 'number' ? error.code : '', error.message].filter(v => v !== '').join(': ') : '';
  }
  if (typeof value !== 'string') return '';
  return value.replace(/sk-[\w-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .slice(0, 1200);
}

/** Split a command line the way a shell would, honouring simple quoting. */
function splitCommandLine(text) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current) out.push(current);
  return out;
}

/**
 * Work out what to launch.
 *
 * Callers hand us either a bare program (`agentCommand`) with a separate
 * `agentArgs` array, or one pre-joined `agentPath` string. Both spellings are
 * accepted because the two obvious call sites disagree: a room config wants
 * `{ agentCommand: 'claude-code-acp' }`, while a hand-written launch line wants
 * `agentPath: 'node /path/to/acp-agent.js --flag'`.
 *
 * A command that does not exist on disk is only an error when it was given as
 * an explicit path (it contains a separator); the existence check for that case
 * happens in `start()`. A bare name is handed to the OS as-is, without
 * pre-validation.
 *
 * On Windows that is a real limitation, not a convenience: Node does not apply
 * PATHEXT, so a bare `qoder` does not find `qoder.cmd`, and handing `spawn` a
 * `.cmd` path throws EINVAL synchronously (Node 20+). `spawn(..., {shell:true})`
 * would work but mangles arguments containing spaces and emits DEP0190.
 *
 * The fix is NOT here — `lib/harnesses.cjs` owns it. `which()` skips the
 * extensionless POSIX shim that npm writes, `shimEntryPoint()` reads the real
 * `.js` entry out of a `.cmd` shim, and `launchableFrom()` turns the result into
 * `node <entry.js>` or a native `.exe`. So by the time this module is called for
 * a harness the registry knows about, it is already handed something spawnable.
 * A hand-written `agentCommand` bypasses all of that and must be launchable
 * itself: a native binary, or `node <script>`.
 */
function resolveAgentCommand(options = {}) {
  const command = options.agentCommand || options.acpCommand || null;
  if (command) {
    const argv = Array.isArray(options.agentArgs) ? options.agentArgs.slice() : [];
    return { binary: command, argv, source: 'agentCommand' };
  }
  const line = options.agentPath || options.acpPath || null;
  if (line) {
    const parts = Array.isArray(line) ? line.slice() : splitCommandLine(line);
    if (!parts.length) throw new AcpError('empty agentPath');
    return { binary: parts[0], argv: parts.slice(1), source: 'agentPath' };
  }
  const envLine = process.env.AGENT_ROOM_ACP_PATH;
  if (envLine) {
    const parts = splitCommandLine(envLine);
    return { binary: parts[0], argv: parts.slice(1), source: 'AGENT_ROOM_ACP_PATH' };
  }
  throw new AcpError(
    'no ACP agent configured: pass { agentCommand, agentArgs } (or { agentPath }) to AcpPool',
  );
}

function looksLikePath(binary) {
  return binary.includes('/') || binary.includes('\\') || /^[A-Za-z]:/.test(binary);
}

/* -------------------------------------------------------------------------- */
/* Wire                                                                        */
/* -------------------------------------------------------------------------- */

class AcpConnection {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.env = childEnv({ proxy: options.proxy, env: options.env });
    this.log = options.log || (() => {});
    // Inside DSH the host passes a spawner backed by `ctx.subprocess` so the
    // ACP child is torn down with the plugin fiber. Standalone we fall back to
    // `node:child_process`, exactly like codex-pool.cjs does.
    this.spawnChild = options.spawnChild || defaultSpawn;
    this.serverRequestHandler = options.onServerRequest || null;
    this.permissionRequestHandler = options.onPermissionRequest || null;
    this.permissionMetadata = new Map();
    // The launch command is resolved lazily so a missing/misconfigured agent
    // surfaces as a rejected `start()` (a readable AcpError the room can log)
    // rather than as a throw from the pool constructor.
    this.commandOptions = options;
    this.command = null;

    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifyHandlers = new Set();
    this.stderrTail = [];
    this.exited = null;
    this.ready = null;
    this.info = null;
    this.stopping = false;
    // `this.child` keeps pointing at a dead process after an exit, so it cannot
    // answer "is this pool usable?". See `get running`.
    this.alive = false;
    this.exitInfo = null;
    // Model/effort catalogue, learned lazily. Absent until an agent advertises
    // one (`initialize` nonstandardly, or `session/new` -> configOptions).
    this.modelCatalogue = null;
    this.effortsFromAgent = null;
    this.currentModelValue = null;
    this.configIds = { model: null, effort: null };
  }

  get pid() {
    // Same trap as the codex pool: `this.child` survives the exit, so an
    // unconditional `child.pid` reports a corpse as if the agent were up.
    return this.running ? this.child.pid : null;
  }

  /** The agent process is up and can still be written to. */
  get running() {
    return this.alive && !!this.child && !this.child.killed;
  }

  /** Human-readable description of the launched command. */
  get binary() {
    if (!this.command) {
      try {
        this.command = resolveAgentCommand(this.commandOptions);
      } catch (error) {
        return error.message;
      }
    }
    return [this.command.binary, ...this.command.argv].join(' ');
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.command) this.command = resolveAgentCommand(this.commandOptions);
      const { binary, argv } = this.command;
      if (looksLikePath(binary) && !fs.existsSync(binary)) {
        throw new AcpError('ACP agent binary not found: ' + binary);
      }
      let child;
      try {
        child = this.spawnChild(binary, argv, { cwd: this.cwd, env: this.env });
      } catch (error) {
        // A `.cmd`/`.bat` handed straight to `spawn` on Windows fails with a
        // bare EINVAL that says nothing about the cause. Say it instead: this is
        // what a hand-written `agentCommand: 'qoder.cmd'` hits, and the fix
        // (point at the real entry, or let the registry resolve it) is not
        // guessable from "EINVAL".
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
          throw new AcpError(
            'ACP agent ' +
              binary +
              ' is a Windows shell shim, which cannot be spawned directly; ' +
              'point agentCommand at a native executable or at `node <entry.js>`, ' +
              'or leave it unset so the harness registry resolves it',
            error,
          );
        }
        throw new AcpError('failed to spawn ACP agent ' + this.binary + ': ' + error.message, error);
      }
      if (!child || !child.stdin || !child.stdout) {
        throw new AcpError('ACP agent spawn returned no usable stdio: ' + this.binary);
      }
      this.child = child;
      this.alive = true;
      this.exited = new Promise((resolve) => {
        child.on('exit', (code, signal) => {
          this.alive = false;
          this.exitInfo = { code, signal };
          this.log('acp exited code=' + code + ' signal=' + signal);
          for (const [, entry] of this.pending) {
            entry.reject(new AcpError('acp agent exited before replying'));
          }
          this.pending.clear();
          resolve({ code, signal });
        });
      });
      // `spawn` reports a missing bare command asynchronously, as an 'error'
      // event. Without this race, `start()` would sit on the initialize
      // request for ten minutes instead of reporting "not found".
      const spawnFailed = new Promise((_, reject) => {
        child.on('error', (error) => {
          this.log('acp spawn error: ' + error.message);
          reject(new AcpError('failed to spawn ACP agent ' + this.binary + ': ' + error.message, error));
        });
      });
      spawnFailed.catch(() => {});
      // Same fatal-async-error trap as the codex pool: a child that exits while
      // a frame is in flight makes the next `stdin.write` fail with EPIPE, which
      // surfaces as an 'error' event on the stream and not as a throw. With no
      // listener that event terminates the host process.
      child.stdin.on('error', (error) => {
        this.log('acp stdin error: ' + error.message);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        this.stderrTail.push(text);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        this.log('[acp stderr] ' + text.split('\n')[0].slice(0, 300));
      });

      // `initialize` is the one handshake both sides must complete before any
      // session exists. We advertise NO fs/terminal capability: this pool is a
      // plain chat backend, and claiming a capability we do not service would
      // make a real agent block on a request we never answer.
      const result = await Promise.race([
        this.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
          clientInfo: { name: 'dsh-agent-room', title: 'DSH Agent Room', version: '0.1.0' },
        }),
        spawnFailed,
      ]);
      this.info = (result && typeof result === 'object') ? result : {};
      return this.info;
    })();
    // A failed start must not be memoized as a permanent verdict: the room may
    // retry connect() after the operator fixes the agent command.
    this.ready = this.ready.catch((error) => {
      this.ready = null;
      throw error;
    });
    // An agent that dies mid-life must not leave a memoized "connected" verdict
    // behind, or the room would keep reporting a live session whose every frame
    // is dropped into a closed pipe. Forgetting it lets the next `start()`
    // respawn.
    if (this.exited) {
      void this.exited.then(() => {
        if (this.stopping) return;
        this.ready = null;
        this.info = null;
        this._onDeath();
      });
    }
    return this.ready;
  }

  /**
   * Hook for subclasses: the agent died unexpectedly. The base pool only drops
   * its connection state; session ids and the learned catalogue belong to the
   * dead process and are dropped by `AcpPool`.
   */
  _onDeath() {
    this.buffer = '';
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        this.log('acp: unparsable frame ' + line.slice(0, 200));
        continue;
      }
      this._dispatch(frame);
    }
  }

  _dispatch(frame) {
    // Agent -> client REQUEST: it carries BOTH `id` and `method`, and it MUST
    // be answered or the turn wedges. (Same hard rule codex-pool.cjs lives by.)
    if (frame && frame.id !== undefined && frame.method !== undefined) {
      void this._answerServerRequest(frame);
      return;
    }
    if (frame && frame.id !== undefined) {
      const entry = this.pending.get(frame.id);
      if (!entry) {
        this.log('acp: reply for unknown id ' + frame.id);
        return;
      }
      this.pending.delete(frame.id);
      if (frame.error) {
        entry.reject(new AcpError(describeError(frame.error), frame.error));
      } else {
        entry.resolve(frame.result === undefined ? {} : frame.result);
      }
      return;
    }
    if (frame && frame.method) {
      const update = frame.params?.update;
      if (this.permissionRequestHandler && frame.method === 'session/update' && update?.toolCallId && ['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        const key = frame.params.sessionId + ':' + update.toolCallId;
        const previous = this.permissionMetadata.get(key) || {};
        this.permissionMetadata.set(key, { ...previous, ...(update.title ? { title: String(update.title).slice(0, 160) } : {}),
          ...(update.rawInput ? { description: JSON.stringify(update.rawInput).slice(0, 4000) } : {}) });
        if (this.permissionMetadata.size > 100) this.permissionMetadata.delete(this.permissionMetadata.keys().next().value);
      }
      for (const handler of this.notifyHandlers) {
        try {
          handler(frame.method, frame.params || {});
        } catch (error) {
          this.log('acp notification handler failed: ' + error.message);
        }
      }
    }
  }

  /**
   * A request FROM the agent. `session/request_permission` is answered here,
   * not by the host hook, because the host hook (`room.cjs#_onServerRequest`)
   * answers codex's approval methods and returns `{}` for anything else — and
   * `{}` is not a legal ACP outcome, so an agent would reject it and stall.
   *
   * Any other agent->client request is offered to the host hook, but `{}` is
   * only a valid reply for the handful of ACP methods that take an empty
   * result. For the rest (fs/read_text_file, terminal/create, elicitation/create,
   * ...) an empty object is a schema violation that would make a real agent
   * fail the turn, so those get an honest JSON-RPC "method not found" instead.
   * We advertise no fs/terminal capabilities at `initialize`, so a conforming
   * agent never sends them in the first place.
   */
  async _answerServerRequest(frame) {
    let result;
    let failure = null;
    try {
      if (frame.method === 'session/request_permission') {
        const params = frame.params || {};
        const metadata = this.permissionMetadata.get(params.sessionId + ':' + params.toolCall?.toolCallId);
        result = this.permissionRequestHandler ? await this.permissionRequestHandler({ ...params, toolCall: { ...metadata, ...params.toolCall } }) : answerPermission(params);
      } else if (this.serverRequestHandler) {
        result = await this.serverRequestHandler(frame.method, frame.params);
      }
      if (result === undefined) result = {};
      if (needsRealResult(frame.method) && isEmptyObject(result)) {
        failure = {
          code: -32601,
          message: 'client does not support ' + frame.method,
        };
      }
    } catch (error) {
      this.log('acp server request ' + frame.method + ' failed: ' + error.message);
      failure = { code: -32603, message: error.message || 'internal error' };
    }
    if (failure) {
      this.write({ jsonrpc: '2.0', id: frame.id, error: failure });
      return;
    }
    this.write({ jsonrpc: '2.0', id: frame.id, result });
  }

  write(frame) {
    if (!this.running) {
      // Writing into a dead agent does not "send and wait", it drops the frame:
      // the promise `request` just registered would never settle, and its timer
      // is unref'd, so a caller can hang forever on a process that looks idle.
      // Rejecting here converts that silent hang into a reportable error.
      const reason = this.exitInfo
        ? `acp agent exited (code=${this.exitInfo.code} signal=${this.exitInfo.signal})`
        : 'acp agent is not running';
      if (frame && frame.id !== undefined) {
        const entry = this.pending.get(frame.id);
        if (entry) {
          this.pending.delete(frame.id);
          entry.reject(new AcpError(reason));
        }
      }
      return false;
    }
    try {
      this.child.stdin.write(JSON.stringify(frame) + '\n');
      return true;
    } catch (error) {
      this.log('acp write failed: ' + error.message);
      return false;
    }
  }

  request(method, params, options = {}) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method };
    if (params !== undefined) frame.params = params;
    const timeoutMs = options.timeoutMs === undefined ? 600000 : options.timeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(new AcpError('acp request timed out: ' + method));
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      this.write(frame);
    });
  }

  notify(method, params) {
    const frame = { jsonrpc: '2.0', method };
    if (params !== undefined) frame.params = params;
    this.write(frame);
  }

  onNotification(handler) {
    this.notifyHandlers.add(handler);
    return () => this.notifyHandlers.delete(handler);
  }

  async stop() {
    const child = this.child;
    // A deliberate stop is not a crash: `stopping` keeps the exit watcher from
    // clearing `ready`, which would let a later `start()` respawn during
    // teardown.
    this.stopping = true;
    if (!child || child.killed) {
      // `pid` is `child ? child.pid : null`, so dropping the reference is what
      // makes `pool.pid === null` after a stop — `child.killed` alone leaves a
      // stale pid visible to `room.cjs#snapshot`.
      this.child = null;
      this.alive = false;
      return;
    }
    try {
      child.stdin.end();
    } catch {}
    // Give the agent a moment to exit on its own before killing it.
    const exited = this.exited;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 1500);
      if (timer.unref) timer.unref();
      if (child.exitCode !== null && child.exitCode !== undefined) {
        done();
        return;
      }
      child.once('exit', done);
      if (exited) exited.then(done, done);
    });
    try {
      if (child.exitCode === null || child.exitCode === undefined) child.kill();
    } catch {}
    try {
      child.kill();
    } catch {}
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy?.();
    // Drop the reference last: `pid` reads `this.child`, and every caller that
    // snapshots the room after `dispose()` must see a dead pool, not a stale pid.
    this.child = null;
    this.alive = false;
  }

  /**
   * Accept every spelling of an advertised model list. There is no standard
   * ACP field for this, so an agent that has one is nonstandard and may have
   * put it anywhere; we look in all the plausible places and tolerate absence.
   */
  advertisedModels() {
    const info = this.info || {};
    const caps = (info.agentCapabilities && typeof info.agentCapabilities === 'object') ? info.agentCapabilities : {};
    const meta = (info._meta && typeof info._meta === 'object') ? info._meta : {};
    const candidates = [
      caps.models,
      caps.availableModels,
      info.models,
      info.availableModels,
      meta.models,
      meta.availableModels,
    ];
    for (const candidate of candidates) {
      const list = Array.isArray(candidate) ? candidate : (candidate && Array.isArray(candidate.data) ? candidate.data : null);
      if (!list || !list.length) continue;
      const currentId = (candidate && !Array.isArray(candidate) && candidate.currentModelId) || caps.currentModelId || null;
      const entries = [];
      for (const entry of list) {
        if (!entry) continue;
        if (typeof entry === 'string') {
          entries.push({ id: entry, displayName: entry });
          continue;
        }
        const id = entry.modelId || entry.id || entry.model || entry.slug;
        if (!id) continue;
        entries.push({ id, displayName: entry.name || entry.displayName || id });
      }
      if (entries.length) return { entries, currentId };
    }
    return null;
  }

  /**
   * Learn the model/effort catalogue from a `session/new` (or `session/resume`)
   * response. ACP puts it in `configOptions`: one `select` option with
   * `category: 'model'` whose `options` are provider groups -> model choices,
   * and one with `category: 'thought_level'` whose `options` are the efforts.
   * This is the ONLY standard source of a model list in ACP.
   */
  learnConfigOptions(configOptions) {
    if (!Array.isArray(configOptions)) return;
    const modelOption = configOptions.find((option) => option && option.category === 'model');
    const effortOption = configOptions.find((option) => option && option.category === 'thought_level');
    const learned = [];
    if (modelOption) {
      if (typeof modelOption.id === 'string') this.configIds.model = modelOption.id;
      const groups = Array.isArray(modelOption.options) ? modelOption.options : [];
      for (const group of groups) {
        const choices = (group && Array.isArray(group.options)) ? group.options : (group ? [group] : []);
        for (const choice of choices) {
          if (!choice || typeof choice.value !== 'string') continue;
          // Keep opaque provider/model values: display names are not unique.
          const id = choice.value;
          learned.push({ id, raw: choice.value, displayName: choice.name || id });
        }
      }
    }
    if (learned.length) {
      this.modelCatalogue = { entries: learned, currentId: modelOption.currentValue || null };
      // A real catalogue just arrived, so the memoized capability map (which may
      // still hold the synthetic `acp-default` entry built before any session
      // existed) is stale. Dropping it lets the room re-read the truth on its
      // next `_refreshCapabilities()` and offer the member's real models.
      this._capabilities = null;
    }
    if (effortOption) {
      if (typeof effortOption.id === 'string') this.configIds.effort = effortOption.id;
      const choices = Array.isArray(effortOption.options) ? effortOption.options : [];
      const efforts = [];
      for (const choice of choices) {
        if (!choice || typeof choice.value !== 'string') continue;
        // dsh-acp uses '' as its "provider default" sentinel, which is not an
        // effort a caller may ask for.
        if (!choice.value) continue;
        efforts.push(String(choice.value));
      }
      if (efforts.length) this.effortsFromAgent = efforts;
    }
    if (modelOption && typeof modelOption.currentValue === 'string') {
      this.currentModelValue = modelOption.currentValue;
    }
  }

  /**
   * Select a value on one of the session's config options.
   *
   * This is the ONLY way ACP lets a client pick a model or a reasoning effort:
   * the values are opaque strings the agent chose (`["provider","model"]` for
   * dsh-acp, index.js:524-527), so a value is only sent when it was actually
   * learned from the agent's own catalogue. Every failure is swallowed — a room
   * turn must not die because an agent refused a config switch — but a refusal
   * is logged so it is visible.
   */
  async applyConfigOption(sessionId, configId, value, strict = false) {
    if (!configId || typeof value !== 'string' || !value) return false;
    if (!this.threads.size && !sessionId) return false;
    try {
      const result = await this.request('session/set_config_option', { sessionId, configId, value }, { timeoutMs: 30000 });
      if (result.configOptions) this.learnConfigOptions(result.configOptions);
      const echoed = result.configOptions?.find(option => option.id === configId);
      if (echoed && echoed.currentValue !== value) return false;
      return true;
    } catch (error) {
      this.log('acp set_config_option ' + configId + '=' + value + ' failed: ' + error.message);
      if (strict) throw new AcpError('无法应用固定模型：' + refusalDetail({ errorMessage: error.message }));
      return false;
    }
  }

  /** The learned catalogue entry whose id/displayName matches `wanted`. */
  lookupModel(wanted) {
    if (!wanted || !this.modelCatalogue) return null;
    const target = String(wanted);
    return this.modelCatalogue.entries.find(
      (entry) => entry.id === target || entry.raw === target || entry.displayName === target,
    ) || null;
  }

  async listModels() {
    const source = this.modelCatalogue || this.advertisedModels();
    return source ? source.entries : [];
  }
}

function isEmptyObject(value) {
  return !!value && typeof value === 'object' && Object.keys(value).length === 0;
}

/**
 * Agent->client methods whose result is a real payload, not `{}`. Answering
 * `{}` to one of these is a schema violation for a conforming agent, so the
 * backend answers "method not found" instead of lying. Everything not listed
 * here either has an empty-object result (`fs/write_text_file`, `terminal/kill`,
 * `terminal/release`, `elicitation/complete`, ...) or is handled specifically.
 */
const METHODS_WITHOUT_EMPTY_RESULT = new Set([
  'fs/read_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'mcp/connect',
  'mcp/message',
  'elicitation/create',
]);

function needsRealResult(method) {
  return METHODS_WITHOUT_EMPTY_RESULT.has(method);
}

/** Codex's error-description shape, so logs read the same for both backends. */
function describeError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  const parts = [];
  if (error.code !== undefined) parts.push(String(error.code));
  if (error.message) parts.push(String(error.message));
  else parts.push(JSON.stringify(error).slice(0, 300));
  if (error.data !== undefined) parts.push(JSON.stringify(error.data).slice(0, 300));
  return parts.join(': ');
}

/**
 * Decide a permission request.
 *
 * `kind` is the machine-readable decision (`allow_once` | `allow_always` |
 * `reject_once` | `reject_always`); prefer `allow_once` over `allow_always`
 * because a room turn should never grant a standing permission, then any other
 * allow, then fall back to the first option offered so the agent always gets an
 * answer and the turn cannot wedge.
 *
 * The reply MUST be the nested `{ outcome: { outcome: 'selected', optionId } }`
 * form — dsh-acp reads `outcome.outcome` then `outcome.optionId`
 * (dsh-acp/lib/index.js:1135-1137).
 */
function answerPermission(params) {
  const options = (params && Array.isArray(params.options)) ? params.options : [];
  const allowed = options.filter((option) => option && typeof option.kind === 'string' && option.kind.startsWith('allow'));
  const preferred =
    allowed.find((option) => option.kind === 'allow_once') ||
    allowed[0] ||
    options[0] ||
    null;
  if (!preferred) {
    // Nothing to select: the agent offered no options, so the only honest
    // answer is that the request was cancelled.
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'selected', optionId: preferred.optionId } };
}

/* -------------------------------------------------------------------------- */
/* Thread pool                                                                 */
/* -------------------------------------------------------------------------- */

class AcpPool extends AcpConnection {
  constructor(options = {}) {
    super(options);
    this.threads = new Map();
    this.queues = new Map();
    this._capabilities = null;
    // The room's active-turn bookkeeping is codex-shaped (`turnId`); ACP has no
    // turn id, so the value is just a truthy marker that a prompt is in flight.
    this.activeTurns = new Map();
  }

  get supportsInject() {
    return false;
  }

  /**
   * The agent died: its session ids and the catalogue it taught us are gone.
   *
   * Dropping the thread records is what lets the room recover — `ensureThread`
   * sees no session, opens a new one, and rewinds that member's cursor so the
   * full log is replayed. The member rejoins with real context instead of
   * answering from a session the agent no longer has.
   */
  _onDeath() {
    super._onDeath();
    const keys = Array.from(this.threads.keys());
    this.threads.clear();
    this.activeTurns.clear();
    // `queues` is deliberately kept: in-flight tasks still need their chain, and
    // clearing it would let a new task for the same key run concurrently with a
    // dying one.
    this._capabilities = null;
    this.modelCatalogue = null;
    this.effortsFromAgent = null;
    this.currentModelValue = null;
    this.configIds = { model: null, effort: null };
    if (keys.length) this.log('acp died: dropped ' + keys.length + ' session(s)');
  }

  /** ACP has no context-injection method: documented no-op. */
  async inject(threadKey, records) {
    return { injected: 0, skipped: 'unsupported' };
  }

  /**
   * Retained only so the pool method face matches `CodexThreadPool`: anything
   * that probes for `injectItems` gets an honest "not supported" instead of a
   * crash. R3 deleted the caller (`room.cjs#_overhear`), so nothing in the room
   * touches this.
   */
  async injectItems(threadKey, records) {
    void threadKey;
    void records;
    return { injected: 0, skipped: 'unsupported' };
  }

  _enqueue(threadKey, task) {
    const previous = this.queues.get(threadKey) || Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(threadKey, next.catch(() => {}));
    return next;
  }

  flush(threadKey) {
    return this._enqueue(threadKey, () => undefined);
  }

  async modelCapabilities() {
    if (this._capabilities) return this._capabilities;
    const map = new Map();
    let entries = [];
    try {
      entries = await this.listModels();
    } catch (error) {
      this.log('acp model list failed: ' + error.message);
      entries = [];
    }
    const advertised = this.effortsFromAgent && this.effortsFromAgent.length
      ? this.effortsFromAgent.slice()
      : [];
    for (const entry of entries) {
      const id = entry.id || entry.model || entry.slug;
      if (!id) continue;
      map.set(id, {
        id,
        displayName: entry.displayName || entry.name || id,
        efforts: advertised.slice(),
        advertisedEfforts: advertised.slice(),
        learned: false,
        defaultEffort: advertised.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (advertised[0] || null),
        serviceTiers: [],
        hidden: false,
        synthetic: false,
      });
    }
    if (!map.size) {
      // No catalogue: ACP gives us none before a session exists. Advertise one
      // nominal entry so callers that require a non-empty map get one, and mark
      // it so nobody mistakes it for a real model list.
      //
      // `synthetic` is the flag the room keys off (room.cjs#_refreshCapabilities):
      // a catalogue made only of synthetic entries is "no catalogue at all", so
      // the room must not validate a member's configured model against it and
      // must not report `acp-default` as that member's model. `hidden` alone
      // cannot carry that meaning — codex's own `model/list` sets `hidden` on
      // real models that merely should not be offered by default.
      const id = 'acp-default';
      map.set(id, {
        id,
        displayName: 'ACP agent default',
        efforts: advertised.slice(),
        advertisedEfforts: advertised.slice(),
        learned: false,
        defaultEffort: advertised.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (advertised[0] || null),
        serviceTiers: [],
        hidden: true,
        synthetic: true,
      });
      this.log('acp: agent advertised no model list; using a default entry');
    }
    this._capabilities = map;
    return map;
  }

  async openThread(key, options = {}) {
    await this.start();
    const cwd = options.cwd || this.cwd;
    const params = { cwd, mcpServers: options.mcpServers || [] };
    const result = await this.request('session/new', params);
    const sessionId = result && result.sessionId;
    if (!sessionId) throw new AcpError('session/new returned no sessionId: ' + JSON.stringify(result).slice(0, 200));
    if (result.configOptions) this.learnConfigOptions(result.configOptions);
    const record = {
      key,
      id: sessionId,
      model: options.model,
      reasoningEffort: options.effort || null,
      // `room.cjs#ensureThread` reuses a thread only when `record.sandbox`
      // matches the current mode's sandbox, so this must be the caller's value
      // verbatim ('read-only' / 'danger-full-access'), not a translated one.
      sandbox: options.sandbox || 'read-only',
      cwd,
      options,
      supportsClose: Boolean(
        this.info &&
        this.info.agentCapabilities &&
        this.info.agentCapabilities.sessionCapabilities &&
        this.info.agentCapabilities.sessionCapabilities.close,
      ),
    };
    this.threads.set(key, record);
    /**
     * Apply the caller's model and effort through the config-option surface.
     *
     * dsh-acp's session starts on its own current model regardless of what the
     * room asked for, so without this the room's per-member model would be
     * cosmetic on a real agent. Both calls are best-effort: only a value the
     * agent itself advertised is ever sent, and a refusal is logged, not thrown.
     */
    const wanted = this.lookupModel(options.model);
    try {
      if (wanted && this.configIds.model) {
        record.appliedModel = await this.applyConfigOption(sessionId, this.configIds.model, wanted.raw || wanted.id, options.strictModel);
        if (record.appliedModel) this.currentModelValue = wanted.raw || wanted.id;
      }
      if (options.strictModel && (!wanted || !record.appliedModel)) throw new AcpError('无法应用固定模型，请检查后端模型配置');
    } catch (error) {
      this.threads.delete(key);
      if (record.supportsClose) {
        try { await this.request('session/close', { sessionId }, { timeoutMs: 5000 }); } catch {}
      }
      throw error;
    }
    // Effort is NOT applied here: the room passes it per TURN
    // (`runTurn(..., { effort })`), not per thread, so it is handled in _runTurn.
    return record;
  }

  getThread(key) {
    return this.threads.get(key);
  }

  /**
   * Drop the thread and tell the agent, if it advertised `session/close`.
   * `session/close` throws on an unknown session (dsh-acp/lib/index.js:1296-1308),
   * so the request is fire-and-forget and every error is swallowed.
   */
  closeThread(key) {
    const record = this.threads.get(key);
    this.threads.delete(key);
    if (!record) return;
    if (!record.supportsClose) return;
    try {
      this.request('session/close', { sessionId: record.id }).catch(() => {});
    } catch {}
  }

  async runTurn(threadKey, options = {}) {
    return this._enqueue(threadKey, () => this._runTurn(threadKey, options));
  }

  async _runTurn(threadKey, options) {
    const thread = this.threads.get(threadKey);
    if (!thread) throw new AcpError('unknown thread key: ' + threadKey);
    const sessionId = thread.id;
    const input = options.text == null ? '' : String(options.text);
    const instructions = !thread.instructionsSent && [thread.options.baseInstructions, thread.options.developerInstructions].filter(Boolean).join('\n');
    const text = instructions ? '[会话身份与角色设定]\n' + instructions + '\n\n' + input : input;

    let assistantText = '';
    let usage = null;
    let thoughtText = '';
    let cancelled = false;
    const unsubscribe = this.onNotification((method, params) => {
      if (method !== 'session/update') return;
      if (!params || params.sessionId !== sessionId) return;
      this._handleUpdate(params.update, {
        onDelta: options.onDelta,
        onItem: options.onItem,
        isCancelled: () => cancelled,
        onText: (chunk) => {
          assistantText += chunk;
        },
        onThought: (chunk) => {
          thoughtText += chunk;
        },
        onUsage: (value) => {
          usage = value;
        },
      });
    });

    this.activeTurns.set(threadKey, true);
    const timeoutMs = options.timeoutMs || 300000;
    let timer = null;
    let timedOut = false;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new AcpError('acp turn timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });

    try {
      /**
       * Apply the per-turn reasoning effort BEFORE prompting.
       *
       * ACP carries effort as a session config option, not as a prompt field, so
       * a caller asking for 'high' on this turn must set it on the session
       * first or the agent silently answers at its own default. Only a value the
       * agent advertised is sent, and only when it differs from what is already
       * selected; a refusal is logged and the turn proceeds.
       */
      const effort = options.effort == null ? null : String(options.effort);
      if (effort && thread.options.strictModel && (!this.configIds.effort || !this.effortsFromAgent?.includes(effort))) throw new AcpError('该会话不支持推理强度：' + effort);
      if (effort && this.configIds.effort && Array.isArray(this.effortsFromAgent) &&
          this.effortsFromAgent.includes(effort) && thread.appliedEffort !== effort) {
        const switched = await this.applyConfigOption(sessionId, this.configIds.effort, effort);
        if (!switched) throw new AcpError('后端拒绝切换推理强度：' + effort);
        if (switched) thread.appliedEffort = effort;
      }
      /**
       * ACP carries text and nothing else: `session/prompt` takes a list of
       * content blocks, but the only block every agent is required to accept is
       * `{type:'text'}`. There is no image block in the protocol that a harness
       * is obliged to understand, so an attachment reaches an ACP member as the
       * path already written into `text` (see `attachmentLines` in `room.cjs`)
       * and the member opens it with its own file tools.
       *
       * That is why `options.attachments` is not read here: the structured form
       * exists for codex, whose `UserInput` union has a real image variant.
       */
      const prompt = this.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      // A `session/cancel` makes the agent resolve the prompt with
      // `stopReason: 'cancelled'` rather than erroring, so the prompt promise
      // stays the single completion signal.
      const result = await Promise.race([prompt, guard]);
      const stopReason = (result && result.stopReason) || null;
      if (stopReason === 'refusal') {
        const detail = refusalDetail(result);
        if (detail || !assistantText.trim()) throw new AcpError(detail
          ? '后端拒绝本轮请求（refusal）：' + detail
          : '后端拒绝本轮请求（refusal），未提供具体原因；可在原后端使用同一模型重试，检查登录状态、额度和模型权限');
      }
      if (stopReason !== 'cancelled') thread.instructionsSent = true;
      if (stopReason === 'cancelled') cancelled = true;
      const finalText = assistantText || '';
      return {
        text: finalText,
        status: stopReason,
        usage: usage || {},
        items: buildItems(options.onItem, thoughtText, finalText, cancelled),
      };
    } catch (error) {
      if (timedOut) {
        // Mirror codex-pool.cjs: interrupt the agent, then report the partial
        // reply rather than losing it.
        try {
          this.notify('session/cancel', { sessionId });
        } catch {}
        throw new AcpError(
          'acp turn timed out after ' + timeoutMs + 'ms' + (assistantText ? ' (partial reply kept)' : ''),
          error,
        );
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.activeTurns.delete(threadKey);
      unsubscribe();
    }
  }

  /** One `session/update` payload -> `onDelta`/`onItem` calls. */
  _handleUpdate(update, sink) {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const chunk = textOf(update.content);
      if (!chunk) return;
      sink.onText(chunk);
      if (typeof sink.onDelta === 'function') sink.onDelta(chunk);
      // The room UI renders codex item types (`room-ui.js#describeTool`), so a
      // raw ACP update would show up as a bare `· agent_message_chunk`.
      if (typeof sink.onItem === 'function') sink.onItem({ type: 'agentMessage', text: chunk });
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const chunk = textOf(update.content);
      if (!chunk) return;
      sink.onThought(chunk);
      if (typeof sink.onItem === 'function') sink.onItem({ type: 'reasoning', text: chunk });
      return;
    }
    if (typeof sink.onItem !== 'function') {
      if (kind === 'usage_update') sink.onUsage(usageOf(update));
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      sink.onItem({
        type: 'command',
        command: update.title || update.kind || 'tool call',
        status: update.status || 'in_progress',
        toolCallId: update.toolCallId,
      });
      return;
    }
    if (kind === 'usage_update') {
      sink.onUsage(usageOf(update));
      return;
    }
    if (kind === 'plan' || kind === 'available_commands_update' || kind === 'current_mode_update' ||
        kind === 'config_option_update' || kind === 'session_info_update') {
      if (kind === 'config_option_update' && update.configOptions) {
        this.learnConfigOptions(update.configOptions);
        this._capabilities = null;
      }
      sink.onItem({ type: kind });
    }
  }

  /**
   * ACP's `session/cancel` is a NOTIFICATION, not a request: there is nothing
   * to await, so this resolves immediately. It is safe with no turn running
   * (the agent ignores an unknown session: dsh-acp/lib/index.js:1313-1316) and
   * it is safe to call twice.
   */
  async interrupt(threadKey) {
    const thread = this.threads.get(threadKey);
    if (!thread) return false;
    if (!this.activeTurns.get(threadKey)) return false;
    this.notify('session/cancel', { sessionId: thread.id });
    return true;
  }
}

/** ACP content block -> plain text (content may be a block, an array, or a string). */
function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (typeof content !== 'object') return '';
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  if (typeof content.text === 'string') return content.text;
  if (content.content !== undefined) return textOf(content.content);
  return '';
}

/** `usage_update` -> the `{ total, modelContextWindow }` shape room.cjs reads. */
function usageOf(update) {
  const used = Number(update.used);
  const size = Number(update.size);
  if (!Number.isFinite(used) && !Number.isFinite(size)) return {};
  const out = { total: {} };
  if (Number.isFinite(used)) out.total.totalTokens = used;
  if (Number.isFinite(size)) out.modelContextWindow = size;
  return out;
}

/** Keep the turn's item log in the same rough shape as codex-pool.cjs's. */
function buildItems(onItem, thoughtText, finalText, cancelled) {
  void onItem;
  const items = [];
  if (thoughtText) items.push({ type: 'reasoning', text: thoughtText });
  if (finalText) items.push({ type: 'agentMessage', text: finalText });
  if (cancelled) items.push({ type: 'error', message: 'cancelled' });
  return items;
}

module.exports = {
  AcpPool,
  AcpConnection,
  AcpError,
  resolveAgentCommand,
  childEnv,
  defaultSpawn,
  answerPermission,
  usageOf,
  textOf,
  DEFAULT_PROXY,
  PROTOCOL_VERSION,
  DEFAULT_EFFORTS,
  DEFAULT_EFFORT,
};
