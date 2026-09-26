'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, session, Menu, Tray, Notification, dialog, shell, powerMonitor } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { createStorage } = require('./storage.cjs');
const { createConnectionState, requestKind } = require('./connection.cjs');
const { DEFAULT_PROXY, PROXY_FAILURES, normalizeProxy, proxyConfig, proxyLabel, testProxyPort } = require('./proxy.cjs');
const { APP_ORIGIN, APP_ID, VERSION, isAppleNavigation, isAppleShop, appResource, isLocalPage } = require('./policy.cjs');

const root = path.resolve(__dirname, '..');
const smoke = process.argv.includes('--self-test');
const portableRoot = app.isPackaged ? path.dirname(process.execPath) : root;
const testDataArgument = process.argv.find(arg => arg.startsWith('--self-test-data-dir='))?.slice('--self-test-data-dir='.length);
const dataPath = smoke ? path.resolve(testDataArgument || path.join(portableRoot, 'SelfTestData')) : path.join(portableRoot, 'Data');
fs.mkdirSync(dataPath, { recursive: true });
app.setPath('userData', dataPath);
app.setPath('sessionData', path.join(dataPath, 'Browser'));
app.setAppUserModelId('AppleStockMonitor.Desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'stockapp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const localPages = new Map(), remoteWindows = new Map(), alarms = new Map(), pending = new Map();
let store, dashboard, engine, tray, quitting = false, shuttingDown = false, closeDialog = false, backupBusy = false;
let resolveEngine, proxySettings = { ...DEFAULT_PROXY };
const engineReady = new Promise(resolve => { resolveEngine = resolve; });
const icon = path.join(root, 'extension/icons/icon128.png');
const pageURL = `${APP_ORIGIN}/app.html`;
const engineURL = `${APP_ORIGIN}/engine.html`;
const preload = path.join(__dirname, 'preload.cjs');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
const smokeState = { nextResponse: null, requests: 0, tab: null };

function sendEvent(name, args, engineOnly = false) {
  for (const [wc, role] of localPages) {
    if (wc.isDestroyed() || (engineOnly && role !== 'engine')) continue;
    let payload = args;
    if (name === 'storage.onChanged' && role !== 'engine') {
      const changes = { ...args[0] };
      delete changes.notificationQueue; delete changes.notificationEvents;
      if (changes.barkConfig) changes.barkConfig = { newValue: { enabled: changes.barkConfig.newValue?.enabled } };
      payload = [changes, args[1]];
    }
    wc.send('desktop:event', { name, args: payload });
  }
}
function trustedRole(event) {
  const role = localPages.get(event.sender);
  if (!role || event.senderFrame !== event.sender.mainFrame || !isLocalPage(event.senderFrame.url, role)) throw new Error('拒绝不受信任的页面请求');
  return role;
}
function showMain() { if (dashboard && !dashboard.isDestroyed()) { dashboard.show(); dashboard.restore(); dashboard.focus(); } }
function clearAlarms() { for (const alarm of alarms.values()) clearInterval(alarm.timer); alarms.clear(); }
function timeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}
async function runtimeRequest(message) {
  await timeout(engineReady, 15000, '监控引擎尚未就绪，请重新启动程序');
  if (!engine || engine.isDestroyed()) throw new Error('监控引擎已停止，请重新启动程序');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('监控引擎响应超时，当前请求不会重复发送')); }, 180000);
    pending.set(id, { resolve, reject, timer });
    engine.webContents.send('desktop:runtime-message', { id, message, sender: { id: APP_ID, url: pageURL } });
  });
}
function tabFor(win) {
  return { id: win.webContents.id, windowId: win.id, url: win.webContents.getURL() || win.requestedURL,
    status: win.stockConnection?.snapshot().loading || win.webContents.isLoadingMainFrame() ? 'loading' : 'complete', discarded: false, active: win.isVisible() };
}
function getRemote(id) {
  const win = remoteWindows.get(id);
  if (!win || win.isDestroyed()) throw new Error('官网窗口已关闭');
  return win;
}
function remoteBootstrap() {
  if (globalThis.__desktopDispatch) return;
  const listeners = [];
  globalThis.chrome = { runtime: { id: 'apple-stock-monitor-desktop', getURL: (p = '') => 'stockapp://local/' + p,
    onMessage: { addListener: fn => listeners.push(fn) } } };
  globalThis.__desktopDispatch = message => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('官网窗口未响应')), 30000);
    let done = false, asyncResponse = false;
    const reply = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    for (const listener of listeners) {
      try { if (listener(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('engine.html') }, reply) === true) asyncResponse = true; }
      catch (error) { clearTimeout(timer); reject(error); return; }
      if (done) return;
    }
    if (!asyncResponse) { clearTimeout(timer); reject(new Error('官网窗口桥接尚未就绪')); }
  });
}
async function isolated(win, code) {
  if (!isAppleShop(win.webContents.getURL())) throw new Error('此操作仅适用于 Apple 香港商店页面');
  return win.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
}
async function inject(win, files, world) {
  if (!Array.isArray(files) || files.length > 3 || files.some(file => !['page-bridge.js', 'content.js', 'purchase-page.js'].includes(file))) throw new Error('不允许执行此脚本');
  await isolated(win, `(${remoteBootstrap.toString()})()`);
  for (const file of files) {
    if ((file === 'page-bridge.js') !== (world === 'MAIN')) throw new Error('脚本隔离环境不匹配');
    const source = await fsp.readFile(path.join(root, 'extension', file), 'utf8');
    if (!isAppleShop(win.webContents.getURL())) throw new Error('官网页面已经跳转');
    if (world === 'MAIN') await win.webContents.executeJavaScript(source);
    else await isolated(win, source);
  }
  return [];
}
async function createRemote(url, active = false) {
  if (!isAppleNavigation(url)) throw new Error('只允许打开 Apple 官方 HTTPS 页面');
  if (smoke) { smokeState.tab = { id: 900001, windowId: 900001, url, status: 'complete', discarded: false, active }; return smokeState.tab; }
  const win = new BrowserWindow({ width: 1180, height: 830, show: true, icon, title: 'Apple 官网 · 首次连接请查询附近门店',
    webPreferences: { partition: 'persist:apple-shop', sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, webSecurity: true, navigateOnDragDrop: false } });
  win.requestedURL = url;
  win.stockConnection = createConnectionState();
  const tabId = win.webContents.id;
  remoteWindows.set(tabId, win);
  win.setMenu(Menu.buildFromTemplate([{ label: '官网', submenu: [
    { label: '返回', click: () => { if (win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack(); } },
    { label: '手动刷新', click: () => win.webContents.reload() },
    { label: '回到监控面板', click: showMain }, { label: '隐藏官网窗口', click: () => win.hide() }
  ] }]));
  const protectNavigation = (event, target) => { if (!isAppleNavigation(typeof target === 'string' ? target : event.url)) event.preventDefault(); };
  win.webContents.on('will-navigate', protectNavigation);
  win.webContents.on('will-redirect', protectNavigation);
  win.webContents.setWindowOpenHandler(({ url: destination }) => {
    if (isAppleNavigation(destination)) void createRemote(destination, true).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('did-start-loading', () => sendEvent('tabs.onUpdated', [win.webContents.id, { status: 'loading' }, tabFor(win)], true));
  win.webContents.on('did-start-navigation', (_event, destination, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { win.requestedURL = destination; win.stockConnection.begin(); }
  });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) {
      win.stockConnection.failed(PROXY_FAILURES.has(code) ? `无法通过代理（${proxyLabel(proxySettings)}）打开官网，请确认代理软件已运行，或在“频率与通知 → 网络代理”中修改。` : undefined);
      sendEvent('tabs.onUpdated', [tabId, { status: 'complete' }, tabFor(win)], true);
    }
  });
  win.webContents.on('did-finish-load', () => {
    void (async () => {
      if (isAppleShop(win.webContents.getURL())) {
        await inject(win, ['page-bridge.js'], 'MAIN');
        await inject(win, ['content.js']);
      }
    })().catch(() => {}).finally(() => { if (!win.isDestroyed()) {
      win.stockConnection.loaded();
      sendEvent('tabs.onUpdated', [win.webContents.id, { status: 'complete' }, tabFor(win)], true);
    } });
  });
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
  win.on('closed', () => { remoteWindows.delete(tabId); });
  void win.loadURL(url).catch(() => { if (!win.isDestroyed()) win.stockConnection.failed(); });
  return tabFor(win);
}
async function openApple() {
  const { ownedMonitorTab, tasks = [] } = await store.get(['ownedMonitorTab', 'tasks']);
  const existing = remoteWindows.get(ownedMonitorTab);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { ok: true }; }
  const { productPurchaseURL } = await import(pathToFileURL(path.join(root, 'extension/shared.js')).href);
  const url = tasks[0] ? productPurchaseURL(tasks[0]) : 'https://www.apple.com/hk-zh/shop/buy-iphone';
  const tab = await createRemote(url, true);
  await store.set({ ownedMonitorTab: tab.id });
  return { ok: true };
}
async function prepareStockCheck(id) {
  if (smoke) return smokeState.preparation || { ready: true };
  const win = getRemote(id);
  // Observe site-initiated requests only. Waiting here never refreshes the page
  // or sends a warm-up/probe HTTP request to Apple.
  const deadline = Date.now() + 8000;
  let result;
  do {
    if (win.isDestroyed()) return { ready: false, reason: 'window-closed', message: '官网窗口已关闭，请重新打开并连接。' };
    result = win.stockConnection.readiness();
    if (result.ready || !['page-loading', 'website-not-ready'].includes(result.reason)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  if (!result.ready) { win.show(); win.focus(); }
  return result;
}
// Called by the engine while it holds its check lock with monitoring paused.
// Equivalent to starting from a fresh Data\Browser for the Apple window only:
// the dashboard/engine session (tasks, history) is untouched.
async function resetAppleSession() {
  const windows = [...remoteWindows.values()].filter(win => !win.isDestroyed());
  if (windows.some(win => win.monitorInFlight)) throw new Error('库存请求仍在进行，请稍后再重置');
  for (const win of windows) win.destroy();
  remoteWindows.clear();
  smokeState.tab = null;
  const ses = session.fromPartition('persist:apple-shop');
  await ses.clearStorageData();
  await ses.clearCache();
  return { ok: true };
}
async function applyProxy(settings) {
  const ses = session.fromPartition('persist:apple-shop');
  await ses.setProxy(proxyConfig(settings));
  // Pooled sockets would otherwise keep using the previous route.
  await ses.closeAllConnections();
  proxySettings = settings;
}
async function saveProxy(input) {
  const state = await store.get(['monitoring', 'monitorState']);
  if (state.monitoring || state.monitorState?.checking) throw new Error('请先暂停监控并等待本次检查结束，再修改代理');
  const settings = normalizeProxy(input);
  await store.set({ proxySettings: settings });
  await applyProxy(settings);
  return { settings, label: proxyLabel(settings) };
}
function connectionDiagnostics() {
  return { version: VERSION, electron: process.versions.electron, chromium: process.versions.chrome, proxy: proxyLabel(proxySettings),
    windows: [...remoteWindows.values()].filter(win => !win.isDestroyed()).map(win => win.stockConnection.snapshot()),
    note: '仅记录本程序官网窗口的页面/门店接口状态；不含网址参数、请求头、Cookie、响应正文或浏览器个人数据。' };
}
async function backupData() {
  if (backupBusy) throw new Error('正在导出备份');
  const state = await store.get(['monitoring', 'monitorState']);
  if (state.monitoring || state.monitorState?.checking) throw new Error('请先暂停并等待本次检查完成后导出备份');
  backupBusy = true;
  try {
    const selected = await dialog.showOpenDialog(dashboard, { title: '选择备份保存目录', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled) return { cancelled: true };
    const [checks, changes] = await Promise.all([runtimeRequest({ type: 'export-history', mode: 'all' }), runtimeRequest({ type: 'export-history', mode: 'changes' })]);
    if (!checks?.ok || !changes?.ok) throw new Error('历史导出未完成，请重试');
    const saved = await store.get(['tasks', 'monitorSettings', 'purchaseSettings', 'connectionHealth', 'stockMemory', 'uiSelection']);
    const destination = path.join(selected.filePaths[0], 'AppleStockMonitor-备份-' + new Date().toISOString().replace(/[:.]/g, '-'));
    await fsp.mkdir(destination);
    await Promise.all([
      fsp.writeFile(path.join(destination, '设置与最近状态.json'), JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), ...saved }, null, 2)),
      fsp.writeFile(path.join(destination, '全部检查.csv'), '\uFEFF' + checks.csv),
      fsp.writeFile(path.join(destination, '库存变化.csv'), '\uFEFF' + changes.csv),
      fsp.writeFile(path.join(destination, '说明.txt'), '包含设置、最近状态和历史 CSV；不含 Cookie、登录会话或 Bark 密钥。此导出用于保存和核对，没有自动导入功能。\r\n完整迁移请退出程序后复制整个 Data 文件夹。\r\n')
    ]);
    return { cancelled: false, path: destination };
  } finally { backupBusy = false; }
}

