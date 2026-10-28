'use strict';
// Repeatable local workload; no model generation, native sessions or user data.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright-core');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { harnessIds, harnessById } = require('../lib/harnesses.cjs');
const { createApplication } = require('../standalone/server.cjs');
const nativeDiscovery = process.env.BENCH_NATIVE_DISCOVERY === '1';
const historyCount = Number(process.env.BENCH_MESSAGES || 1200);
const repeat = Number(process.env.BENCH_REPEATS || 3);
if (!nativeDiscovery) BackendDiscovery.prototype.discover = async function() {
  await new Promise(r => setTimeout(r, 900));
  return harnessIds().map(id => ({ id, label: harnessById(id).label, found: false, selected: null, candidates: [], status: 'missing', detail: 'benchmark fixture' }));
};
(async () => {
  const home = fs.mkdtempSync(path.resolve('output/loading-' + (process.env.BENCH_LABEL || 'sample') + '-'));
  const results = [], checks = []; let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (let i = 0; i < repeat; i++) {
      const root = path.join(home, String(i)); fs.mkdirSync(path.join(root, 'rooms'), { recursive: true });
      const agents = ['dsh', 'qoder', 'zcode', 'codex'].map(backend => ({ id: backend, label: backend + ' 伙伴', backend, workspace: path.join(root, 'agents', backend), modelName: backend === 'dsh' ? 'DeepSeek Account · DeepSeek-V4.1-Flash' : backend, createdAt: '2026-10-29T08:00:00.000Z' }));
      for (const a of agents) fs.mkdirSync(a.workspace, { recursive: true });
      const conversations = [{ id: 'history', kind: 'group', title: '历史压力测试', agentIds: agents.map(a => a.id), updatedAt: '2026-10-29T08:00:00.000Z' }, { id: 'second', kind: 'direct', title: '输入区展示', agentIds: ['dsh'], updatedAt: '2026-10-29T08:00:00.000Z' }];
      fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ version: 1, agents, conversations }));
      fs.writeFileSync(path.join(root, 'discovery-consent.json'), JSON.stringify({ choice: 'automatic' }));
      fs.writeFileSync(path.join(root, 'ui-state.json'), JSON.stringify({ selected: 'history', expanded: { dsh: true }, lastSessions: {} }));
      const records = Array.from({ length: historyCount }, (_, j) => ({ id: 'm' + j, seq: j + 1, kind: j % 2 ? 'agent' : 'user', authorId: j % 2 ? 'dsh' : 'user', authorLabel: j % 2 ? '研究伙伴' : '你', ts: '2026-10-29T08:00:00.000Z', visibility: 'public', text: j === historyCount - 1 ? 'HISTORY_READY' : ('这是一条用于界面加载测量的隔离演示消息。'.repeat(5) + j) }));
      fs.writeFileSync(path.join(root, 'rooms/history.log.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
      fs.writeFileSync(path.join(root, 'rooms/second.log.jsonl'), JSON.stringify({ ...records[0], text: 'SWITCH_READY' }) + '\n');
      let fsyncs = 0; const originalSync = fs.fsyncSync;
      fs.fsyncSync = (...args) => { fsyncs++; return originalSync(...args); };
      const started = performance.now();
      let app;
      try { app = createApplication({ dataDir: root, nativeRegistration: false, pollScheduling: false, registerAgent: async () => ({}), inspectDesktop: () => ({}) }); }
      finally { fs.fsyncSync = originalSync; }
      const serverCreateMs = performance.now() - started;
      await new Promise(r => app.server.listen(0, '127.0.0.1', r));
      const page = await browser.newPage({ viewport: { width: 2120, height: 1000 }, reducedMotion: 'reduce' });
      const counts = {}, errors = [];
      page.on('request', request => { const route = new URL(request.url()).pathname; if (route.startsWith('/api/')) counts[route] = (counts[route] || 0) + 1; });
      page.on('pageerror', error => errors.push(error.message));
      const uiStarted = performance.now();
      try {
        await page.goto('http://127.0.0.1:' + app.server.address().port);
        await page.getByText('HISTORY_READY', { exact: true }).waitFor();
        const historyReadyMs = performance.now() - uiStarted;
        const domMessages = await page.locator('.message').count();
        const switchStarted = performance.now(); await page.locator('[data-open-agent="dsh"]').click();
        await page.getByText('SWITCH_READY', { exact: true }).waitFor();
        const switchMs = performance.now() - switchStarted;
        const composer = await page.locator('.composer').evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, permissionFont: getComputedStyle(document.querySelector('#composer-permission')).fontSize }));
        if (i === 0) await page.screenshot({ path: path.join(home, 'composer.png') });
        results.push({ serverCreateMs, historyReadyMs, switchMs, domMessages, memoryFsyncs: fsyncs, requests: { ...counts }, composer, errors });
        if (i === 0 && process.env.BENCH_VERIFY === '1') checks.push(...await require('./loading-ui-regressions.cjs')(page, historyCount));
      } finally { await page.close(); await app.close(); }
    }
  } finally { await browser?.close(); }
  const median = key => results.map(r => r[key]).sort((a,b) => a-b)[Math.floor(results.length / 2)];
  const report = { home, version: require('../package.json').version, nativeDiscovery, injectedDiscoveryDelayMs: nativeDiscovery ? 0 : 900, historyCount, results, checks,
    median: Object.fromEntries(['serverCreateMs','historyReadyMs','switchMs','domMessages','memoryFsyncs'].map(k => [k, median(k)])) };
  fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
