'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
(async () => {
  const archive = path.resolve('dist/win-unpacked/resources/app.asar');
  if (process.versions.electron) {
    const nativeRequire = createRequire(path.join(archive, 'package.json'));
    const { adapt } = nativeRequire('./standalone/discovery.cjs');
    const { queryModels } = nativeRequire('./standalone/models.cjs');
    const { querySessionControls } = nativeRequire('./standalone/session-controls.cjs');
    const { AcpPool } = nativeRequire('./lib/acp-backend.cjs');
    const request = AcpPool.prototype.request;
    let generationRequests = 0;
    AcpPool.prototype.request = function(method, ...args) {
      if (['session/send', 'session/prompt', 'turn/start'].includes(method)) { generationRequests++; throw new Error('generation forbidden'); }
      return request.call(this, method, ...args);
    };
    const checks = [];
    for (const backend of ['qoder', 'zcode']) {
      const cwd = path.join(process.env.PACKAGED_NATIVE_ROOT, backend); fs.mkdirSync(cwd);
      const launch = adapt(backend, process.env[backend.toUpperCase() + '_EXE']).launch;
      const models = await queryModels(backend, launch, cwd);
      const controls = await querySessionControls(backend, launch, cwd, cwd);
      assert.ok(models.models.length); assert.ok(controls.permissions.length);
      checks.push({ backend, modelCount: models.models.length, selected: models.selected, permissions: controls.permissions.map(p => p.id) });
    }
    assert.equal(generationRequests, 0); console.log(JSON.stringify({ checks, generationRequests })); return;
  }
  const asar = require('@electron/asar');
  const home = fs.mkdtempSync(path.resolve('output/packaged-new-harnesses-'));
  let sourceFilesMatched = 0;
  for (const entry of asar.listPackage(archive)) {
    const rel = entry.replace(/^[/\\]/, '');
    assert.ok(!/(^|[/\\])(output|checks|agents|\.agent-room-data|node_modules)([/\\]|$)/.test(rel), 'unexpected private/runtime files in ASAR');
    if (rel === 'package.json') {
      const meta = JSON.parse(asar.extractFile(archive, rel));
      for (const field of ['version', 'name', 'productName']) assert.equal(meta[field], require('../package.json')[field]);
      assert.equal(meta.main, 'desktop/main.cjs'); continue;
    }
    const local = path.resolve(rel); if (!fs.existsSync(local) || !fs.statSync(local).isFile()) continue;
    assert.deepEqual(asar.extractFile(archive, path.normalize(rel)), fs.readFileSync(local), rel); sourceFilesMatched++;
  }
  const executable = path.resolve('dist/win-unpacked/Agent Room.exe');
  const { stdout } = await promisify(execFile)(executable, [__filename], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PACKAGED_NATIVE_ROOT: home }, windowsHide: true, timeout: 120000 });
  const native = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  const report = { ok: true, home, archive, sourceFilesMatched, ...native };
  fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
