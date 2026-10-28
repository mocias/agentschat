'use strict';
/**
 * Minimal client for the `codex app-server` stdio JSON-RPC surface.
 *
 * Why app-server and not `codex exec`: `codex exec` costs ~20s of cold start
 * per message (process boot + MCP servers + auth + model load), while a warm
 * app-server thread settles a turn in ~1.4s. The room therefore keeps exactly
 * ONE app-server process alive and gives every agent its own thread inside it.
 *
 * Framing: newline-delimited JSON-RPC 2.0 on stdin/stdout. stderr is logs.
 * Hard rule from the protocol: any frame carrying BOTH `id` and `method` is a
 * server->client REQUEST and must be answered, otherwise the turn wedges.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Where a `codex` native binary may live. First hit wins. */
function resolveCodexBinary(configured) {
  const explicit = [configured, process.env.AGENT_ROOM_CODEX_PATH].filter(Boolean);
  for (const p of explicit) {
    if (p && fs.existsSync(p)) return p;
  }

  // npm global install: @openai/codex ships the real binary inside a
  // platform-specific optional dependency.
  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex') : null,
  ].filter(Boolean);

  const hits = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, 0, 6, (file) => {
      if (path.basename(file).toLowerCase() === 'codex.exe') hits.push(file);
    });
  }
  // Prefer the vendor binary of the npm package over a desktop-installed copy.
  const vendor = hits.find((h) => /vendor[\\/].*[\\/]bin[\\/]codex\.exe$/i.test(h));
  if (vendor) return vendor;
  if (hits.length) return hits[0];
  return 'codex';
}

function walk(dir, depth, maxDepth, visit) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, maxDepth, visit);
    else if (entry.isFile()) visit(full);
  }
}

const DEFAULT_PROXY = process.env.AGENT_ROOM_PROXY || null;
const { childEnv } = require('./backend-env.cjs');

/** Standalone spawner: a plain pipe-backed child, same surface the host passes. */
function defaultSpawn(binary, argv, options) {
  return spawn(binary, argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

class CodexError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CodexError';
    this.detail = detail;
  }
}

/**
 * Serializes codex project rotations across every pool in this process.
 *
 * A project is a property of the *harness's codex store*, not of one room's
 * pool: every room spawns its own app-server child, yet all of them list and
 * import into the same store. Two pools rotating at once would each delete the
 * other's fresh project, so the queue lives here, at module scope.
 */
let projectTail = Promise.resolve();

class CodexAppServer {
  constructor(options = {}) {
    this.binary = resolveCodexBinary(options.codexPath);
    this.prefixArgs = Array.isArray(options.codexArgs) ? options.codexArgs : [];
    this.cwd = options.cwd || process.cwd();
    this.env = childEnv({ proxy: options.proxy, env: options.env });
    this.log = options.log || (() => {});
    // Inside DSH the host passes a spawner backed by `ctx.subprocess` so the
    // codex child is torn down with the plugin fiber and its output stays
    // bounded. Standalone we fall back to `node:child_process`.
    this.spawnChild = options.spawnChild || defaultSpawn;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifyHandlers = new Set();
    this.serverRequestHandler = options.onServerRequest || null;
    this.stderrTail = [];
    this.exited = null;
    this.ready = null;
    this.info = null;
    // Whether the child process is currently running. `this.child` alone is not
    // enough: it keeps pointing at a dead process after an exit, so `pid` would
    // keep reporting a corpse and `write` would keep "succeeding" into a closed
    // stdin. Set true once the child is up, false the moment it exits.
    this.alive = false;
    this.exitInfo = null;
    this.stopping = false;
  }

  get pid() {
    // `this.child` keeps pointing at the process after it exits, so reporting
    // `child.pid` unconditionally advertises a corpse: the room would hand the
    // UI a pid for something that is gone and look healthy while answering
    // nothing. `running` is the authority on liveness.
    return this.running ? this.child.pid : null;
  }

