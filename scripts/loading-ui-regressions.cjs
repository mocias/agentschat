'use strict';
const assert = require('node:assert/strict');
module.exports = async function verify(page, historyCount) {
  const checks = [];
  await page.locator('[data-room="history"]').click();
  await page.getByText('HISTORY_READY', { exact: true }).waitFor();
  assert.equal(await page.locator('.message').count(), Math.min(120, historyCount));
  if (historyCount > 120) {
    await page.locator('#messages').evaluate(el => { el.scrollTop = 0; });
    const anchor = await page.locator('.message').first().elementHandle();
    const before = (await anchor.boundingBox()).y;
    await page.locator('.load-earlier').click();
    assert.equal(await page.locator('.message').count(), Math.min(240, historyCount));
    assert.ok(Math.abs((await anchor.boundingBox()).y - before) < 3, 'Older messages keep the reading position');
    while (await page.locator('.load-earlier').count()) await page.locator('.load-earlier').click();
    assert.equal(await page.locator('.message').count(), historyCount);
  }
  checks.push('Recent history is bounded; every older record can be expanded without moving the reading anchor');
  await page.locator('[data-open-agent="dsh"]').click();
  await page.getByText('SWITCH_READY', { exact: true }).waitFor();
  const draft = page.locator('#draft');
  const shortHeight = (await draft.boundingBox()).height;
  const text = Array.from({ length: 12 }, (_, i) => '草稿第 ' + i + ' 行').join('\n');
  await draft.fill(text); assert.ok((await draft.boundingBox()).height > shortHeight);
  await page.locator('[data-room="history"]').click();
  await page.getByText('HISTORY_READY', { exact: true }).waitFor();
  await page.locator('[data-open-agent="dsh"]').click();
  await page.getByText('SWITCH_READY', { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), text); assert.ok((await draft.boundingBox()).height > shortHeight);
  await draft.fill(''); assert.equal((await draft.boundingBox()).height, shortHeight);
  checks.push('Multiline drafts grow, restore in their own session and shrink when cleared');

  let release, notify, first = true;
  const waiting = new Promise(r => { notify = r; }), gate = new Promise(r => { release = r; });
  await page.route('**/api/conversation?preview=1&id=history', async route => {
    if (!first) return route.continue(); first = false;
    const response = await route.fetch(), data = await response.json();
    data.snapshot.log.at(-1).text = 'STALE_RESPONSE'; notify(); await gate;
    await route.fulfill({ response, json: data });
  });
  try {
    await page.locator('[data-room="history"]').click(); await waiting;
    await page.locator('[data-open-agent="dsh"]').click(); await page.getByText('SWITCH_READY', { exact: true }).waitFor();
    await page.locator('[data-room="history"]').click(); await page.getByText('HISTORY_READY', { exact: true }).waitFor();
    const delivered = page.waitForResponse(r => r.url().includes('/conversation?preview=1&id=history'));
    release(); await delivered;
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await page.getByText('STALE_RESPONSE', { exact: true }).count(), 0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  checks.push('A delayed A → B → A response never replaces the latest conversation');

  let resume, reached;
  const entered = new Promise(r => { reached = r; }), held = new Promise(r => { resume = r; });
  await page.route('**/api/ui-state', async route => {
    if (route.request().method() === 'POST') { reached(); await held; }
    await route.continue();
  });
  await page.route('**/api/approvals?room=second', async route => { await held; await route.continue(); });
  try {
    await page.locator('[data-open-agent="dsh"]').click(); await entered;
    await page.getByText('SWITCH_READY', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('#send').isEnabled(), true);
  } finally { resume(); await page.unrouteAll({ behavior: 'wait' }); }
  checks.push('History is usable while navigation saving and approvals are delayed');
  return checks;
};