async function call(event, request) {
  const role = trustedRole(event), method = request?.method, args = request?.args;
  if (!Array.isArray(args)) throw new Error('无效参数');
  if (method === 'desktop.getInfo') return { version: VERSION, dataPath, platform: process.platform, packaged: app.isPackaged };
  if (role === 'dashboard') {
    if (method === 'runtime.sendMessage') {
      if (backupBusy && !['get-history', 'get-monitor-settings', 'get-purchase-settings', 'get-bark-settings', 'stop-monitor', 'export-diagnostics'].includes(args[0]?.type)) throw new Error('正在导出备份，请稍后操作');
      return runtimeRequest(args[0]);
    }
    if (method === 'desktop.openApple') return openApple();
    if (method === 'desktop.connectionDiagnostics') return connectionDiagnostics();
    if (method === 'desktop.openDataFolder') { const error = await shell.openPath(dataPath); if (error) throw new Error(error); return { ok: true }; }
    if (method === 'desktop.backupData') return backupData();
    if (method === 'desktop.getProxy') return { settings: proxySettings, defaults: DEFAULT_PROXY, label: proxyLabel(proxySettings) };
    if (method === 'desktop.setProxy') return saveProxy(args[0]);
    if (method === 'desktop.testProxy') {
      const settings = normalizeProxy(args[0]);
      if (settings.mode !== 'custom') return { ok: true, message: settings.mode === 'direct' ? '直连模式不使用代理，无需测试。' : '跟随系统代理时，由 Windows 代理设置决定线路。' };
      return testProxyPort(settings);
    }
    if (method === 'storage.local.get') {
      const keys = args[0];
      if (!Array.isArray(keys) || keys.some(key => !['tasks', 'monitoring', 'monitorState', 'uiSelection', 'connectionHealth'].includes(key))) throw new Error('面板不允许直接读取此设置');
      return store.get(keys);
    }
    if (method === 'storage.local.set' && Object.keys(args[0] || {}).every(key => key === 'uiSelection')) return store.set(args[0]);
    throw new Error('面板操作不在允许范围内');
  }
  if (smoke) {
    if (method === 'tabs.get' && smokeState.tab?.id === args[0]) return smokeState.tab;
    if (method === 'tabs.update' && smokeState.tab?.id === args[0]) { Object.assign(smokeState.tab, args[1]); return smokeState.tab; }
    if (method === 'tabs.sendMessage' && smokeState.tab?.id === args[0]) {
      if (args[1].type === 'ping') return { ok: true, bridgeReady: true };
      if (args[1].type !== 'stock-check') throw new Error('离线自检不执行购买操作');
      smokeState.requests++;
      return smokeState.nextResponse || { status: 0, error: '离线自检没有设置响应' };
    }
    if (method === 'notifications.create') return args[0];
    if (['tabs.reload', 'scripting.executeScript'].includes(method)) throw new Error('离线自检不执行官网脚本或刷新');
  }
  switch (method) {
    case 'desktop.prepareStockCheck': return prepareStockCheck(args[0]);
    case 'desktop.resetAppleSession': return resetAppleSession();
    case 'storage.local.get': return store.get(args[0]);
    case 'storage.local.set': return store.set(args[0]);
    case 'storage.local.setAccessLevel': return;
    case 'alarms.get': { const alarm = alarms.get(args[0]); return alarm ? { name: args[0], periodInMinutes: alarm.periodInMinutes } : undefined; }
    case 'alarms.create': {
      const [name, options] = args;
      if (name !== 'apple-hk-stock-check') throw new Error('未知定时任务');
      if (alarms.has(name)) clearInterval(alarms.get(name).timer);
      // Ten-second wakeups are local only; the tested worker enforces SKU intervals and 541 holds.
      const timer = setInterval(() => sendEvent('alarms.onAlarm', [{ name }], true), 10000);
      alarms.set(name, { timer, periodInMinutes: options.periodInMinutes }); return;
    }
    case 'alarms.clear': { const alarm = alarms.get(args[0]); if (alarm) clearInterval(alarm.timer); return alarms.delete(args[0]); }
    case 'tabs.create': {
      if (args[0].url === pageURL) { showMain(); return { id: dashboard.webContents.id, windowId: dashboard.id, url: pageURL }; }
      return createRemote(args[0].url, args[0].active);
    }
    case 'tabs.query': return args[0]?.url === pageURL ? [{ id: dashboard.webContents.id, windowId: dashboard.id, url: pageURL }] : [...remoteWindows.values()].map(tabFor);
    case 'tabs.get': return tabFor(getRemote(args[0]));
    case 'tabs.update': {
      if (args[0] === dashboard.webContents.id) { showMain(); return { id: args[0], windowId: dashboard.id, url: pageURL }; }
      const win = getRemote(args[0]), options = args[1];
      if (options.url) { if (!isAppleNavigation(options.url)) throw new Error('非 Apple 官网地址'); win.requestedURL = options.url; win.stockConnection.begin(); void win.loadURL(options.url).catch(() => { if (!win.isDestroyed()) win.stockConnection.failed(); }); }
      if (options.active) { win.show(); win.focus(); }
      return tabFor(win);
    }
    case 'tabs.reload': { const win = getRemote(args[0]); if (!isAppleShop(win.webContents.getURL())) throw new Error('仅允许刷新香港商店页面'); win.webContents.reload(); return; }
    case 'tabs.sendMessage': {
      const win = getRemote(args[0]);
      if (args[1]?.type === 'stock-check') {
        const prepared = win.stockConnection.readiness();
        if (!prepared.ready) return { status: 0, preparation: prepared };
        win.monitorInFlight = true;
      }
      try {
        await isolated(win, `(${remoteBootstrap.toString()})()`);
        const result = await timeout(isolated(win, `globalThis.__desktopDispatch(${JSON.stringify(args[1])})`), 32000, '官网窗口响应超时');
        if (args[1]?.type === 'stock-check') win.stockConnection.monitorResult(result);
        return result;
      } finally { win.monitorInFlight = false; }
    }
    case 'scripting.executeScript': return inject(getRemote(args[0]?.target?.tabId), args[0].files, args[0].world);
    case 'windows.update': { const win = BrowserWindow.fromId(args[0]); if (win) { win.show(); win.focus(); } return; }
    case 'notifications.create': {
      if (!Notification.isSupported()) return args[0];
      const notification = new Notification({ title: args[1].title, body: args[1].message, icon });
      notification.on('click', () => sendEvent('notifications.onClicked', [args[0]], true)); notification.show(); return args[0];
    }
    default: throw new Error('未知桌面操作');
  }
}