  /** The child process is up and can still be written to. */
  get running() {
    return this.alive && !!this.child && !this.child.killed;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const child = this.spawnChild(this.binary, [...this.prefixArgs, 'app-server', '--listen', 'stdio://'], {
        cwd: this.cwd,
        env: this.env,
      });
      this.child = child;
      this.alive = true;
      this.exited = new Promise((resolve) => {
        child.on('exit', (code, signal) => {
          this.alive = false;
          this.exitInfo = { code, signal };
          this.log('codex exited code=' + code + ' signal=' + signal);
          for (const [, entry] of this.pending) {
            entry.reject(new CodexError('codex app-server exited before replying'));
          }
          this.pending.clear();
          resolve({ code, signal });
        });
      });
      child.on('error', (error) => {
        this.log('codex spawn error: ' + error.message);
      });
      // EPIPE on a child that died mid-write arrives here, asynchronously — the
      // `try` around `stdin.write` in `write()` never sees it. An 'error' event
      // with no listener is fatal at the process level, so without this line a
      // dead app-server takes the whole host down instead of just the turn.
      child.stdin.on('error', (error) => {
        this.log('codex stdin error: ' + error.message);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        if (/Reading additional input from stdin/i.test(text)) return;
        this.stderrTail.push(text);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        this.log('[codex stderr] ' + text.split('\n')[0].slice(0, 300));
      });

      const result = await this.request('initialize', {
        clientInfo: { name: 'dsh-agent-room', title: 'DSH Agent Room', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.info = result;
      return result;
    })();
    // A dead child must not stay memoized as a healthy connection. Clearing the
    // memo on exit lets the next `start()` spawn a replacement, which is the
    // difference between "the room recovers" and "the room answers 200 forever
    // while every turn silently disappears into a dead pipe".
    void this.ready.then(
      () => undefined,
      () => undefined,
    );
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
   * Hook for subclasses: called once when the child exits unexpectedly. The
   * base pool only forgets its connection state; the thread pool also has to
   * drop its thread records, because those ids belong to the dead process.
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
        this.log('codex: unparsable frame ' + line.slice(0, 200));
        continue;
      }
      this._dispatch(frame);
    }
  }

  _dispatch(frame) {
    // Server -> client REQUEST: must be answered or the turn stalls.
    if (frame.id !== undefined && frame.method !== undefined) {
      void this._answerServerRequest(frame);
      return;
    }
    if (frame.id !== undefined) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (frame.error) {
        entry.reject(new CodexError(describeError(frame.error), frame.error));
      } else {
        entry.resolve(frame.result);
      }
      return;
    }
    if (frame.method) {
      for (const handler of this.notifyHandlers) {
        try {
          handler(frame.method, frame.params || {});
        } catch (error) {
          this.log('notify handler threw: ' + error.message);
        }
      }
    }
  }

  async _answerServerRequest(frame) {
    const { id, method, params } = frame;
    let result = {};
    try {
      if (this.serverRequestHandler) {
        const custom = await this.serverRequestHandler(method, params || {});
        if (custom !== undefined) result = custom;
      }
    } catch (error) {
      this.log('server request handler failed: ' + error.message);
    }
    this.write({ jsonrpc: '2.0', id, result });
    this.log('answered server request ' + method);
  }

  write(frame) {
    if (!this.running) {
      // A frame written into a dead child is not "sent and unanswered", it is
      // *dropped*: the promise registered by `request` would never settle, and
      // its timer is unref'd, so the caller could wait forever while the
      // process looks idle. Failing here turns a silent hang into a message the
      // room can show and retry.
      const reason = this.exitInfo
        ? `codex app-server exited (code=${this.exitInfo.code} signal=${this.exitInfo.signal})`
        : 'codex app-server is not running';
      if (frame && frame.id !== undefined) {
        const entry = this.pending.get(frame.id);
        if (entry) {
          this.pending.delete(frame.id);
          entry.reject(new CodexError(reason));
        }
      }
      return false;
    }
    try {
      this.child.stdin.write(JSON.stringify(frame) + '\n');
      return true;
    } catch (error) {
      this.log('codex write failed: ' + error.message);
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
          reject(new CodexError('codex request timed out: ' + method));
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

  onNotification(handler) {
    this.notifyHandlers.add(handler);
    return () => this.notifyHandlers.delete(handler);
  }

  async listModels() {
    const result = await this.request('model/list', {});
    return (result && (result.data || result.models)) || [];
  }

  async startThread(options = {}) {
    const params = {
      model: options.model,
      cwd: options.cwd || this.cwd,
      approvalPolicy: options.approvalPolicy || 'never',
      sandbox: options.sandbox || 'read-only',
    };
    if (options.baseInstructions) params.baseInstructions = options.baseInstructions;
    if (options.developerInstructions) params.developerInstructions = options.developerInstructions;
    if (options.serviceTier) params.serviceTier = options.serviceTier;
    if (options.projectId) params.projectId = options.projectId;
    if (options.mcpServers?.length) {
      const { mcpConfig } = require('./poll-mcp.cjs');
      params.config = { 'mcp_servers.agent_room': {
        ...mcpConfig(options.mcpServers).agent_room, enabled: true, required: true,
        tools: Object.fromEntries(require('./polls.cjs').toolNames.map(name => [name, { approval_mode: 'approve' }])),
      } };
    }
    const result = await this.request('thread/start', params);
    return result;
  }

  async stop() {
    // A deliberate stop is not a crash: mark it so the exit handler does not
    // clear `ready` (which would let a later `start()` spawn a fresh child
    // during teardown) and does not log a death the operator did not have.
    this.stopping = true;
    if (!this.child || this.child.killed) {
      this.alive = false;
      return;
    }
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill();
    } catch {}
    // Native helpers can inherit stdio on Windows. Closing our pipes prevents
    // a stopped capability probe from keeping the host alive indefinitely.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream?.destroy?.();
    this.alive = false;
  }
}

