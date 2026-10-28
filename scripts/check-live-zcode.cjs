'use strict';
// Explicit real-account smoke: one or two short prompts in isolated workspaces.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { adapt } = require('../standalone/discovery.cjs');
const { ZcodePool } = require('../lib/zcode-pool.cjs');
(async () => {
  if (!process.env.ZCODE_EXE) throw new Error('Set ZCODE_EXE to the installed ZCode.exe');
  const home = fs.mkdtempSync(path.resolve('output/zcode-live-'));
  const launch = adapt('zcode', process.env.ZCODE_EXE).launch;
  const pool = new ZcodePool({ ...launch, cwd: home, onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }) });
  const report = { home, backend: 'ZCode desktop account', model: null, generationRequests: 0, checks: [] };
  try {
    await pool.start();
    const probe = await pool.request('session/new', { cwd: home, mcpServers: [] });
    const option = probe.configOptions.find(o => o.category === 'model');
    report.model = process.env.ZCODE_MODEL || option.currentValue;
    assert.ok(option.options.some(m => m.value === report.model), 'requested model must be advertised');
    await pool.request('session/close', { sessionId: probe.sessionId });
    const ids = [];
    for (let i = 0; i < Number(process.env.ZCODE_TURNS || 2); i++) {
      const thread = await pool.openThread('live-' + i, { cwd: home, model: report.model, strictModel: true, sessionConfig: { preset: 'native', permission: 'build' } });
      ids.push(thread.id); report.sessionIds = [...ids]; const deltas = [];
      report.generationRequests++;
      const reply = await pool.runTurn('live-' + i, { text: `Reply exactly ZCODE_ACCOUNT_OK_${i}. Do not use tools.`, effort: 'low', onDelta: d => deltas.push(d), timeoutMs: 90000 });
      assert.match(reply.text, new RegExp('ZCODE_ACCOUNT_OK_' + i)); assert.equal(deltas.join(''), reply.text);
      report.checks.push({ reply: reply.text, streamChunks: deltas.length, appliedConfig: thread.appliedSessionConfig });
    }
    assert.equal(new Set(ids).size, ids.length); report.independentSessions = ids.length > 1 ? true : null; report.ok = true;
  } catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
  finally { await pool.stop(); fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
})();
