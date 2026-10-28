'use strict';
// Installed runtimes, isolated workspaces. ZCode uses a local fixture provider;
// Qoder cloud generation is opt-in via LIVE_QODER=1. No personal config writes.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { adapt, BackendDiscovery } = require('../standalone/discovery.cjs');
const { NativeModePool } = require('../standalone/native-mode-pool.cjs');
const { ZcodePool } = require('../lib/zcode-pool.cjs');

(async () => {
  const home = fs.mkdtempSync(path.resolve('output/native-new-harnesses-'));
  const rows = process.env.QODER_EXE && process.env.ZCODE_EXE ? [] : await new BackendDiscovery({ dir: home }).scan();
  const report = { home, checks: [], zcodeProvider: 'local fixture (not a real model)', cloudGenerationRequests: 0 };
  for (const backend of (process.env.NATIVE_BACKENDS || 'qoder,zcode').split(',')) {
    const selected = process.env[backend.toUpperCase() + '_EXE'];
    let launch = selected ? adapt(backend, selected).launch : rows.find(r => r.id === backend)?.selected?.launch;
    assert.ok(launch, backend + ' runtime not found');
    const cwd = path.join(home, backend); fs.mkdirSync(cwd);
    let server, mockRequests = 0, permissionRequests = 0, cancelRequestSeen = false;
    const requestedFiles = [];
    const trace = [];
    if (backend === 'zcode') {
      launch = require('../standalone/zcode.cjs').zcodeLaunch(selected || rows.find(r => r.id === backend)?.selected.path, undefined, { desktopAccount: process.env.ZCODE_HOST_FIXTURE === '1' });
      server = http.createServer(async (req, res) => {
        let body = ''; for await (const c of req) body += c;
        const request = JSON.parse(body); mockRequests++;
        trace.push({ kind: 'http', request: mockRequests, lastUser: JSON.stringify(request.messages.filter(m => m.role === 'user').at(-1)?.content).slice(-300) });
        assert.equal(request.model, 'fixture-model');
        if (!cancelRequestSeen && JSON.stringify(request.messages.filter(m => m.role === 'user').at(-1)?.content).includes('BEGIN_CANCEL_CHECK')) {
          cancelRequestSeen = true;
          const timer = setTimeout(() => res.end(), 10000); res.on('close', () => clearTimeout(timer));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (process.env.ZCODE_FIXTURE_TOOLS === '1' && !request.messages.some(m => m.role === 'tool')) {
          const tool = request.tools.find(t => t.function.name === 'Write');
          assert.ok(tool, 'native Write tool advertised');
          const args = { file_path: path.join(cwd, 'permission-marker-' + mockRequests + '.txt'), content: 'isolated permission test' };
          requestedFiles.push(args.file_path);
          res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'write-' + mockRequests, type: 'function', function: { name: 'Write', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
          return;
        }
        for (const content of ['ZCODE_', 'LOCAL_OK']) res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n');
        res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const config = path.join(cwd, 'provider_config.json');
      fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'fixture', providerName: 'Local fixture', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'not-a-secret-local-fixture' }, api: { type: 'openai-chat-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, personalModelIds: ['fixture-model'] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'fixture', modelId: 'fixture-model' } } }));
      const runtimeHome = path.join(cwd, 'native-home'); fs.mkdirSync(path.join(runtimeHome, '.zcode', 'cli'), { recursive: true });
      fs.mkdirSync(path.join(runtimeHome, '.zcode', 'v2'), { recursive: true });
      fs.copyFileSync(config, path.join(runtimeHome, '.zcode', 'v2', 'provider_config.json'));
      fs.writeFileSync(path.join(runtimeHome, '.zcode', 'cli', 'config.json'), JSON.stringify({ features: { mcp: false, subagent: false, memory: false, skill: false }, memory: { use: false }, plugins: { enabled: false }, skills: { enabled: false }, hooks: { enabled: false } }));
      launch.env = { ...launch.env, HOME: runtimeHome, USERPROFILE: runtimeHome, ZCODE_DATA_BASE_DIR: runtimeHome, ZCODE_STORAGE_DIR: path.join(runtimeHome, '.zcode'), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config };
    }
    const Pool = backend === 'qoder' ? NativeModePool : ZcodePool;
    const pool = new Pool({ ...launch, cwd, onPermissionRequest: async p => {
      permissionRequests++;
      if (backend === 'zcode' && process.env.ZCODE_FIXTURE_ALLOW === '1') {
        const input = JSON.parse(p.toolCall.description); assert.ok(requestedFiles.includes(input.file_path));
        const option = p.options.find(o => o.kind === 'allow_once'); assert.ok(option);
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    } });
    if (backend === 'zcode') {
      const dispatch = pool._dispatch.bind(pool), request = pool.nativeRequest.bind(pool);
      pool._dispatch = frame => { if (frame.method === 'session/event') { const e = frame.params; trace.push({ kind: 'event', type: e.type, sessionId: e.sessionId, turnId: e.turnId, inputId: e.payload?.inputId, delta: e.payload?.delta?.slice(0, 80) }); } return dispatch(frame); };
      pool.nativeRequest = async (method, params, options) => { if (['session/send', 'session/stop'].includes(method)) trace.push({ kind: 'request', method, ...params }); return request(method, params, options); };
    }
    try {
      await pool.start();
      const probe = await pool.request('session/new', { cwd, mcpServers: [] });
      const options = probe.configOptions.find(o => o.category === 'model');
      if (backend === 'zcode') fs.writeFileSync(path.join(cwd, 'catalog.json'), JSON.stringify(pool.nativeSessions.get(probe.sessionId), null, 2));
      const model = options.currentValue || options.options[0]?.value;
      assert.ok(model, backend + ' model catalog unavailable');
      await pool.request('session/close', { sessionId: probe.sessionId });
      const threads = [];
      for (const [i, permission] of (backend === 'qoder' ? ['default', 'dontAsk'] : ['build', 'build']).entries()) {
        const config = { preset: 'native', permission };
        const thread = await pool.openThread(String(i), { cwd, model, strictModel: true, sessionConfig: config });
        assert.deepEqual(thread.appliedSessionConfig, config); threads.push(thread.id);
        if (backend === 'zcode' || process.env.LIVE_QODER === '1') {
          if (backend === 'qoder') report.cloudGenerationRequests++;
          const deltas = [];
          const result = await pool.runTurn(String(i), { text: 'Reply exactly NATIVE_QODER_OK. Do not use tools.', onDelta: d => deltas.push(d), timeoutMs: 60000 });
          assert.match(result.text, backend === 'zcode' ? /ZCODE_LOCAL_OK/ : /NATIVE_QODER_OK/);
          assert.equal(deltas.join(''), result.text);
          report.checks.push({ backend, permission, reply: result.text, streamChunks: deltas.length });
        }
      }
      assert.notEqual(threads[0], threads[1]);
      if (backend === 'zcode' && process.env.ZCODE_FIXTURE_TOOLS === '1') {
        assert.equal(permissionRequests, 2);
        for (const file of requestedFiles) assert.equal(fs.existsSync(file), process.env.ZCODE_FIXTURE_ALLOW === '1');
      }
      if (backend === 'zcode' && process.env.ZCODE_FIXTURE_CANCEL === '1') {
        const pending = pool.runTurn('0', { text: 'BEGIN_CANCEL_CHECK', timeoutMs: 60000 }); pending.catch(() => {});
        for (let i = 0; i < 800 && !cancelRequestSeen; i++) await new Promise(r => setTimeout(r, 50));
        assert.ok(cancelRequestSeen); assert.equal(await pool.interrupt('0'), true);
        assert.equal((await pending).status, 'cancelled');
        const resumed = await pool.runTurn('0', { text: 'Reply after cancellation.', timeoutMs: 60000 });
        assert.match(resumed.text, /ZCODE_LOCAL_OK/);
        report.checks.push({ backend, cancellationAndNextTurn: true });
      }
      report.checks.push({ backend, independentSessions: true, model, mockRequests, permissionRequests });
      fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
    } finally { await pool.stop(); fs.writeFileSync(path.join(cwd, 'trace.json'), JSON.stringify(trace, null, 2)); await new Promise(r => server ? server.close(r) : r()); }
  }
  report.ok = true; fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