/**
 * One room record -> one `thread/inject_items` item.
 *
 * The role/parts shape is pinned by the server's own validator, not by taste:
 * see `injectItems` above and the probe report it cites.
 */
function toUserMessageItem(record) {
  if (record && record.type === 'message' && Array.isArray(record.content)) return record;
  const text = typeof record === 'string' ? record : record && record.text;
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: String(text == null ? '' : text) }],
  };
}

function describeError(error) {
  if (!error) return 'unknown codex error';
  if (typeof error === 'string') return error;
  const parts = [];
  if (error.message) parts.push(error.message);
  if (error.data) {
    const data = error.data;
    if (typeof data === 'string') parts.push(data);
    else if (data.detail) parts.push(data.detail);
    else parts.push(JSON.stringify(data).slice(0, 400));
  }
  if (!parts.length) parts.push(JSON.stringify(error).slice(0, 400));
  return parts.join(' — ');
}

/**
 * `thread/start` echoes the sandbox as a `SandboxPolicy` OBJECT, while callers
 * speak in `SandboxMode` strings. Normalize the echo back to a mode string so
 * the thread-reuse comparison in `room.cjs#ensureThread` is apples to apples.
 *
 * Anything unrecognised falls back to what the caller asked for: that is the
 * only value we can defend when the server's echo is a shape we do not know.
 */
function sandboxModeOf(value, fallback) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.type === 'string') {
    switch (value.type) {
      case 'readOnly':
        return 'read-only';
      case 'workspaceWrite':
        return 'workspace-write';
      case 'dangerFullAccess':
        return 'danger-full-access';
      default:
        return fallback;
    }
  }
  return fallback;
}

/**
 * Build the `input` array for one turn.
 *
 * Codex accepts a heterogeneous list, and that union is where an image actually
 * reaches the model: `{type:'localImage', path}` hands it the picture itself.
 *
 * Every attachment's path is ALSO already in the turn text, because the text is
 * one transcript shared by every backend and by the replayed history — an ACP
 * member has no image input at all and would otherwise never learn the file
 * exists. So for an image on a codex member the model gets both the picture and
 * a line naming it. That redundancy is deliberate and cheap; the alternative
 * (per-backend transcripts) would mean a member's history and its transcript no
 * longer agree about what was said.
 *
 * Non-image files stay text-only: codex has no generic "here is a file" input
 * that a model can act on, so the path is the whole message for those.
 *
 * `text_elements: []` is required by the schema even when empty, and the text
 * entry must stay FIRST: it carries the turn's instruction, and a model shown an
 * image before being told what to do tends to answer the picture instead of the
 * question about it.
 */
function buildInput(text, attachments) {
  const input = [{ type: 'text', text, text_elements: [] }];
  const files = Array.isArray(attachments) ? attachments : [];
  for (const attachment of files) {
    if (!attachment || !attachment.isImage || !attachment.path) continue;
    input.push({ type: 'localImage', path: String(attachment.path) });
  }
  return input;
}

