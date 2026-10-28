'use strict';
if (process.env.AGENT_ROOM_ZCODE_BRIDGE === '1') {
  require('../standalone/zcode-desktop-host.cjs');
} else {
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createApplication } = require('../standalone/server.cjs');
const { createDataLocation } = require('../standalone/data-location.cjs');

app.setName('agentschat');
app.setAppUserModelId('com.mocias.agentroom');
// Keep the legacy data location and app ID across the agentschat rename. Tests may isolate it.
app.setPath('userData', process.env.AGENT_ROOM_DESKTOP_HOME
  ? path.resolve(process.env.AGENT_ROOM_DESKTOP_HOME)
  : path.join(app.getPath('appData'), 'Agent Room'));
let window;
let service;
let origin;
let quitting = false;
const ownedWindows = new Set();
const icon = path.join(__dirname, 'assets', 'icon.ico');
const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };

function attachmentUrl(value) {
  try { const url = new URL(value); return url.origin === origin && /^\/api\/attachment\/[a-zA-Z0-9._-]+$/.test(url.pathname); }
  catch { return false; }
}
function secureWindow(win, isMain) {
  ownedWindows.add(win);
  win.on('closed', () => ownedWindows.delete(win));
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => {
    if (isMain && url === origin + '/') return;
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(url)) { void shell.openExternal(url); return { action: 'deny' }; }
    if (attachmentUrl(url)) {
      const preview = new BrowserWindow({ width: 900, height: 700, title: '附件预览 · agentschat', icon, parent: window, webPreferences: preferences });
      preview.setMenu(null);
      secureWindow(preview, false);
      void preview.loadURL(url);
    }
    return { action: 'deny' };
  });
}
function makeMenu(dataDir) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'agentschat', submenu: [
      { label: '打开数据文件夹', click: () => { void shell.openPath(dataDir); } },
      { label: '关于 agentschat', click: () => { void dialog.showMessageBox(window, { type: 'info', title: '关于 agentschat', message: `agentschat ${app.getVersion()}`, detail: '本地多 Agent 聊天应用\n支持 Codex / DSH / Qoder / Claude Code / WorkBuddy 国内与国际版\n\n聊天数据保存在本机。' }); } },
      { type: 'separator' }, { label: '退出', role: 'quit' },
    ] },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
    { label: '视图', submenu: [{ label: '刷新', role: 'reload' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }, { label: '实际大小', role: 'resetZoom' }, { label: '全屏', role: 'togglefullscreen' }] },
  ]));
}
async function start() {
  const dataLocation = createDataLocation(path.join(app.getPath('userData'), 'data'), path.join(app.getPath('userData'), 'data-location.json'), { installDir: app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..') });
  const dataDir = dataLocation.current;
  const stateFile = path.join(app.getPath('userData'), 'window.json');
  const token = randomBytes(32).toString('hex');
  const workspaceRoot = process.env.AGENT_ROOM_WORKSPACE_ROOT || path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..'), 'agents');
  service = createApplication({ dataDir, dataLocation, workspaceRoot, accessToken: token,
    restartForMigration: () => { app.relaunch(); app.quit(); }, chooseBackendFile: async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 Agent 后端程序', properties: ['openFile'], filters: [{ name: '后端程序', extensions: ['exe', 'cmd', 'js', 'cjs', 'mjs'] }] });
    return result.canceled ? null : result.filePaths[0];
  }, chooseWorkspaceDirectory: async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 Agent 工作区', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  } });
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${service.server.address().port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'X-Agent-Room-Token': token } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  let size = {};
  try { size = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  window = new BrowserWindow({
    title: 'agentschat', width: Math.max(820, Math.min(1800, Number(size.width) || 1180)),
    height: Math.max(600, Math.min(1200, Number(size.height) || 800)), minWidth: 740, minHeight: 560,
    backgroundColor: '#f5f5f5', icon, show: false, autoHideMenuBar: true, webPreferences: preferences,
  });
  secureWindow(window, true);
  window.on('close', () => {
    const { width, height } = window.getNormalBounds();
    fs.writeFileSync(stateFile, JSON.stringify({ width, height, maximized: window.isMaximized() }), 'utf8');
    // Closing the main window also closes its attachment preview windows.
    for (const win of ownedWindows) if (win !== window && !win.isDestroyed()) win.close();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) dialog.showErrorBox('界面已停止', `界面进程退出：${details.reason}。请重新启动应用，已保存的聊天记录会保留。`);
  });
  makeMenu(dataDir);
  await window.loadURL(origin + '/');
  if (quitting) return;
  if (size.maximized) window.maximize();
  window.show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(start).catch(async (error) => {
    // Closing during initial navigation cancels loadURL; it is not a startup failure.
    if (quitting) return;
    dialog.showErrorBox('agentschat 启动失败', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    const deadline = setTimeout(() => app.exit(1), 10000);
    Promise.resolve(service?.close()).catch((error) => console.error('Shutdown:', error)).finally(() => {
      clearTimeout(deadline);
      app.exit(0);
    });
  });
}

}
