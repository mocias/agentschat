'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApplication } = require('../standalone/server.cjs');
(async () => {
  if (!process.env.QODER_EXE || !process.env.ZCODE_EXE) throw new Error('Set QODER_EXE and ZCODE_EXE');
  const home = fs.mkdtempSync(path.resolve('output/live-new-harnesses-room-'));
  fs.writeFileSync(path.join(home, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  fs.writeFileSync(path.join(home, 'backend-preferences.json'), JSON.stringify({ qoder: { path: process.env.QODER_EXE }, zcode: { path: process.env.ZCODE_EXE } }));
  const app = createApplication({ dataDir: home, workspaceRoot: path.join(home, 'agents'), nativeRegistration: false,
    registerAgent: async () => ({ status: 'disabled-for-test' }), inspectDesktop: () => ({}), pollScheduling: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const report = { home, checks: [] };
  const call = async (route, body) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const data = await r.json(); if (!r.ok) throw Error(data.error); return data; };
  try {
    const q = await call('/agents', { backend: 'qoder', label: 'Qoder验收', model: 'auto' });
    const z = await call('/agents', { backend: 'zcode', label: 'ZCode验收', model: 'account:zai-start-plan/GLM-5.3-Flash' });
    const group = (await call('/groups', { title: '新后端混合群验收', agentIds: [q.agent.id, z.agent.id] })).conversation;
    await call('/member-effort', { room: group.id, agent: z.agent.id, effort: 'low' });
    await call('/say', { room: group.id, text: '@所有人 只回复 MIXED_ROOM_OK。不要调用任何工具，不要提及其他成员。' });
    let snapshot;
    for (let i = 0; i < 180; i++) {
      snapshot = (await call('/conversation?id=' + group.id)).snapshot;
      if (snapshot.log.filter(e => e.kind === 'agent').length >= 2 && !snapshot.busy.length) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const replies = snapshot.log.filter(e => e.kind === 'agent');
    report.replies = replies.map(e => ({ author: e.authorLabel, text: e.text }));
    assert.equal(replies.length, 2, JSON.stringify(snapshot.log.filter(e => e.kind === 'system').map(e => e.text)));
    assert.ok(replies.every(e => e.text.includes('MIXED_ROOM_OK')));
    const catalog = await call('/catalog'), saved = catalog.conversations.find(c => c.id === group.id);
    const ids = Object.values(saved.nativeSessions).map(s => s.id); assert.equal(new Set(ids).size, 2);
    report.checks.push('Qoder and ZCode reply through the real mixed-room scheduler with distinct native sessions');
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
  finally { await app.close(); fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
})();