/**
 * Pool of warm codex threads behind ONE app-server process.
 *
 * Every thread is claimed by exactly one room member, so turns on different
 * threads genuinely run in parallel (verified: 3 concurrent threads, no
 * cross-talk) while turns on the same thread are serialized by a queue.
 */
class CodexThreadPool extends CodexAppServer {
  constructor(options = {}) {
    super(options);
    this.threads = new Map();
    this.queues = new Map();
    this.activeTurns = new Map();
    /** Learned per-model capability fixes; see `_learnFromRejection`. */
    this.capabilityOverrides = new Map();
    this._capabilities = null;
    /**
     * Grouping every thread this pool opens into one codex project, so the
     * codex GUI lists a harness's conversations under one heading instead of
     * flat. Off unless a name is configured: the feature writes to codex's own
     * project store, so it must be opt-in.
     */
    this.projectName = options.projectName || null;
    this.projectRoot = options.projectRoot || this.cwd;
  }

  async openThread(key, options = {}) {
    const started = await this.startThread(options);
    if (options.strictModel && started.model !== options.model) throw new CodexError('后端未使用指定的固定模型');
    const thread = started.thread || {};
    const record = {
      key,
      id: thread.id,
      model: started.model,
      reasoningEffort: started.reasoningEffort,
      // The server echoes `sandbox` as a policy object, never as the mode string
      // we asked with. Recording that echo verbatim would make every later
      // `existing.sandbox === sandbox` test fail, and the room would silently
      // rebuild the thread on EVERY turn — one fresh codex rollout per message,
      // a cold start each time, and a member that never remembers the room.
      sandbox: sandboxModeOf(started.sandbox, options.sandbox || 'read-only'),
      cwd: started.cwd,
      options,
    };
    this.threads.set(key, record);
    if (options.mcpServers?.length) {
      // Startup can precede the first model-visible MCP catalogue refresh.
      // Validate the session-bound connection before advertising it in CHAT.
      try {
        const check = await this.request('mcpServer/tool/call', {
          threadId: record.id, server: 'agent_room', tool: 'poll_list', arguments: {},
        }, { timeoutMs: 15000 });
        if (check?.isError) throw new Error('MCP unavailable');
      } catch {
        this.threads.delete(key);
        throw new CodexError('Room 投票工具连接未就绪，请重试');
      }
    }
    // Nothing is grouped here on purpose: `project/import` refuses a thread that
    // has no turns yet ("thread not found"), and a freshly started thread is
    // exactly that. The caller syncs after a turn, which is the first moment the
    // thread exists in the store the import consults.
    return record;
  }

