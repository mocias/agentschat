'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nodeRunner, launchableFrom } = require('../lib/harnesses.cjs');
function zcodeLaunch(target, args, options = {}) {
  const resources = path.join(path.dirname(target), 'resources');
  const bundled = path.join(resources, 'glm', 'zcode.cjs');
  if (/^ZCode\.exe$/i.test(path.basename(target)) && fs.existsSync(path.join(resources, 'app.asar'))) {
    const builtin = path.join(resources, 'config', 'provider', 'zcode-builtin.json');
    if (!fs.existsSync(bundled) || !fs.existsSync(builtin)) throw new Error('此 ZCode 安装缺少可识别的 app-server 运行时');
    if (args !== undefined) throw new Error('ZCode 桌面入口自动使用内置 app-server，请清空高级参数');
    if (options.desktopAccount !== false) {
      const electron = process.versions.electron ? process.execPath : require('electron');
      return { agentCommand: electron, agentArgs: process.versions.electron ? [] : [path.join(__dirname, 'zcode-desktop-host.cjs')],
        proxy: false, zcode: true, zcodeDesktop: true, zcodeResources: resources,
        env: { ELECTRON_RUN_AS_NODE: undefined, AGENT_ROOM_ZCODE_BRIDGE: '1', AGENT_ROOM_ZCODE_RESOURCES: resources } };
    }
    return { agentCommand: target, agentArgs: [bundled, 'app-server', '--stdio'], proxy: false, zcode: true,
      env: { ELECTRON_RUN_AS_NODE: '1', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(process.env.ZCODE_DATA_BASE_DIR || process.env.USERPROFILE || process.env.HOME || '', '.zcode', 'v2', 'provider_config.json') } };
  }
  if (!/^zcode(?:-agent)?(?:\.(?:exe|cmd|cjs|mjs|js))?$/i.test(path.basename(target))) throw new Error('请选择 ZCode.exe 或官方 zcode CLI 入口');
  const runner = /\.(?:cjs|mjs|js)$/i.test(target) ? { ...nodeRunner(), argv: [target] } : launchableFrom(target);
  if (!runner) throw new Error('无法解析 ZCode CLI 启动器');
  return { agentCommand: runner.binary, agentArgs: [...runner.argv, ...(args || ['app-server', '--stdio'])], env: runner.env, proxy: false, zcode: true };
}
module.exports = { zcodeLaunch };
