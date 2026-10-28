'use strict';
const net = require('node:net');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { randomBytes } = require('node:crypto');

// Windows GUI Electron processes do not reliably inherit stdin. Use a fresh,
// authenticated loopback pipe for the owned helper; never expose a fixed port.
async function createHostTransport() {
  const token = randomBytes(32).toString('hex');
  let socket, child, claimed = false;
  const input = new PassThrough(), output = new PassThrough();
  const server = net.createServer(peer => {
    let buffer = '';
    peer.setTimeout(5000, () => peer.destroy());
    peer.on('error', () => {});
    const handshake = chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4096) { peer.destroy(); return; }
      const end = buffer.indexOf('\n'); if (end < 0) return;
      let hello; try { hello = JSON.parse(buffer.slice(0, end)); } catch { peer.destroy(); return; }
      if (claimed || hello.token !== token) { peer.destroy(); return; }
      claimed = true; socket = peer; peer.setTimeout(0); peer.off('data', handshake);
      if (buffer.length > end + 1) output.write(buffer.slice(end + 1));
      input.pipe(peer); peer.pipe(output); server.close();
    };
    peer.on('data', handshake);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return {
    spawnChild(binary, argv, options) {
      child = spawn(binary, argv, { ...options, env: { ...options.env, AGENT_ROOM_ZCODE_BRIDGE_PORT: String(port), AGENT_ROOM_ZCODE_BRIDGE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.resume(); child.stdin = input; child.stdout = output;
      child.once('exit', () => { socket?.destroy(); server.close(); output.end(); });
      return child;
    },
    close() { socket?.destroy(); server.close(); input.destroy(); output.destroy(); },
  };
}
module.exports = { createHostTransport };