  /**
   * Make the configured codex project contain `threadIds` **in addition to**
   * whatever it already contains.
   *
   * The public API cannot grow a project in place: `project/import` caches its
   * response under `idempotencyKey` and returns that cache on every replay
   * (same key, new threads → nothing gets attached), while a fresh key mints a
   * *second* project with the same name. There is also no thread→project
   * assignment method — `project/update` takes no thread list. So the only way
   * to add one thread is to import the complete list under a new key and delete
   * the project being replaced. That is a rotation: the project id changes and
   * any manual regroup the user did inside it is lost. Both costs are accepted
   * deliberately; see README "工作区归组".
   *
   * Membership is read back from the store and unioned rather than replaced,
   * for two reasons. Rooms are independent: a room that imported only its own
   * members would rotate away every other room's threads. And a group is a
   * property of the harness, not of a room — the user asked for one workspace
   * per harness holding all of its conversations.
   *
   * Rotations are serialized process-wide and skipped when the membership is
   * already exactly right, so a room that opens three members does not rotate
   * three times and two rooms cannot delete each other's work.
   *
   * @param {string[]} threadIds - threads to add. Threads with no turns yet are
   *   rejected by the server as "thread not found", so only offer threads that
   *   have spoken.
   * @returns {Promise<string|null>} the project id, or null when grouping is off.
   */
  syncProject(threadIds) {
    if (!this.projectName) return Promise.resolve(null);
    // Explicit ids only, and never "everything this pool has opened": the pool's
    // `threads` map also holds threads that were prewarmed but never spoke, and
    // `project/import` rejects a turn-less thread outright ("thread not found"),
    // which would abort the whole rotation. The caller knows which thread just
    // finished a turn; that is the only id safe to offer.
    const ids = Array.from(new Set((threadIds || []).filter(Boolean)));
    if (!ids.length) return Promise.resolve(null);
    const stateKey = `${this.projectName}\u0000${this.projectRoot}`;
    const run = () => this._syncProject(stateKey, ids);
    const next = projectTail.then(run, run);
    projectTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * One rotation. Callers are already serialized by `syncProject`.
   *
   * `project/list` is the authority on what exists, not a local memo, because
   * an earlier process (or a user clicking around in the codex GUI) may have
   * created, renamed or deleted the group since this process started.
   */
  async _syncProject(stateKey, ids) {
    const listed = await this.request('project/list', { limit: 200 });
    const sameName = ((listed && listed.data) || []).filter((project) => project.name === this.projectName);
    const current = new Set();
    for (const project of sameName) {
      for (const id of await this._threadsInProject(project.id)) current.add(id);
    }
    const desired = new Set(current);
    for (const id of ids) desired.add(id);
    // Already exactly right: a previous process grouped this set. Adopting it
    // avoids a pointless rotation that would churn the project id and discard
    // the user's manual ordering inside it.
    if (sameName.length === 1 && desired.size === current.size) {
      return sameName[0].id;
    }
    const want = Array.from(desired).sort();
    const imported = await this.request('project/import', {
      name: this.projectName,
      roots: [{ path: this.projectRoot }],
      threads: want,
      idempotencyKey: `${this.projectName}:group:${Date.now()}`,
    });
    const project = imported && imported.project;
    if (!project || !project.id) throw new CodexError('project/import returned no project');
    // Delete what this import replaced. Leaving it behind is exactly the
    // duplicate-project failure the rotation exists to avoid.
    for (const stale of sameName) {
      if (stale.id === project.id) continue;
      try {
        await this.request('project/delete', { projectId: stale.id });
      } catch (error) {
        this.log(`could not delete replaced project ${stale.id}: ${error.message}`);
      }
    }
    this.log(`grouped ${want.length} thread(s) into codex project "${this.projectName}" (${project.id})`);
    return project.id;
  }

  /** The set of thread ids the store currently records as belonging to `projectId`. */
  async _threadsInProject(projectId) {
    const listed = await this.request('thread/list', { limit: 500 });
    const out = new Set();
    for (const thread of (listed && listed.data) || []) {
      if (thread.projectId === projectId) out.add(thread.id);
    }
    return out;
  }

  getThread(key) {
    return this.threads.get(key);
  }

  closeThread(key) {
    const record = this.threads.get(key);
    if (record) this.threads.delete(key);
    if (record) this.write({ jsonrpc: '2.0', id: this.nextId++, method: 'thread/unsubscribe', params: { threadId: record.id } });
  }

  /**
   * Run one turn on a thread and collect the assistant reply.
   * `onDelta(text)` receives incremental text when the server emits it; the
   * authoritative reply is always taken from `item/completed` at the end.
   */
  runTurn(threadKey, options = {}) {
    return this._enqueue(threadKey, () => this._runTurn(threadKey, options));
  }

  /**
   * Run `task` after everything already queued for this thread key.
   *
   * Every operation that touches a thread's model-visible history (a turn, or a
   * context injection) MUST go through here. `thread/inject_items` appends to
   * that history out of band, so firing one while a turn is in flight would
   * splice a message into the middle of a turn the model has already started —
   * the injected line could then land *after* the reply that was supposed to
   * answer it.
   */
  _enqueue(threadKey, task) {
    const previous = this.queues.get(threadKey) || Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(threadKey, next.catch(() => {}));
    return next;
  }

  /**
   * Insert `text` into the turn that is running on this thread RIGHT NOW.
   *
   * Deliberately NOT routed through `_enqueue`, and that is the whole point of
   * the method rather than an oversight. Every other history-touching call is
   * serialized per thread, which is exactly wrong here: steer exists to reach a
   * turn *while it is still running*. Queueing it would place it behind the very
   * turn it is meant to redirect, so the correction would be delivered after the
   * reply it was answering had already been sent — the button would look like it
   * worked, and the member would answer a question the user had already moved on
   * from.
   *
   * @param {string} threadKey
   * @param {string} text
   * @returns {Promise<{ok: true, turnId: string}|{ok: false, reason: string, error?: string}>}
   *   `reason` is one of 'no-thread' (no open thread for this key),
   *   'no-active-turn' (nothing running, or it ended before the frame landed),
   *   'not-steerable' (the server refused: e.g. `/review`, `/compact`),
   *   'not-running' (the backend process is gone), or 'error' (anything else).
   */
  async steer(threadKey, text) {
    const thread = this.threads.get(threadKey);
    if (!thread) return { ok: false, reason: 'no-thread' };
    if (!this.running) return { ok: false, reason: 'not-running' };
    const turnId = this.activeTurns.get(threadKey);
    if (!turnId) return { ok: false, reason: 'no-active-turn' };
    try {
      const result = await this.request(
        'turn/steer',
        {
          threadId: thread.id,
          // The server refuses unless this is the turn it is running now. We
          // could omit it and let the server pick, but then a stale steer (the
          // turn ended and another started between our read and the send) would
          // be spliced into somebody else's reply. Sending our own id turns that
          // race into a refusal we can report.
          expectedTurnId: turnId,
          input: [{ type: 'text', text: String(text), text_elements: [] }],
        },
        // A steer is a real-time gesture, not a turn: the caller is a UI button
        // and must get an answer now. A misbehaving server must not be able to
        // hold it open for the 10-minute default.
        { timeoutMs: 10000 },
      );
      return { ok: true, turnId: (result && result.turnId) || turnId };
    } catch (error) {
      const message = (error && error.message) || String(error);
      // The turn can finish between the check above and the frame reaching the
      // server; the server reports both that case and an id mismatch with the
      // same "this is not the active turn" idea.
      if (/no active turn to steer|expected active turn id/.test(message)) {
        return { ok: false, reason: 'no-active-turn', error: message };
      }
      if (/not steerable|ActiveTurnNotSteerable/i.test(message)) {
        return { ok: false, reason: 'not-steerable', error: message };
      }
      return { ok: false, reason: 'error', error: message };
    }
  }

  /** Is a turn running on this thread right now? */
  hasActiveTurn(threadKey) {
    return this.activeTurns.has(threadKey);
  }

  /** Declares the capability, so the engine can pick a strategy without probing. */
  get supportsSteer() {
    return true;
  }

  /**
   * The app-server died: its thread ids are worthless, and every record we hold
   * about them is a lie the room would otherwise keep reporting.
   *
   * Dropping them is deliberate, not destructive. `room.cjs#ensureThread` sees
   * no thread and opens a fresh one, and because a fresh thread has no history
   * it also rewinds that member's cursor so the whole log is replayed — the
   * member rejoins the conversation with full context instead of silently
   * answering from a context that no longer exists on the server side.
   */
  _onDeath() {
    super._onDeath();
    const keys = Array.from(this.threads.keys());
    this.threads.clear();
    this.activeTurns.clear();
    // `queues` is deliberately NOT cleared: the per-thread promise chain may
    // still have tasks in flight, and dropping the chain would let a new task
    // for the same thread run concurrently with the dying one, breaking the
    // serialisation that keeps injections and turns from interleaving.
    this._capabilities = null;
    this.capabilityOverrides.clear();
    if (keys.length) this.log('codex died: dropped ' + keys.length + ' thread(s)');
  }

  /** This backend can push a message into a thread without running a turn. */
  get supportsInject() {
    return true;
  }

  /**
   * Wait until everything already queued for this thread has finished.
   *
   * Because `injectItems` and `runTurn` share one queue, awaiting this barrier
   * proves that every real-time push issued before the call has landed. The
   * room uses it before computing a turn's replay delta, so the delta reflects
   * injections that actually completed instead of racing them — without this,
   * a record could be excluded from the delta (as "in flight") and then also
   * never be injected, dropping it from the member's view entirely.
   */
  flush(threadKey) {
    return this._enqueue(threadKey, () => undefined);
  }

  /**
   * Append records to a thread's model-visible history without starting a turn.
   *
   * Kept for method-surface parity with `AcpPool`, which answers
   * `{injected: 0, skipped: 'unsupported'}` because the ACP protocol has no way
   * to add context to a session. The one caller this was written for —
   * `room.cjs#_overhear`, which pushed each record into every other member's
   * thread the moment it was appended — is gone: room delivery is now one
   * channel (per-member segments handed over on a tick), so nothing in the room
   * calls this any more. Probing code still gets an honest "yes, this backend
   * can do it" instead of a crash.
   *
   * Verified behaviour of `thread/inject_items` (see
   * `_research/spike-codex/INJECT_ITEMS_REPORT.md` for the raw probes):
   *   - the only accepted item shape is a full message with an explicit role and
   *     an array of content parts:
   *       {"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}
   *   - a bare `{"type":"input_text"}` or a `role:"system"` item is *accepted* by
   *     the validator but never reaches the model, so the shape above is
   *     load-bearing, not cosmetic;
   *   - `role` must be `user`. An `assistant`-role injection makes the model
   *     claim those words as its own speech ("SELF"), which is exactly the
   *     impersonation bug the transcript framing exists to avoid;
   *   - injected content is billed and immediately model-visible, but produces
   *     no Turn and no `ThreadItemEntry`, so it cannot be read back through the
   *     API. Delivery is fire-and-verify-by-effect only.
   *
   * @param {string} threadKey
   * @param {Array<{text: string}>|Array<object>} records  room records, or raw items
   * @returns {Promise<{injected: number}>}
   */
  injectItems(threadKey, records) {
    const list = Array.from(records || []).filter(Boolean);
    if (!list.length) return Promise.resolve({ injected: 0 });
    return this._enqueue(threadKey, () => this._injectItems(threadKey, list));
  }

  async _injectItems(threadKey, records) {
    const thread = this.threads.get(threadKey);
    if (!thread) return { injected: 0, skipped: 'no-thread' };
    const items = records.map((record) => toUserMessageItem(record));
    try {
      await this.request('thread/inject_items', { threadId: thread.id, items }, { timeoutMs: 60000 });
      return { injected: items.length };
    } catch (error) {
      // Injection is an optimisation for "hearing", never a correctness
      // requirement: the next turn's own delta replay still carries the full
      // transcript, so a failed injection degrades to the old behaviour
      // instead of dropping a message or breaking the room.
      this.log('inject_items failed: ' + (error && error.message));
      return { injected: 0, error: (error && error.message) || String(error) };
    }
  }

  async _runTurn(threadKey, options) {
    const thread = this.threads.get(threadKey);
    if (!thread) throw new CodexError('unknown thread key: ' + threadKey);
    const onDelta = options.onDelta || (() => {});
    const onItem = options.onItem || (() => {});

    const params = {
      threadId: thread.id,
      input: buildInput(options.text, options.attachments),
    };
    if (options.effort) params.effort = options.effort;
    if (options.serviceTierForTurn) params.serviceTierForTurn = options.serviceTierForTurn;
    if (options.sandboxPolicy) params.sandboxPolicy = options.sandboxPolicy;
    if (options.approvalPolicy) params.approvalPolicy = options.approvalPolicy;
    if (options.collaborationMode) params.collaborationMode = options.collaborationMode;

    let assistantText = '';
    let finishSignal = null;
    const settled = new Promise((resolve) => {
      finishSignal = resolve;
    });
    let turnId = null;
    // `Turn` carries no usage field: token accounting arrives as its own
    // `thread/tokenUsage/updated` notification, so capture it here.
    let tokenUsage = null;

    const unsubscribe = this.onNotification((method, p) => {
      if (p.threadId && p.threadId !== thread.id) return;
      if (method === 'turn/started' && p.turn) {
        turnId = p.turn.id;
        this.activeTurns.set(threadKey, turnId);
        if (options.onTurnStarted) options.onTurnStarted(turnId);
        return;
      }
      if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
        onDelta(p.delta);
        return;
      }
      if (method === 'item/completed' && p.item) {
        const item = p.item;
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          assistantText = item.text;
        }
        onItem(item);
        return;
      }
      if (method === 'thread/tokenUsage/updated' && p.tokenUsage) {
        tokenUsage = p.tokenUsage;
        return;
      }
      if (method === 'turn/completed' && p.turn) {
        finishSignal({ turn: p.turn });
        return;
      }
      if (method === 'error') {
        const message = (p && p.error && p.error.message) || (p && p.message) || JSON.stringify(p || {});
        onItem({ type: 'error', message, willRetry: !!(p && p.willRetry) });
        return;
      }
    });

