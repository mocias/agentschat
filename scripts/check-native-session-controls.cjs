'use strict';
// Capability queries and empty native sessions only. Never sends turn/start or session/prompt.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const ownRequire = createRequire(__filename);
const source = process.env.CONTROLS_ASAR || path.resolve('.');
const { BackendDiscovery } = ownRequire(path.join(source, 'standalone/discovery.cjs'));
const { querySessionControls } = ownRequire(path.join(source, 'standalone/session-controls.cjs'));
const { DshSessionPool } = ownRequire(path.join(source, 'standalone/dsh-session-pool.cjs'));
const { CodexThreadPool } = ownRequire(path.join(source, 'lib/codex-pool.cjs'));

(async () => {
  const home = fs.mkdtempSync(path.resolve('output/native-session-controls-'));
  const rows = await new BackendDiscovery({ dir: process.env.CONTROLS_DISCOVERY_DATA || home }).scan();
  const checks = []; let generationRequests = 0;
  for (const backend of ['dsh', 'codex']) {
    const launch = rows.find(r => r.id === backend)?.selected?.launch;
    assert.ok(launch, backend + ' unavailable');
    const capabilities = await querySessionControls(backend, launch, home, home);
    const presets = capabilities.presets.filter(p => !p.unavailable);
    assert.ok(presets.length >= 2);
    const pool = backend === 'dsh' ? new DshSessionPool({ ...launch, cwd: home, dshControlsRoot: path.join(home, 'controls') }) : new CodexThreadPool({ ...launch, cwd: home });
    const request = pool.request.bind(pool);
    pool.request = async (method, params, options) => { if (['turn/start', 'session/prompt'].includes(method)) { generationRequests++; throw new Error('Generation forbidden in this check'); } return request(method, params, options); };
    try {
      await pool.start();
      let model;
      if (backend === 'dsh') {
        const probe = await pool.request('session/new', { cwd: home, mcpServers: [] });
        model = probe.configOptions.find(option => option.category === 'model').currentValue;
        await pool.request('session/close', { sessionId: probe.sessionId });
      } else {
        const models = (await pool.listModels()).filter(m => !m.hidden);
        const selected = models.find(m => m.isDefault) || models[0]; model = selected.model || selected.id;
      }
      for (const [i, permission] of capabilities.permissions.entries()) {
        const preset = presets[i % presets.length].id;
        const config = { permission: permission.id, preset };
        const thread = await pool.openThread('check-' + i, { cwd: home, model, strictModel: true, sandbox: permission.id, approvalPolicy: permission.id === 'danger-full-access' ? 'never' : 'on-request', sessionConfig: config });
        if (backend === 'dsh') assert.deepEqual(thread.appliedSessionConfig, config);
        else assert.equal(thread.sandbox, permission.id);
        if (backend === 'dsh') assert.equal(thread.appliedModel, true);
        checks.push({ backend, requested: config, nativeSessionCreated: Boolean(thread.id), ...(backend === 'dsh' ? { applied: thread.appliedSessionConfig } : { appliedSandbox: thread.sandbox }) });
        pool.closeThread('check-' + i);
      }
    } finally { await pool.stop(); }
    fs.writeFileSync(path.join(home, backend + '-capabilities.json'), JSON.stringify(capabilities, null, 2));
  }
  assert.equal(generationRequests, 0);
  const report = { ok: true, home, source, checks, generationRequests, note: 'Native empty-session configuration verified; real model replies and tool execution were not requested.' };
  fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
