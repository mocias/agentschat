'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../standalone/server.cjs');
const { AgentRoom } = require('../lib/room.cjs');

test('catalog and saved history stay readable while discovery is pending; preview never becomes the live runtime', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-loading-'));
  fs.mkdirSync(path.join(dir, 'rooms'));
  fs.mkdirSync(path.join(dir, 'workspace'));
  fs.writeFileSync(path.join(dir, 'discovery-consent.json'), JSON.stringify({ choice: 'automatic' }));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ version: 1,
    agents: [{ id: 'a', label: 'Agent', backend: 'dsh', workspace: path.join(dir, 'workspace') }],
    conversations: [{ id: 'saved', title: 'Saved', kind: 'direct', agentIds: ['a'] }],
  }));
  const history = JSON.stringify({ id: 'one', kind: 'user', authorId: 'user', authorLabel: '用户', visibility: 'public', text: 'SAVED_HISTORY', ts: '2026-10-29T00:00:00Z' }) + '\n';
  fs.writeFileSync(path.join(dir, 'rooms/saved.log.jsonl'), history);
  let release, notify, builds = 0, starts = 0;
  const waiting = new Promise(r => { notify = r; });
  const app = createApplication({ dataDir: dir, nativeRegistration: false, pollScheduling: false, inspectDesktop: () => ({}),
    discoveryInventory: () => { notify(); return new Promise(r => { release = r; }); },
    roomFactory: settings => { builds++; const room = new AgentRoom(settings); room.connect = async () => { starts++; throw Error('No native start allowed'); }; return room; },
  });
  t.after(async () => { release?.({ rows: [] }); await app.close(); });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  const scanning = fetch(base + '/backends'); await waiting;
  const request = async route => { const response = await fetch(base + route, { signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); return response.json(); };
  const catalog = await request('/catalog?fast=1');
  assert.equal(catalog.conversations[0].id, 'saved'); assert.ok(catalog.harnesses.every(r => r.status === 'pending'));
  const view = await request('/conversation?preview=1&id=saved');
  assert.equal(view.snapshot.log[0].text, 'SAVED_HISTORY'); assert.equal(view.pending, false);
  assert.equal(builds, 1); assert.equal(starts, 0);
  release({ rows: [] }); await (await scanning).json();
  await request('/conversation?id=saved'); assert.equal(builds, 2);
  await request('/conversation?preview=1&id=saved'); assert.equal(builds, 2);
  assert.equal(starts, 0); assert.equal(fs.readFileSync(path.join(dir, 'rooms/saved.log.jsonl'), 'utf8'), history);
});