    try {
      await this.request('turn/start', params);
    } catch (error) {
      unsubscribe();
      this.activeTurns.delete(threadKey);
      throw error;
    }

    const timeoutMs = options.timeoutMs || 300000;
    const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    // A child that dies mid-turn never emits `turn/completed`, so without a
    // death racer this turn would sit here until the full timeout. That is the
    // worst possible failure shape: the room looks alive, the member looks
    // "thinking", and the user waits minutes for an answer that cannot come.
    const died = this.exited
      ? this.exited.then(() => ({ died: true }))
      : new Promise(() => {});
    const outcome = await Promise.race([settled, timer, died]);
    unsubscribe();
    this.activeTurns.delete(threadKey);

    if (outcome && outcome.died) {
      throw new CodexError('codex app-server exited mid-turn' + (assistantText ? ' (partial reply kept)' : ''));
    }

    if (!outcome) {
      if (turnId) {
        this.write({ jsonrpc: '2.0', id: this.nextId++, method: 'turn/interrupt', params: { threadId: thread.id, turnId } });
      }
      throw new CodexError('turn timed out after ' + timeoutMs + 'ms' + (assistantText ? ' (partial reply kept)' : ''));
    }

    const finalText = assistantText || (outcome.turn.items || [])
      .filter((item) => item.type === 'agentMessage')
      .map((item) => item.text || '')
      .join('\n');

