'use strict';
// Real HTTP/SSE + browser (or packaged Electron), isolated data. No real model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium, _electron } = require('playwright-core');
const { createApplication } = require('../standalone/server.cjs');
const { AgentRoom } = require('../lib/room.cjs');

(async () => {
  fs.mkdirSync(path.resolve('output/playwright'), { recursive: true });
  const home = fs.mkdtempSync(path.resolve('output/playwright/agent-sessions-'));
  const dataDir = path.join(home, 'data'), workspaceRoot = path.join(home, 'agents');
  fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  const agents = [
    { id: 'codex-writer', label: '创作搭子', backend: 'codex', model: 'codex-demo', modelName: 'Codex · 演示模型', effort: 'high' },
    { id: 'dsh-researcher', label: '研究伙伴', backend: 'dsh', model: 'dsh-demo', modelName: 'DeepSeek · 演示模型', effort: 'low' },
    { id: 'reviewer', label: '审查伙伴', backend: 'claude' },
    { id: 'qoder-helper', label: 'Qoder 伙伴', backend: 'qoder', model: 'qoder-demo', modelName: 'Qoder · 演示模型' },
    { id: 'zcode-helper', label: 'ZCode 伙伴', backend: 'zcode', model: 'zcode-demo', modelName: 'ZCode · 演示模型' },
  ].map(a => ({ ...a, workspace: path.join(workspaceRoot, a.id), createdAt: '2026-10-23T09:00:00.000Z' }));
  for (const a of agents) { fs.mkdirSync(a.workspace, { recursive: true }); fs.writeFileSync(path.join(a.workspace, 'keep.txt'), 'Workspace files stay here.'); }
  const conversations = agents.flatMap(a => [
    { id: a.id + '-old', title: a.label },
    ...(a.backend === 'claude' ? [] : [{ id: a.id + '-second', title: a.backend === 'codex' ? '整理下一版设计思路' : '寻找灵感与参考', titleSource: 'custom' }]),
  ].map(c => ({ ...c, kind: 'direct', agentIds: [a.id], updatedAt: '2026-10-23T09:00:00.000Z' })));
  conversations.push({ id: 'group', kind: 'group', title: '一起打磨好想法', agentIds: agents.map(a => a.id), updatedAt: '2026-10-23T08:00:00.000Z' });
  for (const c of conversations) fs.writeFileSync(path.join(dataDir, 'rooms', c.id + '.log.jsonl'), JSON.stringify({ id: 'm1', seq: 1, ts: c.updatedAt, kind: 'user', authorId: 'user', authorLabel: '你', text: '这是「' + c.title + '」的隔离演示历史。', visibility: 'public' }) + '\n');
  fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify({ version: 1, agents, conversations }));
  fs.writeFileSync(path.join(dataDir, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  if (process.env.UI_NATIVE_CONTROLS === '1') {
    const { BackendDiscovery } = require('../standalone/discovery.cjs');
    const rows = await new BackendDiscovery({ dir: process.env.CONTROLS_DISCOVERY_DATA || home }).scan();
    const preferences = Object.fromEntries(['codex', 'dsh'].map(id => { const found = rows.find(r => r.id === id)?.selected; assert.ok(found?.path, id + ' unavailable'); return [id, { path: found.path }]; }));
    fs.writeFileSync(path.join(dataDir, 'backend-preferences.json'), JSON.stringify(preferences));
  }
  const protectedFiles = [...conversations.map(c => path.join(dataDir, 'rooms', c.id + '.log.jsonl')), ...agents.map(a => path.join(a.workspace, 'keep.txt'))];
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = protectedFiles.map(hash);
  const models = backend => ({ selected: backend + '-demo', models: [{ id: backend + '-demo', name: '演示模型', efforts: ['low', 'high'], defaultEffort: 'low' }] });
  let nativeStarts = 0, modelRequests = 0, browser, app, desktop, page;
  const fixtureRooms = new Map();
  const errors = [], checks = [];
  const packaged = process.env.UI_PACKAGED === '1';
  async function launch() {
    if (packaged) {
      const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home, AGENT_ROOM_WORKSPACE_ROOT: workspaceRoot }; delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({ executablePath: path.resolve('dist/win-unpacked/Agent Room.exe'), env });
      page = await desktop.firstWindow();
      await page.route('**/api/models', route => { modelRequests++; return route.fulfill({ json: models(route.request().postDataJSON().backend) }); });
      // Settings are covered against the real server in source mode. Packaged mode
      // avoids launching an installed harness solely to enumerate effort options.
    } else {
      app = createApplication({ dataDir, workspaceRoot, pollScheduling: false, discoveryInventory: async () => ({ rows: [] }),
        inspectDesktop: () => ({ status: 'pending', detail: '隔离演示' }), registerAgent: async () => ({}), queryModels: async backend => { modelRequests++; return models(backend); },
        querySessionControls: async backend => ['qoder', 'zcode'].includes(backend) ? ({ backend, presets: [{ id: 'native', label: '原生会话' }], permissions: (backend === 'qoder' ? ['default', 'dontAsk'] : ['build']).map(id => ({ id, label: id === 'dontAsk' ? '拒绝未授权操作' : '逐次确认' })) }) : ({ backend,
          presets: (backend === 'dsh' ? ['standard', 'minimal'] : ['default', 'plan']).map(id => ({ id, label: ({ standard: '标准模式', minimal: '精简模式', default: '默认模式', plan: '规划模式' })[id] })),
          permissions: ['read-only', 'workspace-write', 'danger-full-access'].map(id => ({ id, label: ({ 'read-only': '只读', 'workspace-write': '工作区内修改', 'danger-full-access': '完整访问' })[id] })) }),
        roomFactory: settings => {
          const room = new AgentRoom(settings);
          fixtureRooms.set(settings.id, room);
          for (const backend of new Set(settings.members.map(a => a.backend))) room.pools.set(backend, { running: false, stop: async () => {}, getThread: () => null,
            start: async () => { nativeStarts++; throw new Error('Native harness disabled in UI check'); } });
          return room;
        } });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
      await page.goto('http://127.0.0.1:' + app.server.address().port);
    }
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => { if (new URL(req.url()).pathname === '/api/say') throw new Error('Unexpected generation request'); });
    await page.locator('[data-open-agent="codex-writer"]').waitFor();
    assert.equal(await page.title(), 'agentschat');
    if (packaged) {
      const identity = await desktop.evaluate(({ app, Menu }) => ({ name: app.getName(), userData: app.getPath('userData'), menu: Menu.getApplicationMenu().items[0].label }));
      assert.equal(identity.name, 'agentschat'); assert.equal(identity.menu, 'agentschat'); assert.equal(identity.userData, home);
    }
  }
  const screenshot = async name => { await page.locator('#toast').waitFor({ state: 'hidden' }); await page.screenshot({ path: path.join(home, name) }); };
  const read = route => page.evaluate(async route => { const r = await fetch('/api' + route); return r.json(); }, route);
  try {
    await launch();
    await page.locator('[data-open-agent="codex-writer"]').click();
    await page.locator('[data-session="codex-writer-second"]').waitFor({ state: 'visible' });
    await page.locator('#messages .message').waitFor();
    await page.locator('[data-open-agent="codex-writer"]').hover();
    const selectedColors = await page.locator('[data-open-agent="codex-writer"]').evaluate(el => ({ inner: getComputedStyle(el).backgroundColor, outer: getComputedStyle(el.parentElement).backgroundColor }));
    assert.ok(selectedColors.inner === 'rgba(0, 0, 0, 0)' || selectedColors.inner === selectedColors.outer, JSON.stringify(selectedColors));
    assert.equal(await page.locator('.composer').getAttribute('data-harness'), 'codex');
    assert.match(await page.locator('#messages').textContent(), /创作搭子/);
    await page.locator('#draft').fill('属于旧会话的草稿');
    await page.locator('#file-input').setInputFiles({ name: 'session-note.txt', mimeType: 'text/plain', buffer: Buffer.from('isolated attachment') });
    await page.locator('#attachments .file-chip').waitFor();
    await page.locator('[data-session="codex-writer-second"]').click();
    assert.equal(await page.locator('#draft').inputValue(), ''); assert.equal(await page.locator('#attachments .file-chip').count(), 0);
    await page.locator('#draft').fill('另一段草稿');
    await page.locator('[data-session="codex-writer-old"]').click();
    assert.equal(await page.locator('#draft').inputValue(), '属于旧会话的草稿'); assert.equal(await page.locator('#attachments .file-chip').count(), 1);
    checks.push('Agent expands history; session switching keeps draft and attachment ownership');
    await page.locator('[data-open-agent="dsh-researcher"]').click();
    assert.equal(await page.locator('.composer').getAttribute('data-harness'), 'dsh');
    assert.match(await page.locator('#composer-mode').textContent(), /标准模式/);
    const oldIds = (await read('/catalog')).conversations.map(c => c.id);
    await page.locator('#new-session').click();
    await page.waitForFunction(() => document.querySelector('#chat-title').textContent === '新会话');
    const fresh = (await read('/catalog')).conversations.find(c => !oldIds.includes(c.id));
    assert.deepEqual(fresh.agentIds, ['dsh-researcher']);
    await page.locator('.harness-welcome').waitFor();
    await screenshot('dsh-new-session.png');
    await page.locator('#session-actions').click();
    await page.getByRole('menuitem', { name: '重命名会话', exact: true }).click();
    await page.locator('[name="title"]').fill('我的调研会话');
    await page.locator('#modal-submit').click(); await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#chat-title').textContent(), '我的调研会话');
    assert.equal((await read('/catalog')).agents.find(a => a.id === 'dsh-researcher').label, '研究伙伴');
    await page.locator('#session-actions').click(); await page.getByRole('menuitem', { name: '置顶会话', exact: true }).click();
    await page.waitForFunction(id => document.querySelector(`[data-session="${id}"] .session-symbol`).textContent === '⌃', fresh.id);
    assert.equal(await page.locator('[data-open-agent="dsh-researcher"] .pin-mark').count(), 0);
    checks.push('New session is blank and attached to the right Agent; title and pin do not rename Agent');
    if (!packaged) {
      await page.locator('#composer-mode').click();
      await page.getByRole('menuitemradio', { name: '精简模式', exact: true }).waitFor();
      await screenshot('dsh-preset-menu.png');
      await page.getByRole('menuitemradio', { name: '精简模式', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#composer-mode').textContent.includes('精简模式'));
      await page.locator('#composer-permission').click();
      await page.getByRole('menuitemradio', { name: '工作区内修改', exact: true }).waitFor();
      await screenshot('dsh-permission-menu.png');
      await page.getByRole('menuitemradio', { name: '工作区内修改', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#composer-permission').textContent.includes('工作区内修改'));
      await read('/conversation?id=' + fresh.id);
      const pendingDecision = fixtureRooms.get(fresh.id).requestApproval('dsh', 'session/request_permission', { toolCall: { title: '创建演示文件', description: '本地测试请求，不会实际写文件' } });
      await page.locator('#approval-panel').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '允许这一次', exact: true }).click();
      assert.equal(await pendingDecision, true);
      await page.locator('#approval-panel').waitFor({ state: 'hidden' });
      await page.locator('#composer-effort').click();
      await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#composer-effort').textContent.includes('high'));
      assert.match(await page.locator('#composer-effort').textContent(), /high/);
      await page.locator('[data-session="dsh-researcher-old"]').click();
      assert.match(await page.locator('#composer-effort').textContent(), /low/);
      await page.locator(`[data-session="${fresh.id}"]`).click();
      checks.push('Advertised reasoning option applies only to the selected conversation through real HTTP');
      checks.push('DSH preset and permission menus save per conversation; explicit one-time approval completes through real HTTP/SSE');
    }
    if (packaged && process.env.UI_NATIVE_CONTROLS === '1') {
      await page.locator('#composer-mode').click();
      await page.getByRole('menuitemradio', { name: '精简模式', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#composer-mode').textContent.includes('精简模式'));
      await page.locator('#composer-permission').click();
      await page.getByRole('menuitemradio', { name: '工作区内修改', exact: true }).waitFor();
      await screenshot('dsh-native-permissions.png');
      await page.getByRole('menuitemradio', { name: '工作区内修改', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#composer-permission').textContent.includes('工作区内修改'));
      assert.deepEqual((await read('/session-controls?room=' + fresh.id)).config, { preset: 'minimal', permission: 'workspace-write' });
      checks.push('Packaged UI reads real DSH preset/permission catalogs and persists the selected configuration without prompting a model');
    }
    await page.locator('#search').fill('我的调研');
    assert.equal(await page.locator('[data-open-agent]').count(), 1);
    assert.equal(await page.locator('[data-session]').count(), 1);
    await page.locator('#search').fill('');
    await page.locator('[data-room="reviewer-old"]').click(); assert.equal(await page.locator('.composer').getAttribute('data-harness'), 'generic');
    await page.locator('[data-room="group"]').click(); assert.equal(await page.locator('#new-session').isVisible(), false);
    await page.locator('[data-open-agent="codex-writer"]').click();
    await page.locator('#new-session').click(); await page.locator('.harness-welcome').waitFor();
    assert.equal(await page.locator('.composer').getAttribute('data-harness'), 'codex');
    await screenshot('codex-new-session.png');
    if (!packaged || process.env.UI_NATIVE_CONTROLS === '1') {
      await page.locator('#composer-mode').click();
      await page.getByRole('menuitemradio', { name: '规划模式', exact: true }).waitFor();
      await screenshot('codex-mode-menu.png');
      await page.getByRole('menuitemradio', { name: '规划模式', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#composer-mode').textContent.includes('规划模式'));
      await page.locator('#composer-permission').click();
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('menuitemradio', { name: '完整访问', exact: true }).click();
      assert.match(await page.locator('#composer-permission').textContent(), /只读/);
      await page.keyboard.press('Escape');
      checks.push('Codex default/plan menu is routed separately; cancelled full-access confirmation keeps read-only');
    }
    checks.push('Search exposes matching nested sessions; group and other harness composer stay generic');
    for (const backend of ['codex', 'dsh', 'qoder', 'zcode']) {
      await page.locator(`[data-open-agent="${({codex:'codex-writer',dsh:'dsh-researcher',qoder:'qoder-helper',zcode:'zcode-helper'})[backend]}"]`).click();
      if (['qoder', 'zcode'].includes(backend)) {
        assert.equal(await page.locator('.composer').getAttribute('data-harness'), backend);
        await page.locator('#new-session').click(); await page.locator('.harness-welcome').waitFor();
        assert.equal(await page.locator('#composer-mode').isVisible(), false);
        if (!packaged) {
          await page.locator('#composer-permission').click();
          await page.getByRole('menuitemradio', { name: '逐次确认', exact: true }).waitFor();
          await screenshot(backend + '-permissions.png');
          await page.getByRole('menuitemradio', { name: backend === 'qoder' ? '拒绝未授权操作' : '逐次确认', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('#composer-menu'));
        }
      }
      for (const width of [1440, 1000, 720, 390]) {
        await page.setViewportSize({ width, height: 960 });
        const metrics = await page.evaluate(() => {
          const within = el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
          return { overflow: document.documentElement.scrollWidth > innerWidth, send: within(document.querySelector('#send')), draft: within(document.querySelector('#draft')), model: within(document.querySelector('#harness-options')) };
        });
        assert.deepEqual(metrics, { overflow: false, send: true, draft: true, model: true }, backend + ' ' + width);
        if (width === 390) await screenshot(backend + '-mobile.png');
      }
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.locator('#settings').click();
      const changed = page.waitForResponse(r => r.url().endsWith('/api/theme') && r.request().method() === 'POST');
      await page.locator('[data-preset="midnight"]').click(); await changed; await page.locator('#close-modal').click();
      await screenshot(backend + '-dark.png');
      await page.locator('#settings').click();
      const reset = page.waitForResponse(r => r.url().endsWith('/api/theme') && r.request().method() === 'POST');
      await page.locator('[data-preset="paper"]').click(); await reset; await page.locator('#close-modal').click();
    }
    checks.push('All four session adapters at 1440/1000/720/390px keep send, draft and model controls in bounds; light/dark screenshots');
    await page.locator(`[data-session="${fresh.id}"]`).click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#chat-title').textContent === '我的调研会话');
    assert.equal(await page.locator(`[data-session="${fresh.id}"]`).isVisible(), true);
    if (packaged) {
      await desktop.close(); desktop = null; await launch();
      await page.waitForFunction(() => document.querySelector('#chat-title').textContent === '我的调研会话');
      assert.equal((await desktop.evaluate(({ app }) => app.getVersion())), require('../package.json').version);
      checks.push('Packaged EXE restart restores newly created session and selection');
    }
    assert.deepEqual(protectedFiles.map(hash), before);
    assert.equal(nativeStarts, 0); assert.deepEqual(errors, []);
    checks.push('Reload restores expanded/selected session; existing history and workspace SHA-256 unchanged');
    const report = { ok: true, home, packaged, nativeControlCatalogs: process.env.UI_NATIVE_CONTROLS === '1', checks, fixtureNativeStarts: packaged ? null : nativeStarts, modelRequests, browserErrors: errors };
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await browser?.close(); await desktop?.close(); await app?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
