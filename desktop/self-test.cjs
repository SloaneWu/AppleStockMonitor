'use strict';
// Runs the actual packaged Chromium renderers/IPC/storage/IndexedDB offline.
// It uses simulated stock responses and never contacts Apple or Bark.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { BrowserWindow, session } = require('electron');
const { createConnectionState } = require('./connection.cjs');
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(100); }
  throw new Error('自检等待超时：' + label);
}
async function runSelfTest({ dashboard, engine, store, dataPath, runtimeRequest, smokeState, inject, isolated }) {
  const checks = [];
  const runUI = code => dashboard.webContents.executeJavaScript(code);
  await eventually(() => runUI("!document.getElementById('add').disabled && !document.getElementById('monitor-settings-save').disabled"), '界面初始化');
  const initial = await store.get();
  assert.equal(initial.monitoring, false);
  assert.equal(initial.monitorSettings.intervalSeconds, 60);
  assert.equal((await runUI('typeof require')), 'undefined');
  assert.equal((await runUI('typeof process')), 'undefined');
  checks.push('真实桌面窗口、隔离预加载与后台启动成功；默认暂停、60 秒');
  await runUI("document.getElementById('add').click()");
  await eventually(async () => (await store.get('tasks')).tasks?.length === 6, '添加六家门店');
  await eventually(() => runUI("document.querySelectorAll('#tasks .task').length === 6"), '界面显示六家门店');
  const { tasks } = await store.get('tasks');
  assert.equal((await runUI('chrome.desktop.openApple()')).ok, true);
  assert.match(smokeState.tab.url, /^https:\/\/www\.apple\.com\/hk-zh\/shop\/buy-iphone\//);
  checks.push('面板真实点击经 IPC 保存六个门店任务');
  const response = { status: 200, responseKind: 'json', body: JSON.stringify({ body: { stores: tasks.map(task => ({
    storeNumber: task.store.StoreNumber, partsAvailability: { [task.product.Code]: { pickupDisplay: 'unavailable' } }
  })) } }) };
  smokeState.nextResponse = response;
  smokeState.preparation = { ready: false, reason: 'website-not-ready', message: '离线模拟：官网门店服务尚未准备好，未发送监控查询。' };
  assert.equal((await runtimeRequest({ type: 'check-now' })).ok, false);
  assert.equal(smokeState.requests, 0);
  assert.equal((await runtimeRequest({ type: 'get-history', mode: 'all', offset: 0, limit: 50 })).total, 0);
  assert.equal((await store.get('monitoring')).monitoring, false);
  const diagnostic = await runUI('chrome.desktop.connectionDiagnostics()');
  assert.equal(diagnostic.version, '4.0.1');
  assert.equal((await runUI('typeof chrome.desktop.prepareStockCheck')), 'undefined');
  checks.push('首次官网连接未就绪时，真实 EXE 零查询、零虚假库存记录、保持暂停；诊断接口权限正确');
  smokeState.preparation = { ready: true };
  assert.equal((await runtimeRequest({ type: 'reconnect' })).recoveryValidated, true);
  assert.equal(smokeState.requests, 1);
  let history = await runtimeRequest({ type: 'get-history', mode: 'all', offset: 0, limit: 50 });
  assert.equal(history.total, 6);
  assert.ok(history.items.every(row => row.status === '无货'));
  checks.push('模拟库存经真实后台写入 IndexedDB，六项结果准确');
  await store.set({ skuCooldowns: {} });
  smokeState.nextResponse = { status: 541, responseKind: 'html' };
  assert.equal((await runtimeRequest({ type: 'check-now' })).ok, true);
  let saved = await store.get();
  assert.equal(saved.connectionHealth.manualRecoveryRequired, true);
  assert.equal(saved.monitoring, false);
  assert.equal((await runtimeRequest({ type: 'start-monitor', tasks })).ok, false);
  assert.equal((await runtimeRequest({ type: 'check-now' })).ok, false);
  assert.equal(smokeState.requests, 2);
  await eventually(() => runUI("document.getElementById('monitor-badge').textContent === '保护性暂停' && document.getElementById('start').disabled"), '541 界面保护');
  checks.push('541 持久暂停同步到界面，开始与立即检查无法绕过');
  // Advance only saved test deadlines; this does not claim real elapsed endurance.
  await store.set({ connectionHealth: { ...saved.connectionHealth, notBefore: Date.now() - 1 }, skuCooldowns: {} });
  await runtimeRequest({ type: 'scheduler-pulse' });
  assert.equal(smokeState.requests, 2);
  smokeState.nextResponse = response;
  const recovery = await runtimeRequest({ type: 'reconnect' });
  assert.equal(recovery.recoveryValidated, true);
  saved = await store.get();
  assert.equal(saved.monitoring, false);
  assert.equal(saved.connectionHealth.manualRecoveryRequired, false);
  assert.equal(smokeState.requests, 3);
  checks.push('冷却后不自动请求；单次验证成功仍保持暂停');
  const csv = await runtimeRequest({ type: 'export-history', mode: 'all' });
  assert.equal(csv.ok, true);
  assert.ok(csv.csv.includes('541'));
  history = await runtimeRequest({ type: 'get-history', mode: 'all', offset: 0, limit: 50 });
  assert.equal(history.total, 18);
  const denied = await runUI("chrome.tabs.create({url:'https://www.apple.com/hk/shop/bag'}).then(()=>false,()=>true)");
  assert.equal(denied, true);
  const secretsDenied = await runUI("chrome.storage.local.get(['barkConfig']).then(()=>false,()=>true)");
  assert.equal(secretsDenied, true);
  checks.push('历史导出及面板权限边界通过');
  await store.flush();
  const disk = JSON.parse(await fs.readFile(path.join(dataPath, 'settings.json'), 'utf8'));
  assert.equal(disk.tasks.length, 6);
  assert.equal(disk.monitoring, false);
  // Reload both local pages to verify saved settings and the on-disk history DB.
  await engine.webContents.reload();
  await delay(500);
  history = await runtimeRequest({ type: 'get-history', mode: 'all', offset: 0, limit: 50 });
  assert.equal(history.total, 18);
  checks.push('引擎重新加载后保留任务与 18 条历史');
  await eventually(() => runUI("document.querySelectorAll('#tasks .task').length === 6"), '引擎重载后界面保留六家门店');
  // Test the real MAIN/isolated bridge in a session whose HTTPS responses are
  // entirely supplied here. No socket or inventory request reaches Apple.
  const fixtureSession = session.fromPartition('offline-bridge-test');
  const connection = createConnectionState();
  fixtureSession.webRequest.onCompleted(details => connection.observe(details));
  let fixtureStatus = 200, fixtureRequests = 0;
  fixtureSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.origin !== 'https://www.apple.com') return new Response('Blocked in test', { status: 403 });
    if (url.pathname.endsWith('/fulfillment-messages')) {
      fixtureRequests++;
      return new Response(fixtureStatus === 200 ? response.body : '<html>Simulated blocked response</html>', {
        status: fixtureStatus, headers: { 'Content-Type': fixtureStatus === 200 ? 'application/json' : 'text/html' }
      });
    }
    return new Response('<!doctype html><meta charset="utf-8"><title>Offline fixture</title><p>Local test only</p>', {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'none'; connect-src 'self'" }
    });
  });
  fixtureSession.protocol.handle('http', () => new Response('Blocked in test', { status: 403 }));
  const fixture = new BrowserWindow({ show: false, webPreferences: { session: fixtureSession, sandbox: true,
    contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await fixture.loadURL('https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro');
    connection.loaded();
    assert.equal(connection.readiness().ready, false);
    assert.equal(await fixture.webContents.executeJavaScript('typeof require + ":" + typeof desktopChrome'), 'undefined:undefined');
    await inject(fixture, ['page-bridge.js'], 'MAIN');
    await inject(fixture, ['content.js']);
    const ping = await isolated(fixture, 'globalThis.__desktopDispatch({type:"ping"})');
    assert.equal(ping.bridgeReady, true);
    assert.equal(fixtureRequests, 0);
    const params = new URLSearchParams({ fae: 'true', pl: 'true', location: 'central', 'parts.0': tasks[0].product.Code, 'mts.0': 'regular' });
    const message = { type: 'stock-check', path: '/hk-zh/shop/fulfillment-messages?' + params };
    const valid = await isolated(fixture, 'globalThis.__desktopDispatch(' + JSON.stringify(message) + ')');
    assert.equal(valid.status, 200);
    assert.deepEqual(JSON.parse(valid.body), JSON.parse(response.body));
    assert.equal(fixtureRequests, 1);
    await eventually(() => connection.readiness().ready, '官网响应被动观察');
    assert.equal(connection.snapshot().monitorRequests, 0);
    fixtureStatus = 541;
    const blocked = await isolated(fixture, 'globalThis.__desktopDispatch(' + JSON.stringify(message) + ')');
    assert.equal(blocked.status, 541);
    assert.equal(blocked.responseKind, 'html');
    assert.equal(blocked.body, '');
    assert.equal(fixtureRequests, 2);
    await eventually(() => connection.readiness().reason === 'website-blocked', '官网 541 被动观察');
    assert.equal(connection.readiness().status, 541);
    checks.push('真实 Chromium 被动观察：无响应不放行、JSON 响应后可验证、541 后再次阻止追加查询；未产生额外请求');
    checks.push('真实 Chromium MAIN/隔离世界桥接通过：无网络探测、单次有效查询与 541 响应均正确');
    checks.push('官网窗口隔离通过：页面没有 Node 或本机接口；测试 HTTPS 完全由内存响应');
  } finally { fixture.destroy(); }
  await dashboard.webContents.executeJavaScript("location.hash='overview'");
  await delay(300);
  await fs.writeFile(path.join(dataPath, 'ui-state.json'), JSON.stringify(await runUI("({rows:document.querySelectorAll('#tasks .task').length, count:document.getElementById('task-count').textContent, error:document.getElementById('form-message').textContent, url:location.href})"), null, 2));
  await eventually(() => runUI("document.querySelectorAll('#tasks .task').length === 6"), '视图切换后任务仍在');
  // Wake the hidden compositor once before saving its current frame.
  await dashboard.webContents.capturePage();
  await delay(200);
  const screenshot = await dashboard.webContents.capturePage();
  await fs.writeFile(path.join(dataPath, 'desktop-preview.png'), screenshot.toPNG());
  await fs.writeFile(path.join(dataPath, 'self-test-result.json'), JSON.stringify({ version: '4.0.1', at: new Date().toISOString(),
    passed: checks.length, checks, mode: 'packaged-electron-offline', stockRequests: smokeState.requests,
    note: '真实 EXE 的窗口/IPC/存储自检；库存为模拟响应，未访问 Apple/Bark，未验证官网长时间运行。' }, null, 2));
}
module.exports = { runSelfTest };