    // A failed turn still resolves `turn/completed`; surface the error so the
    // room can show it instead of silently posting an empty bubble.
    if (!finalText && outcome.turn.status === 'failed') {
      const failure = outcome.turn.error || {};
      const message = failure.message || 'codex turn failed';
      // `model/list` under-reports capabilities: `none` is absent from every
      // entry but accepted by 5 of 7 models. When the server rejects a setting
      // it also tells us the legal set, so learn it and let the caller retry
      // instead of failing the whole turn.
      this._learnFromRejection(options.effort, message);
      throw new CodexError(message, failure);
    }

    return {
      text: finalText,
      status: outcome.turn.status,
      usage: tokenUsage,
      items: outcome.turn.items || [],
    };
  }

  /**
   * The server's rejection message is the authoritative capability source:
   *   "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model.
   *    Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'."
   * Record it so the next turn picks a legal value without a second failure.
   */
  _learnFromRejection(requested, message) {
    if (!requested || typeof message !== 'string') return;
    const match = /Unsupported value: '([^']*)' is not supported with the '([^']+)' model\. Supported values are: ([^.]+)\./.exec(
      message,
    );
    if (!match) return;
    const [, , model, list] = match;
    const supported = list
      .split(/,| and /)
      .map((piece) => piece.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    if (!supported.length) return;
    const caps = this.capabilityOverrides.get(model) || {};
    caps.efforts = supported;
    caps.rejected = requested;
    this.capabilityOverrides.set(model, caps);
    // The advertised table was wrong for this model, so drop the cache and let
    // the next `modelCapabilities()` rebuild from the learned set.
    this._capabilities = null;
    this.log(`learned capabilities for ${model}: efforts=${supported.join(',')}`);
  }

  /** Per-model capability facts the room needs to pick a legal effort. */
  async modelCapabilities() {
    if (this._capabilities) return this._capabilities;
    const models = await this.listModels();
    const map = new Map();
    for (const entry of models) {
      const id = entry.id || entry.model || entry.slug;
      if (!id) continue;
      const override = this.capabilityOverrides.get(id);
      const advertised = (entry.supportedReasoningEfforts || []).map((x) => x.reasoningEffort);
      map.set(id, {
        id,
        displayName: entry.displayName || id,
        // A learned set always wins over the advertised one.
        efforts: (override && override.efforts) || advertised,
        advertisedEfforts: advertised,
        learned: !!(override && override.efforts),
        defaultEffort: entry.defaultReasoningEffort || null,
        serviceTiers: (entry.serviceTiers || []).map((x) => x.id),
        hidden: !!entry.hidden,
      });
    }
    this._capabilities = map;
    return map;
  }

  async interrupt(threadKey) {
    const thread = this.threads.get(threadKey);
    const turnId = this.activeTurns.get(threadKey);
    if (!thread || !turnId) return false;
    this.write({ jsonrpc: '2.0', id: this.nextId++, method: 'turn/interrupt', params: { threadId: thread.id, turnId } });
    return true;
  }
}

module.exports = {
  CodexAppServer,
  CodexThreadPool,
  CodexError,
  resolveCodexBinary,
  childEnv,
  sandboxModeOf,
  buildInput,
  DEFAULT_PROXY,
};
