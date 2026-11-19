'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AgentRoom } = require('../lib/room.cjs');

// Launch an actual process: on this Windows host node.exe is on C:, while the
// fixture, app data and member workspaces are on D:. No model/network is used.
const outputDir = path.resolve(__dirname, '..', 'output');
fs.mkdirSync(outputDir, { recursive: true });

for (const backend of ['codex', 'dsh']) {
  test(backend + ' starts with a fresh data directory and keeps the member workspace across drives', async t => {
    const root = fs.mkdtempSync(path.join(outputDir, 'launch-workspace-'));
    const workspace = path.join(root, 'member workspace'); fs.mkdirSync(workspace);
    const cli = path.join(root, 'fixture.cjs');
    fs.writeFileSync(cli, `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line); if(frame.id===undefined)return;
 const result=frame.method==='session/new'?{sessionId:'session',configOptions:[]}:frame.method==='thread/start'?{thread:{id:'thread'},cwd:frame.params.cwd}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result})+'\\n');
});`);
    const launch = backend === 'codex' ? { codexPath: process.execPath, codexArgs: [cli] } : { agentCommand: process.execPath, agentArgs: [cli], proxy: false };
    const room = new AgentRoom({ id: 'launch-' + backend, cwd: root, prewarm: false,
      members: [{ id: 'a', backend, workspace }],
      workspaceDirs: { [backend]: path.join(root, 'missing-legacy-backend-folder') }, backends: { [backend]: launch },
    });
    const pool = room._poolFor(room.members[0]);
    t.after(() => room.dispose());
    let timer;
    try {
      await Promise.race([pool.start(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('backend did not initialize after spawn')), 1500); })]);
      const thread = await room.ensureThread(room.members[0]);
      assert.equal(thread.cwd, workspace);
      assert.ok(pool.running);
      assert.ok(fs.statSync(pool.cwd).isDirectory());
      assert.equal(fs.existsSync(path.join(root, 'missing-legacy-backend-folder')), false);
    } finally { clearTimeout(timer); }
  });
}