async function quitProgram() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await timeout(runtimeRequest({ type: 'stop-monitor' }), 4000, '停止超时'); } catch {}
  try { await store.set({ monitoring: false }); await store.flush(); } catch {}
  clearAlarms(); quitting = true; app.quit();
}
function localWindow(role) {
  const win = new BrowserWindow({ width: 1350, height: 900, minWidth: 880, minHeight: 680, show: false, icon,
    title: role === 'engine' ? '监控引擎' : 'Apple 香港库存监控',
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
      webSecurity: true, navigateOnDragDrop: false, spellcheck: false } });
  localPages.set(win.webContents, role);
  if (smoke) {
    win.webContents.on('console-message', (details) => {
      if (details?.level === 'error') fs.appendFileSync(path.join(dataPath, 'renderer-errors.txt'), role + ': ' + details.message + '\n');
    });
    win.webContents.on('preload-error', (_event, _file, error) => fs.appendFileSync(path.join(dataPath, 'renderer-errors.txt'), role + ' preload: ' + error.message + '\n'));
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!isLocalPage(url || event.url, role)) event.preventDefault(); });
  win.webContents.on('render-process-gone', () => {
    if (quitting) return;
    clearAlarms(); void store.set({ monitoring: false }).catch(() => {});
    dialog.showErrorBox('监控已停止', '程序页面意外退出，监控已暂停。请退出并重新打开程序，原有数据会保留。');
  });
  return win;
}
async function start() {
  store = createStorage(path.join(dataPath, 'settings.json'), { onChanged: (changes, area) => sendEvent('storage.onChanged', [changes, area || 'local']) });
  const existing = await store.get();
  // Each launch starts paused; reusing a saved browser window ID is never valid.
  await store.set({ monitoring: false, ownedMonitorTab: null,
    ...(!existing.monitorSettings ? { monitorSettings: { intervalSeconds: 60, focusSkus: [], boostUntil: 0 } } : {}) });
  // Apply before any Apple window exists. The offline self-test never leaves the machine.
  let savedProxy = { ...DEFAULT_PROXY };
  try { savedProxy = normalizeProxy(existing.proxySettings); } catch {}
  await applyProxy(smoke ? { ...savedProxy, mode: 'direct' } : savedProxy);
  protocol.handle('stockapp', async request => {
    try {
      const file = appResource(request.url, root), data = await fsp.readFile(file);
      return new Response(data, { headers: { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.day.app; object-src 'none'; frame-src 'none'; base-uri 'none'" } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  for (const ses of [session.defaultSession, session.fromPartition('persist:apple-shop')]) {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    if (smoke) ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  }
  session.fromPartition('persist:apple-shop').webRequest.onCompleted(details => {
    const win = remoteWindows.get(details.webContentsId);
    if (!win || win.isDestroyed() || (win.monitorInFlight && requestKind(details.url, details.resourceType) === 'pickup')) return;
    win.stockConnection.observe(details);
  });
  ipcMain.handle('desktop:call', call);
  ipcMain.on('desktop:engine-ready', event => { try { if (trustedRole(event) === 'engine') resolveEngine(); } catch {} });
  ipcMain.on('desktop:runtime-response', (event, response) => {
    try { if (trustedRole(event) !== 'engine') return; } catch { return; }
    const task = pending.get(response?.id); if (!task) return;
    clearTimeout(task.timer); pending.delete(response.id); task.resolve(response.result);
  });
  dashboard = localWindow('dashboard'); engine = localWindow('engine');
  dashboard.setMenu(null); engine.setMenu(null);
  dashboard.on('close', event => {
    if (quitting) return;
    event.preventDefault(); if (closeDialog) return; closeDialog = true;
    void dialog.showMessageBox(dashboard, { type: 'question', title: '关闭窗口', message: '选择后台运行或退出程序',
      detail: '后台运行会保留已开启的监控；退出会停止监控，下次启动默认暂停。', buttons: ['后台运行（托盘）', '退出程序', '取消'], defaultId: 0, cancelId: 2
    }).then(({ response }) => { if (response === 0) dashboard.hide(); if (response === 1) void quitProgram(); }).finally(() => { closeDialog = false; });
  });
  await timeout(engine.loadURL(engineURL), 30000, '监控引擎页面加载超时');
  await timeout(engineReady, 15000, '监控引擎启动失败');
  await timeout(dashboard.loadURL(pageURL), 30000, '监控面板加载超时');
  if (smoke) {
    const { runSelfTest } = require('./self-test.cjs');
    try { await runSelfTest({ dashboard, engine, store, dataPath, runtimeRequest, smokeState, inject, isolated }); app.exit(0); }
    catch (error) { await fsp.writeFile(path.join(dataPath, 'self-test-failure.txt'), error.stack); app.exit(1); }
    return;
  }
  tray = new Tray(icon); tray.setToolTip('Apple 香港库存监控');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开监控面板', click: showMain }, { label: '打开 Apple 官网', click: () => void openApple().catch(error => dialog.showErrorBox('官网窗口', error.message)) },
    { label: '网络代理设置', click: () => { showMain(); void dashboard.webContents.executeJavaScript("location.hash = 'settings'; document.getElementById('proxy-title')?.scrollIntoView()").catch(() => {}); } },
    { label: '暂停监控', click: () => void runtimeRequest({ type: 'stop-monitor' }).catch(() => {}) },
    { type: 'separator' }, { label: '退出程序', click: () => void quitProgram() }
  ]));
  tray.on('double-click', showMain); dashboard.show();
  powerMonitor.on('resume', () => { if (alarms.size) sendEvent('alarms.onAlarm', [{ name: 'apple-hk-stock-check' }], true); });
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', showMain);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quitProgram(); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(start).catch(error => {
    if (smoke) { fs.writeFileSync(path.join(dataPath, 'self-test-failure.txt'), error.stack); app.exit(1); }
    else { dialog.showErrorBox('启动失败', error.message + '\n请确认程序已完整解压到可写目录；已有数据未清除。'); quitting = true; app.quit(); }
  });
}
