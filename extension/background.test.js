// Run with: node --experimental-vm-modules --test background.test.js
// Loads the real worker and its real parser/core. Only browser APIs and the
// history persistence boundary are replaced; no Apple requests are made.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as immediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const productsData = JSON.parse(await readFile(new URL('./data/products/product_data_hk.json', import.meta.url), 'utf8'));
const storesData = JSON.parse(await readFile(new URL('./data/stores/store_hk.json', import.meta.url), 'utf8'));
const products = Object.values(productsData.products).flat().filter(p => /^iPhone 18 Pro/.test(p.Model));
const store = storesData.stores.find(s => s.StoreNumber === 'R428');
const baseTime = Date.parse('2026-09-20T12:00:00.000Z');
const clone = value => structuredClone(value);
const TEST_BARK_KEY = 'TEST_DEVICE_KEY';
function tasks(count = 1) {
  return products.slice(0, count).map((product, i) => ({
    id: 'task-' + i, areaCode: 'hk', areaTitle: '香港', product: clone(product), store: clone(store)
  }));
}
function success(inputTasks, token = 'available') {
  return { status: 200, body: JSON.stringify({ body: { stores: [{
    storeNumber: store.StoreNumber,
    partsAvailability: Object.fromEntries(inputTasks.map(t => [t.product.Code, { pickupDisplay: token }]))
  }] } }) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    async emit(...args) { return Promise.all([...listeners].map(fn => fn(...args))); },
    listeners
  };
}
async function until(predicate, message = 'expected asynchronous operation to start') {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail(message);
}

async function harness(options = {}) {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Use --experimental-vm-modules for worker integration tests');
  const data = options.data || { monitoring: true, tasks: tasks() };
  const history = options.history || [];
  let now = options.now || baseTime;
  const requests = [], notifications = [], alarms = [], clearedAlarms = [], barkRequests = [];
  const appleTab = { id: 7, windowId: 1, status: options.tabStatus || 'complete', url: 'https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro' };
  const getURL = path => 'chrome-extension://test-extension/' + path;
  const chrome = {
    ...(options.desktop ? { desktop: options.desktop } : {}),
    runtime: { id: 'test-extension', getURL, getManifest: () => ({ version: '3.0.0' }), onInstalled: event(), onStartup: event(), onMessage: event() },
    action: { onClicked: event() },
    alarms: {
      onAlarm: event(),
      async get(name) { return alarms.findLast(alarm => alarm.name === name)?.schedule; },
      async create(name, schedule) { alarms.push({ name, schedule: clone(schedule) }); },
      async clear(name) { clearedAlarms.push(name); return true; }
    },
    notifications: {
      onClicked: event(), async clear() {},
      async create(id, notification) {
        notifications.push({ id, notification: clone(notification) });
        if (options.notificationError) throw new Error(options.notificationError);
      }
    },
    storage: { local: {
      async setAccessLevel(options) { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); },
      async get(keys) {
        if (keys == null) return clone(data);
        if (typeof keys === 'string') keys = [keys];
        return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])]));
      },
      async set(values) { Object.assign(data, clone(values)); }
    } },
    tabs: {
      onUpdated: event(),
      async get() { return clone(appleTab); },
      async query() { return [clone(appleTab)]; },
      async create(options) { appleTab.url = options.url; return clone(appleTab); },
      reloads: [],
      async reload(id) { chrome.tabs.reloads.push(id); if (options.reloadGate) await options.reloadGate(); if (options.reloadError) throw new Error('reload failed'); },
      async update() { return clone(appleTab); },
      async sendMessage(id, message) {
        if (message.type === 'ping') { if (options.pingGate) await options.pingGate(); return options.pingRespond ? options.pingRespond() : { ok: true, bridgeReady: true }; }
        requests.push({ id, ...clone(message), at: now });
        return options.respond ? options.respond(message, requests.length) : success(data.tasks);
      }
    },
    windows: { async update() {} },
    scripting: { executions: [], async executeScript(details) {
      chrome.scripting.executions.push(clone(details));
      if (options.injectionGate) await options.injectionGate(details);
      if (options.injectionError) throw new Error('injection refused');
    } }
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    chrome, console, Date: ClockDate, URL, URLSearchParams,
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout, AbortController, structuredClone,
    fetch: async (url, init) => {
      if (url === 'https://api.day.app/push') {
        barkRequests.push({ url, ...clone({ method: init.method, body: init.body }) });
        return options.barkRespond ? options.barkRespond(init) : { ok: true, json: async () => ({ code: 200 }) };
      }
      if (options.fetchGate) await options.fetchGate(url);
      return { ok: true, json: async () => clone(url.includes('/products/') ? productsData : storesData) };
    }
  });
  const historyModule = new vm.SyntheticModule(['appendHistory', 'readHistory', 'exportHistory'], function () {
    this.setExport('appendHistory', async rows => {
      if (options.historyError) throw new Error(options.historyError);
      if (options.historyGate) await options.historyGate();
      history.push(...clone(rows));
    });
    this.setExport('readHistory', async ({ mode = 'all', offset = 0, limit = 50 } = {}) => {
      const all = history.filter(row => mode !== 'changes' || row.changed).slice().reverse();
      return { total: all.length, items: clone(all.slice(offset, offset + limit)) };
    });
    this.setExport('exportHistory', async () => 'history-export-stub');
  }, { context, identifier: new URL('./history.js', import.meta.url).href });
  const cache = new Map([[historyModule.identifier, historyModule]]);
  async function load(url) {
    if (cache.has(url)) return cache.get(url);
    const pending = readFile(new URL(url), 'utf8').then(source => new vm.SourceTextModule(source, { context, identifier: url }));
    cache.set(url, pending);
    return pending;
  }
  const background = await load(new URL('./background.js', import.meta.url).href);
  await background.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
  await background.evaluate();
  async function message(input, sender = { id: chrome.runtime.id, url: getURL('app.html') }) {
    const listener = [...chrome.runtime.onMessage.listeners][0];
    return new Promise(resolve => {
      const keepOpen = listener(input, sender, resolve);
      if (!keepOpen) resolve(undefined);
    });
  }
  return {
    data, history, requests, notifications, alarms, clearedAlarms, barkRequests, chrome, appleTab, message,
    advance(ms) { now += ms; },
    now() { return now; }
  };
}

test('Bark settings retain or clear the key without echoing it to the dashboard', async () => {
  const h = await harness();
  assert.equal((await h.message({ type: 'get-bark-settings' })).configured, false);
  const saved = await h.message({ type: 'save-bark-settings', enabled: true, url: `https://api.day.app/${TEST_BARK_KEY}` });
  assert.equal(saved.ok, true);
  assert.equal(saved.enabled, true);
  assert.equal(saved.configured, true);
  assert.ok(!JSON.stringify(saved).includes(TEST_BARK_KEY));
  assert.equal(h.data.barkConfig.key, TEST_BARK_KEY);
  await h.message({ type: 'save-bark-settings', enabled: false, url: '' });
  assert.equal(h.data.barkConfig.key, TEST_BARK_KEY);
  assert.equal(h.data.barkConfig.enabled, false);
  await h.message({ type: 'clear-bark-settings' });
  assert.equal(h.data.barkConfig.key, '');
  assert.equal((await h.message({ type: 'test-bark' })).ok, false);
  assert.equal(h.barkRequests.length, 0);
});

test('Bark test sends only after explicit action and respects test cooldown', async () => {
  const h = await harness();
  await h.message({ type: 'save-bark-settings', enabled: false, url: TEST_BARK_KEY });
  assert.equal(h.barkRequests.length, 0);
  assert.equal((await h.message({ type: 'test-bark' })).ok, true);
  assert.equal(h.barkRequests.length, 1);
  assert.equal((await h.message({ type: 'test-bark' })).ok, false);
  assert.equal(h.barkRequests.length, 1);
  assert.equal(h.data.barkStatus.ok, true);
  assert.ok(!JSON.stringify(h.data.barkStatus).includes(TEST_BARK_KEY));
});

test('Bark stock alerts are independent of Windows notifications and deduplicate unchanged stock', async () => {
  const input = tasks();
  const h = await harness({ data: { monitoring: true, tasks: input, barkConfig: { enabled: true, key: TEST_BARK_KEY } }, notificationError: 'disabled' });
  await h.message({ type: 'check-now' });
  assert.equal(h.barkRequests.length, 1);
  h.advance(60000);
  await h.message({ type: 'check-now' });
  assert.equal(h.barkRequests.length, 1);
  assert.equal(h.data.monitorState.items['task-0'].status, '有货');
  assert.ok(!JSON.stringify(h.history).includes(TEST_BARK_KEY));
  assert.ok(!JSON.stringify(h.data.monitorState).includes(TEST_BARK_KEY));
});

test('Bark failures remain visible and cannot overwrite successful inventory', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(), barkConfig: { enabled: true, key: TEST_BARK_KEY } },
    barkRespond: async () => ({ ok: true, json: async () => ({ code: 400, message: TEST_BARK_KEY }) }) });
  assert.equal((await h.message({ type: 'check-now' })).ok, true);
  assert.equal(h.data.monitorState.items['task-0'].status, '有货');
  await until(() => h.data.barkStatus != null);
  assert.equal(h.data.barkStatus.ok, false);
  assert.ok(!JSON.stringify(h.data.monitorState).includes(TEST_BARK_KEY));
  assert.ok(!JSON.stringify(h.data.barkStatus).includes(TEST_BARK_KEY));
});

test('disabled Bark makes no phone requests', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(), barkConfig: { enabled: false, key: TEST_BARK_KEY } } });
  await h.message({ type: 'check-now' });
  assert.equal(h.barkRequests.length, 0);
});

test('worker handles HTTP/HTML/unknown data as errors without inventing no-stock history', async () => {
  const input = tasks();
  const responses = [
    { status: 541 }, { status: 503 }, { status: 200, body: '<html>verification</html>' },
    success(input, 'new-unknown-enum'), { status: 200, body: '{"body":{"stores":[]}}' }
  ];
  for (const response of responses) {
    const h = await harness({ respond: () => response });
    assert.equal((await h.message({ type: 'check-now' })).ok, true);
    assert.notEqual(h.data.monitorState.items['task-0'].status, '无货');
    assert.equal(h.history.at(-1).changed, false);
    assert.equal(h.data.monitorState.items['task-0'].lastSuccess, null);
    assert.equal(h.history.length, 1);
    assert.equal(h.notifications.length, 0);
  }
});

test('error then recovery preserves lastSuccess and does not send a duplicate restock notification', async () => {
  const input = tasks();
  const responses = [success(input), { status: 503 }, success(input)];
  const h = await harness({ respond: () => responses.shift() });
  await h.message({ type: 'check-now' });
  const firstSuccess = clone(h.data.monitorState.items['task-0'].lastSuccess);
  h.advance(60000);
  await h.message({ type: 'check-now' });
  assert.deepEqual(h.data.monitorState.items['task-0'].lastSuccess, firstSuccess);
  assert.equal(h.data.monitorState.items['task-0'].status, '查询异常');
  h.advance(120000);
  await h.message({ type: 'check-now' });
  assert.equal(h.data.monitorState.items['task-0'].status, '有货');
  assert.equal(h.notifications.length, 1);
  assert.equal(h.history.length, 3);
  assert.ok(h.history.every(row => !row.changed));
});

test('manual checks respect the 20-second floor and Retry-After, even across worker restart', async () => {
  const input = tasks();
  const first = await harness({ respond: () => success(input, 'unavailable') });
  await first.message({ type: 'check-now' });
  first.advance(19999);
  assert.equal((await first.message({ type: 'check-now' })).ok, false);
  assert.equal(first.requests.length, 1);
  first.advance(1);
  assert.equal((await first.message({ type: 'check-now' })).ok, true);
  assert.equal(first.requests.length, 2);
  first.advance(60000);
  const second = await harness({ data: first.data, history: first.history, now: first.now(), respond: () => ({ status: 429, retryAfter: '600' }) });
  await second.message({ type: 'check-now' });
  assert.equal(second.requests.length, 1);
  assert.equal(second.data.monitorState.items['task-0'].status, '请求受限');
  second.advance(599999);
  const third = await harness({ data: second.data, history: second.history, now: second.now() });
  assert.equal((await third.message({ type: 'check-now' })).ok, false);
  assert.equal((await third.message({ type: 'reconnect' })).ok, false);
  assert.equal(third.requests.length, 0);
  third.advance(1);
  assert.equal((await third.message({ type: 'check-now' })).ok, false);
  assert.equal((await third.message({ type: 'reconnect' })).recoveryValidated, true);
  assert.equal(third.requests.length, 1);
});

test('start and browser startup retain state/history while restoring the 30-second alarm', async () => {
  const input = tasks();
  const priorSuccess = { status: '有货', detail: 'prior observation', checkedAt: '2026-09-19T12:00:00.000Z' };
  const history = [{ checkedAt: priorSuccess.checkedAt, status: '有货', changed: false }];
  const data = {
    monitoring: false, tasks: input,
    cooldowns: { [input[0].product.Code]: { nextAt: baseTime + 60000, failures: 0 } },
    monitorState: { running: false, checking: true, items: { 'task-0': { status: '有货', lastSuccess: priorSuccess } }, log: [{ message: 'old log' }] }
  };
  const h = await harness({ data, history });
  assert.equal((await h.message({ type: 'start-monitor', tasks: input })).ok, true);
  assert.deepEqual(data.monitorState.items['task-0'].lastSuccess, priorSuccess);
  assert.ok(data.monitorState.log.some(row => row.message === 'old log'));
  assert.equal(history.length, 1);
  assert.equal(h.requests.length, 0);
  const restarted = await harness({ data, history });
  await restarted.chrome.runtime.onStartup.emit();
  assert.equal(data.monitorState.checking, false);
  assert.equal(data.monitorState.running, true);
  assert.equal(restarted.alarms.at(-1).schedule.periodInMinutes, 0.5);
  assert.equal((await restarted.message({ type: 'get-history' })).total, 1);
  assert.deepEqual(data.monitorState.items['task-0'].lastSuccess, priorSuccess);
});

test('pause during a request preserves its returned result but prevents the next group and resumed running', async () => {
  const input = tasks(9);
  const pending = deferred();
  const h = await harness({ data: { monitoring: true, tasks: input }, respond: () => pending.promise });
  const check = h.message({ type: 'check-now' });
  await until(() => h.requests.length === 1);
  assert.equal((await h.message({ type: 'stop-monitor' })).ok, true);
  pending.resolve(success(input, 'unavailable'));
  assert.equal((await check).ok, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.history.length, 8);
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.monitorState.running, false);
  assert.equal(h.data.monitorState.checking, false);
  assert.equal(h.data.monitorState.nextCheck, '');
  assert.equal(h.clearedAlarms.length, 1);
});

test('notification failure leaves successful inventory and history intact', async () => {
  const h = await harness({ notificationError: 'permission denied' });
  assert.equal((await h.message({ type: 'check-now' })).ok, true);
  assert.equal(h.data.monitorState.items['task-0'].status, '有货');
  assert.equal(h.data.monitorState.items['task-0'].lastSuccess.status, '有货');
  assert.equal(h.history[0].status, '有货');
  assert.equal(h.notifications.length, 1);
});

test('history persistence failure is visible without replacing valid stock', async () => {
  const h = await harness({ historyError: 'disk quota' });
  assert.equal((await h.message({ type: 'check-now' })).ok, true);
  assert.equal(h.data.monitorState.items['task-0'].status, '有货');
  assert.match(h.data.monitorState.historyError, /历史写入失败/);
});

test('configuration/history messages from a webpage are rejected', async () => {
  const h = await harness();
  const result = await h.message({ type: 'stop-monitor' }, { id: 'test-extension', url: 'https://www.apple.com/hk-zh/shop/' });
  assert.equal(result, undefined);
  assert.equal(h.data.monitoring, true);
});

test('pausing while catalog validation is pending prevents starting the inventory request', async () => {
  const gate = deferred();
  let fetching = 0;
  const h = await harness({ fetchGate: () => { fetching++; return gate.promise; } });
  const check = h.message({ type: 'check-now' });
  await until(() => fetching > 0);
  await h.message({ type: 'stop-monitor' });
  gate.resolve();
  await check;
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.monitorState.running, false);
});

test('pausing while the Apple tab loads prevents sending a new stock request', async () => {
  const h = await harness({ tabStatus: 'loading' });
  const check = h.message({ type: 'check-now' });
  await until(() => h.chrome.tabs.onUpdated.listeners.size > 0);
  await h.message({ type: 'stop-monitor' });
  h.appleTab.status = 'complete';
  await h.chrome.tabs.onUpdated.emit(h.appleTab.id, { status: 'complete' });
  await check;
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.monitorState.running, false);
});

test('541 stops all other batches and task reorder/re-add cannot bypass global cooldown', async () => {
  const input = tasks(9);
  const h = await harness({ data: { monitoring: true, tasks: input }, respond: () => ({ status: 541, responseKind: 'html' }) });
  await h.message({ type: 'check-now' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.history.length, 8);
  assert.equal(Object.values(h.data.monitorState.items).filter(i => i.status === '等待恢复').length, 1);
  const notBefore = h.data.connectionHealth.notBefore;
  await h.message({ type: 'stop-monitor' });
  const replacement = input.reverse().map((t, i) => ({ ...t, id: 'replacement-' + i }));
  assert.equal((await h.message({ type: 'save-tasks', tasks: replacement })).ok, true);
  assert.equal((await h.message({ type: 'start-monitor', tasks: replacement })).ok, false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.connectionHealth.notBefore, notBefore);
  const restarted = await harness({ data: h.data, now: h.now(), respond: () => ({ status: 541 }) });
  assert.equal((await restarted.message({ type: 'check-now' })).ok, false);
  assert.equal(restarted.requests.length, 0);
});

test('541 hold survives a day of pulses and alarm wakes without requests or automatic reloads', async () => {
  const input = tasks();
  const h = await harness({ data: { monitoring: true, tasks: input, monitorSettings: { intervalSeconds: 60 } },
    respond: (_message, number) => number <= 120 ? success(input, 'unavailable') : { status: 541 } });
  for (let minute = 0; minute < 120; minute++) {
    await h.message({ type: 'scheduler-pulse' });
    h.advance(60000);
  }
  await h.message({ type: 'check-now' });
  assert.equal(h.requests.length, 121);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.monitorState.nextCheck, '');
  for (let hour = 0; hour < 24; hour++) {
    h.advance(3600000);
    await h.chrome.alarms.onAlarm.emit({ name: 'apple-hk-stock-check' });
    await h.message({ type: 'scheduler-pulse' });
    assert.equal((await h.message({ type: 'check-now' })).ok, false);
    assert.equal((await h.message({ type: 'start-monitor', tasks: input })).ok, false);
  }
  assert.equal(h.requests.length, 121);
  assert.equal(h.chrome.tabs.reloads.length, 0);
  assert.equal(h.data.connectionHealth.state, 'needs-user');
  assert.equal(h.data.monitorState.items['task-0'].lastSuccess.status, '无货');
  const restarted = await harness({ data: h.data, now: h.now() });
  await restarted.message({ type: 'scheduler-pulse' });
  assert.equal((await restarted.message({ type: 'check-now' })).ok, false);
  assert.equal(restarted.requests.length, 0);
  assert.equal(restarted.chrome.tabs.reloads.length, 0);
  assert.equal(restarted.alarms.length, 0);
});

test('manual recovery stays latched for invalid JSON and failed HTTP, then valid stock clears it without resuming', async () => {
  const input = tasks();
  const responses = [{ status: 541 }, { status: 200, body: 'not JSON' }, { status: 503 }, success(input, 'unavailable')];
  const h = await harness({ respond: () => responses.shift() });
  await h.message({ type: 'check-now' });
  assert.equal((await h.message({ type: 'reconnect' })).ok, false);
  assert.equal(h.requests.length, 1);
  h.advance(120000);
  assert.equal((await h.message({ type: 'reconnect' })).ok, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  h.advance(240000);
  assert.equal((await h.message({ type: 'reconnect' })).ok, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  h.advance(480000);
  assert.equal((await h.message({ type: 'reconnect' })).recoveryValidated, true);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, false);
  assert.equal(h.data.connectionHealth.state, 'healthy');
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.monitorState.nextCheck, '');
  assert.equal(h.requests.length, 4);
  assert.equal(h.chrome.tabs.reloads.length, 0);
  h.advance(60000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 4);
});

test('reconnect preserves tasks/history/Bark and never refreshes a cart tab', async () => {
  const input = tasks();
  const h = await harness({ data: { monitoring: false, tasks: input, ownedMonitorTab: 7,
    barkConfig: { enabled: false, key: TEST_BARK_KEY } } });
  h.appleTab.url = 'https://www.apple.com/hk-zh/shop/bag';
  const result = await h.message({ type: 'reconnect' });
  assert.equal(result.ok, true);
  assert.equal(h.chrome.tabs.reloads.length, 0);
  assert.match(h.appleTab.url, /(?:product|buy-iphone)/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.connectionHealth.state, 'healthy');
  assert.equal(h.data.barkConfig.key, TEST_BARK_KEY);
  assert.equal(h.history.length, 1);
});

test('401, 403, 429 and HTML responses persist a manual hold after their cooldown expires', async () => {
  for (const response of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 200, body: '<!DOCTYPE html><html>challenge</html>' }]) {
    const h = await harness({ respond: () => response });
    await h.message({ type: 'check-now' });
    assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
    h.advance(86400000);
    await h.message({ type: 'scheduler-pulse' });
    assert.equal((await h.message({ type: 'check-now' })).ok, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.chrome.tabs.reloads.length, 0);
  }
});

test('manual validation queries one batch only and cannot trigger an enabled purchase action', async () => {
  const input = tasks(9);
  const h = await harness({ data: { monitoring: true, tasks: input,
    connectionHealth: { state: 'needs-user', manualRecoveryRequired: true, notBefore: baseTime - 1 },
    purchaseSettings: { enabled: true, sku: input[0].product.Code, maxPrice: 99999, quantity: 1, storePriority: [store.StoreNumber] } } });
  const result = await h.message({ type: 'reconnect' });
  assert.equal(result.recoveryValidated, true);
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].type, 'stock-check');
  assert.equal(h.history.length, 8);
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.purchaseOperations?.length || 0, 0);
  assert.equal(Object.keys(h.data.purchaseLocks || {}).length, 0);
  assert.equal(h.chrome.scripting.executions.some(row => row.files.includes('purchase-page.js')), false);
});

test('pause while a recovery response is in flight retains the latch despite valid stock', async () => {
  const pending = deferred(), input = tasks();
  const h = await harness({ data: { monitoring: false, tasks: input, connectionHealth: { state: 'needs-user', manualRecoveryRequired: true } }, respond: () => pending.promise });
  const recovery = h.message({ type: 'reconnect' });
  await until(() => h.requests.length === 1);
  await h.message({ type: 'stop-monitor' });
  pending.resolve(success(input));
  assert.equal((await recovery).ok, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.equal(h.data.connectionHealth.state, 'needs-user');
  assert.equal(h.data.monitoring, false);
  assert.equal(h.history.length, 1);
  h.advance(86400000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 1);
});

test('hold is durable before a pending history write and blocks a replacement worker', async () => {
  const gate = deferred();
  let writing = false;
  const h = await harness({ respond: () => ({ status: 541 }), historyGate: () => { writing = true; return gate.promise; } });
  const check = h.message({ type: 'check-now' });
  await until(() => writing);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.equal(h.data.monitoring, false);
  const restarted = await harness({ data: clone(h.data), now: h.now() + 86400000 });
  await restarted.message({ type: 'scheduler-pulse' });
  assert.equal((await restarted.message({ type: 'check-now' })).ok, false);
  assert.equal(restarted.requests.length, 0);
  assert.equal(restarted.chrome.tabs.reloads.length, 0);
  gate.resolve();
  await check;
});

test('pause during recovery history persistence cannot clear the manual hold', async () => {
  const gate = deferred();
  let writing = false;
  const h = await harness({ data: { monitoring: false, tasks: tasks(), connectionHealth: { state: 'needs-user', manualRecoveryRequired: true } },
    historyGate: () => { writing = true; return gate.promise; } });
  const recovery = h.message({ type: 'reconnect' });
  await until(() => writing);
  await h.message({ type: 'stop-monitor' });
  gate.resolve();
  assert.equal((await recovery).ok, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.equal(h.data.monitorState.nextCheck, '');
});

test('discarded tab requires manual opening during validation and is never refreshed automatically', async () => {
  const h = await harness({ data: { monitoring: false, tasks: tasks(), ownedMonitorTab: 7,
    connectionHealth: { state: 'needs-user', manualRecoveryRequired: true } } });
  h.appleTab.discarded = true;
  const result = await h.message({ type: 'reconnect' });
  assert.equal(result.ok, false);
  assert.match(result.error, /标签页已休眠/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.chrome.tabs.reloads.length, 0);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
});

test('expired legacy incidents and interrupted old HTML recovery migrate into durable holds', async () => {
  const incidents = [
    { state: 'needs-user', notBefore: baseTime - 1, lastStatus: 541 },
    { state: 'cooldown', recoveryPending: true, notBefore: baseTime - 1 },
    { state: 'recovering', lastStatus: 200, recoveryPending: false, reloadedForIncident: true, firstFailureAt: '2026-09-19T12:00:00Z' },
    { state: 'unverified', lastStatus: 200, reloadedForIncident: true, firstFailureAt: '2026-09-19T12:00:00Z' }
  ];
  for (const connectionHealth of incidents) {
    const h = await harness({ data: { monitoring: true, tasks: tasks(), connectionHealth } });
    await h.message({ type: 'scheduler-pulse' });
    assert.equal(h.requests.length, 0);
    assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
    assert.equal(h.data.monitoring, false);
    assert.equal(h.data.monitorState.nextCheck, '');
  }
  const h = await harness({ data: { monitoring: true, tasks: tasks(),
    monitorState: { items: { 'task-0': { httpStatus: 541 } } } } });
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
});

test('a healthy legacy state does not regain a hold from stale incident metadata', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(),
    connectionHealth: { state: 'healthy', lastStatus: 541, firstFailureAt: '2026-09-19T12:00:00Z', reloadedForIncident: true } } });
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.connectionHealth.state, 'healthy');
});

test('unexpired lease survives worker restart and prevents overlapping requests', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(), inflight: { until: baseTime + 60000 },
    monitorState: { checking: true, items: {}, log: [] } } });
  assert.equal((await h.message({ type: 'check-now' })).ok, false);
  assert.equal(h.data.monitorState.checking, false);
  assert.equal(h.requests.length, 0);
  h.advance(60000);
  assert.equal((await h.message({ type: 'check-now' })).ok, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.inflight, null);
});

test('task identity retains notification baseline when same SKU/store is deleted and re-added', async () => {
  const h = await harness();
  await h.message({ type: 'check-now' });
  assert.equal(h.notifications.length, 1);
  await h.message({ type: 'stop-monitor' });
  await h.message({ type: 'save-tasks', tasks: [] });
  const replacement = tasks().map(t => ({ ...t, id: 'new-id' }));
  await h.message({ type: 'save-tasks', tasks: replacement });
  assert.equal(h.data.monitorState.items['new-id'].lastSuccess.status, '有货');
  h.advance(20000);
  await h.message({ type: 'start-monitor', tasks: replacement });
  assert.equal(h.requests.length, 2);
  assert.equal(h.notifications.length, 1);
});

test('10-second boost expires after ten minutes; slower settings never change error backoff', async () => {
  const h = await harness();
  const result = await h.message({ type: 'save-monitor-settings', intervalSeconds: 10, focusSkus: [] });
  assert.equal(result.settings.boostUntil, baseTime + 600000);
  await h.message({ type: 'check-now' });
  h.advance(9999);
  assert.equal((await h.message({ type: 'check-now' })).ok, false);
  h.advance(1);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 2);
  h.advance(590000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.data.skuCooldowns[tasks()[0].product.Code].nextAt, h.now() + 20000);
  assert.equal((await h.message({ type: 'get-monitor-settings' })).settings.boostUntil, 0);
});

test('Bark send can remain pending while the next stock request completes', async () => {
  const gate = deferred();
  const h = await harness({ data: { monitoring: true, tasks: tasks(), barkConfig: { enabled: true, key: TEST_BARK_KEY } }, barkRespond: () => gate.promise });
  assert.equal((await h.message({ type: 'check-now' })).ok, true);
  await until(() => h.barkRequests.length === 1);
  h.advance(20000);
  assert.equal((await h.message({ type: 'check-now' })).ok, true);
  assert.equal(h.requests.length, 2);
  gate.resolve({ ok: true, json: async () => ({ code: 200 }) });
  await until(() => h.data.barkStatus != null);
});

test('diagnostic export excludes cookies, raw error text, response HTML and Bark secret', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(), barkConfig: { key: TEST_BARK_KEY } },
    respond: () => ({ status: 541, responseKind: 'html', responseBytes: 42, body: 'SECRET_HTML', error: 'SECRET_COOKIE' }) });
  await h.message({ type: 'check-now' });
  const result = await h.message({ type: 'export-diagnostics' });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.json, /SECRET_HTML|SECRET_COOKIE|TEST_DEVICE_KEY/);
  const data = JSON.parse(result.json);
  assert.equal(data.diagnostics[0].status, 541);
  assert.equal(data.diagnostics[0].responseKind, 'html');
  assert.equal(data.version, '3.0.0');
});

test('unreleased Duo is shown as not open and never queried before its official opening time', async () => {
  const duo = Object.values(productsData.products).flat().find(p => p.Model === 'iPhone Duo');
  assert.ok(duo?.PreorderAt, 'requires verified Duo catalog');
  const input = [{ ...tasks()[0], product: duo }];
  const h = await harness({ data: { monitoring: true, tasks: input } });
  assert.equal((await h.message({ type: 'check-now' })).ok, true);
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.monitorState.items['task-0'].status, '未开放预订');
  h.advance(Date.parse(duo.PreorderAt) - h.now());
  await h.message({ type: 'check-now' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.monitorState.items['task-0'].status, '有货');
});

test('focused SKU repeats at 20 seconds while other watched SKUs wait 60 seconds', async () => {
  const input = tasks(9), focus = input[0].product.Code;
  const h = await harness({ data: { monitoring: true, tasks: input, monitorSettings: { intervalSeconds: 20, focusSkus: [focus] } } });
  await h.message({ type: 'check-now' });
  assert.equal(h.requests.length, 2);
  h.advance(20000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 3);
  const query = new URL('https://www.apple.com' + h.requests[2].path).searchParams;
  assert.equal(query.get('parts.0'), focus);
  assert.equal(query.has('parts.1'), false);
  assert.equal(h.data.skuCooldowns[input[1].product.Code].nextAt, baseTime + 60000);
});

test('upgrade promotes active legacy failure cooldown to the shared session deadline', async () => {
  const input = tasks(2);
  const h = await harness({ data: { monitoring: true, tasks: input,
    cooldowns: { [input[0].product.Code]: { failures: 2, nextAt: baseTime + 240000 } },
    monitorState: { items: { 'task-0': { status: '需官网验证', httpStatus: 541, lastSuccess: null } } } } });
  assert.equal((await h.message({ type: 'check-now' })).ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.connectionHealth.notBefore, baseTime + 240000);
  assert.equal(h.data.connectionHealth.recoveryPending, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
});

test('pause cancels a start that is still validating its catalog', async () => {
  const gate = deferred();
  let fetching = 0;
  const input = tasks();
  const h = await harness({ data: { monitoring: false, tasks: input }, fetchGate: () => { fetching++; return gate.promise; } });
  const start = h.message({ type: 'start-monitor', tasks: input });
  await until(() => fetching > 0);
  await h.message({ type: 'stop-monitor' });
  gate.resolve();
  await start;
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.monitorState.running, false);
  assert.equal(h.requests.length, 0);
});

test('concurrent starts cannot replace tasks while the first start is validating', async () => {
  const gate = deferred();
  let fetching = 0;
  const input = tasks();
  const h = await harness({ data: { monitoring: false, tasks: input }, fetchGate: () => { fetching++; return gate.promise; } });
  const first = h.message({ type: 'start-monitor', tasks: input });
  await until(() => fetching > 0);
  const second = h.message({ type: 'start-monitor', tasks: tasks(2) });
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.deepEqual(h.data.tasks, input);
  assert.equal(h.requests.length, 1);
});

test('manual validation holds the check lock until its page probe finishes without forcing a reload', async () => {
  const gate = deferred();
  let probing = false;
  const h = await harness({ data: { monitoring: true, tasks: tasks(), ownedMonitorTab: 7 }, pingGate: () => { probing = true; return gate.promise; } });
  const reconnect = h.message({ type: 'reconnect' });
  await until(() => probing);
  const pulse = h.message({ type: 'scheduler-pulse' });
  // Let a racing pulse reach the page if it was not blocked by the validation lock.
  for (let i = 0; i < 10; i++) await immediate();
  assert.equal(h.requests.length, 0);
  gate.resolve();
  assert.equal((await reconnect).ok, true);
  await pulse;
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.connectionHealth.state, 'healthy');
  assert.equal(h.chrome.tabs.reloads.length, 0);
  assert.equal(h.data.monitoring, false);
});

test('pausing a reconnect prevents its follow-up inventory request', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(), ownedMonitorTab: 7 }, tabStatus: 'loading' });
  const reconnect = h.message({ type: 'reconnect' });
  await until(() => h.chrome.tabs.onUpdated.listeners.size > 0);
  await h.message({ type: 'stop-monitor' });
  h.appleTab.status = 'complete';
  await h.chrome.tabs.onUpdated.emit(h.appleTab.id, { status: 'complete' });
  await reconnect;
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.monitorState.running, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.equal(h.data.connectionHealth.state, 'needs-user');
});

test('pausing while the page bridge is being probed prevents a new request', async () => {
  const gate = deferred();
  let probing = false;
  const h = await harness({ pingGate: () => { probing = true; return gate.promise; } });
  const check = h.message({ type: 'check-now' });
  await until(() => probing);
  await h.message({ type: 'stop-monitor' });
  gate.resolve();
  await check;
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.monitorState.running, false);
});

test('a missing MAIN bridge is repaired and reprobed before the only inventory request', async () => {
  let probes = 0;
  const h = await harness({ pingRespond: () => ({ ok: true, bridgeReady: ++probes > 1 }) });
  await h.message({ type: 'check-now' });
  assert.equal(probes, 2);
  assert.equal(h.chrome.scripting.executions.length, 2);
  assert.deepEqual(h.chrome.scripting.executions[0].files, ['page-bridge.js']);
  assert.equal(h.chrome.scripting.executions[0].world, 'MAIN');
  assert.deepEqual(h.chrome.scripting.executions[1].files, ['content.js']);
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.diagnostics.at(-1).stage, 'stock-request');
});

test('an unresponsive MAIN bridge stops before inventory and records a safe failure stage', async () => {
  let probes = 0;
  const h = await harness({ pingRespond: () => { probes++; return { ok: false, bridgeReady: false }; } });
  await h.message({ type: 'check-now' });
  assert.equal(probes, 2);
  assert.equal(h.requests.length, 0);
  assert.equal(h.chrome.scripting.executions.length, 2);
  assert.equal(h.data.diagnostics.at(-1).stage, 'bridge-probe');
  assert.equal(h.data.connectionHealth.state, 'cooldown');
});

test('bridge injection failures stay distinct from website HTTP failures', async () => {
  const h = await harness({ pingRespond: () => ({ ok: false }), injectionError: true });
  await h.message({ type: 'check-now' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.diagnostics.at(-1).stage, 'bridge-injection');
  assert.equal(h.data.diagnostics.at(-1).status, 0);
});

test('worker bounds a probe even when a frozen content listener never responds', async () => {
  const timers = new Map();
  let timerId = 0;
  const h = await harness({ pingRespond: () => new Promise(() => {}),
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  const check = h.message({ type: 'check-now' });
  await until(() => timers.size === 1);
  assert.equal([...timers.values()][0].ms, 2000);
  [...timers.values()][0].fn();
  await until(() => h.chrome.scripting.executions.length === 2 && timerId === 2);
  [...timers.values()][0].fn();
  await check;
  assert.equal(timers.size, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.monitorState.checking, false);
  assert.equal(h.data.diagnostics.at(-1).stage, 'bridge-probe');
});

test('pause during MAIN bridge reinjection prevents the follow-up stock request', async () => {
  const gate = deferred();
  const h = await harness({ pingRespond: () => ({ ok: false }), injectionGate: () => gate.promise });
  const check = h.message({ type: 'check-now' });
  await until(() => h.chrome.scripting.executions.length > 0);
  await h.message({ type: 'stop-monitor' });
  gate.resolve();
  await check;
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.monitorState.running, false);
});

test('pause during the second bridge probe prevents the follow-up stock request', async () => {
  const gate = deferred();
  let probes = 0;
  const h = await harness({ pingRespond: () => ++probes === 1 ? { ok: false } : gate.promise });
  const check = h.message({ type: 'check-now' });
  await until(() => probes === 2);
  await h.message({ type: 'stop-monitor' });
  gate.resolve({ ok: true, bridgeReady: true });
  await check;
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.monitorState.running, false);
});

test('task edits stay exclusive until validation and persistence complete', async () => {
  const gate = deferred();
  let fetching = 0;
  const original = tasks(), replacement = tasks(2);
  const h = await harness({ data: { monitoring: false, tasks: original }, fetchGate: () => { fetching++; return gate.promise; } });
  const save = h.message({ type: 'save-tasks', tasks: replacement });
  await until(() => fetching > 0);
  const start = h.message({ type: 'start-monitor', tasks: original });
  gate.resolve();
  assert.equal((await save).ok, true);
  assert.equal((await start).ok, false);
  assert.deepEqual(h.data.tasks, replacement);
  assert.equal(h.data.monitoring, false);
  assert.equal(h.requests.length, 0);
});

test('starting with a new task id restores its existing stock while cooldown is active', async () => {
  const h = await harness();
  await h.message({ type: 'check-now' });
  await h.message({ type: 'stop-monitor' });
  const replacement = tasks().map(task => ({ ...task, id: 'replacement' }));
  assert.equal((await h.message({ type: 'start-monitor', tasks: replacement })).ok, true);
  assert.deepEqual(Object.keys(h.data.monitorState.items), ['replacement']);
  assert.equal(h.data.monitorState.items.replacement.lastSuccess.status, '有货');
  assert.equal(h.requests.length, 1);
  assert.equal(h.notifications.length, 1);
});


test('desktop preparation without website evidence sends zero requests and no fake inventory rows', async () => {
  let ready = false;
  const h = await harness({ desktop: { prepareStockCheck: async () => ready ? { ready: true } : {
    ready: false, reason: 'website-not-ready', message: '请先完成官网门店查询' } } });
  const initialTasks = clone(h.data.tasks);
  const result = await h.message({ type: 'check-now' });
  assert.equal(result.ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.deepEqual(h.data.tasks, initialTasks);
  assert.deepEqual(h.data.skuCooldowns, {});
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.equal(h.data.connectionHealth.desktopPreparation, true);
  h.advance(3600000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 0);
  ready = true;
  assert.equal((await h.message({ type: 'reconnect' })).recoveryValidated, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, false);
});

test('desktop first validation probes one SKU even when many products are selected', async () => {
  const h = await harness({ data: { tasks: tasks(12), monitoring: false }, desktop: { prepareStockCheck: async () => ({ ready: true }) } });
  await h.message({ type: 'check-now' });
  assert.equal(h.requests.length, 1);
  const url = new URL(h.requests[0].path, 'https://www.apple.com');
  assert.equal(url.searchParams.has('parts.1'), false);
  assert.equal(h.history.length, 1);
  assert.equal(h.data.tasks.length, 12);
});

test('desktop website 541 during preparation is distinct from a failed stock request', async () => {
  const h = await harness({ desktop: { prepareStockCheck: async () => ({ ready: false, reason: 'website-blocked', status: 541,
    message: '官网自己的门店接口返回 HTTP 541，程序未追加库存请求。' }) } });
  assert.equal((await h.message({ type: 'check-now' })).ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.connectionHealth.preparationReason, 'website-blocked');
  assert.match(h.data.connectionHealth.message, /官网自己的/);
});

test('desktop first inventory 541 is held and diagnosed without claiming a successful connection', async () => {
  const h = await harness({ desktop: { prepareStockCheck: async () => ({ ready: true }) },
    respond: async () => ({ status: 541, responseKind: 'html' }) });
  await h.message({ type: 'check-now' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.match(h.data.connectionHealth.message, /首次库存查询/);
  await h.message({ type: 'check-now' });
  h.advance(7200000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 1);
});

test('desktop preparation exception pauses before any query and keeps history unchanged', async () => {
  const h = await harness({ desktop: { prepareStockCheck: async () => { throw new Error('window unavailable'); } } });
  assert.equal((await h.message({ type: 'check-now' })).ok, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.monitoring, false);
  assert.match(h.data.connectionHealth.message, /未发送库存查询/);
});

test('pause while desktop preparation is pending cannot issue a late query', async () => {
  const gate = deferred(); let started = false;
  const h = await harness({ desktop: { prepareStockCheck: async () => { started = true; return gate.promise; } } });
  const check = h.message({ type: 'check-now' });
  await until(() => started);
  await h.message({ type: 'stop-monitor' });
  gate.resolve({ ready: true });
  await check;
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.inflight, null);
});

test('desktop gate closure at dispatch is not recorded as an HTTP error', async () => {
  const h = await harness({ desktop: { prepareStockCheck: async () => ({ ready: true }) },
    respond: async () => ({ status: 0, preparation: { reason: 'page-loading', message: '页面重新加载，未发送查询' } }) });
  assert.equal((await h.message({ type: 'check-now' })).ok, false);
  assert.equal(h.history.length, 0);
  assert.equal(h.data.connectionHealth.desktopPreparation, true);
});

test('20-second cadence drains the shared budget, then slows to one request per minute', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(), monitorSettings: { intervalSeconds: 20, focusSkus: [] } } });
  for (let i = 0; i < 90; i++) { await h.message({ type: 'scheduler-pulse' }); h.advance(20000); }
  // 30 minutes at 20 seconds would be 90 requests; the bucket allows 20 plus ~1 per minute.
  assert.ok(h.requests.length >= 48 && h.requests.length <= 51, 'requests: ' + h.requests.length);
  const late = h.requests.slice(-8).map(r => r.at);
  for (let i = 1; i < late.length; i++) assert.ok(late[i] - late[i - 1] >= 60000);
  const manual = await h.message({ type: 'check-now' });
  if (manual.ok === false) assert.match(manual.error, /连续查询上限/);
  assert.ok(h.data.monitorState.budgetWaitUntil === '' || Date.parse(h.data.monitorState.budgetWaitUntil) > h.now() - 60000);
});

test('exhausted budget blocks manual checks and validation across a worker restart', async () => {
  const first = await harness({ data: { monitoring: false, tasks: tasks(), requestBudget: { tokens: 0, updatedAt: baseTime } } });
  const manual = await first.message({ type: 'check-now' });
  assert.equal(manual.ok, false);
  assert.match(manual.error, /连续查询上限.*60 秒/);
  assert.equal(first.requests.length, 0);
  const second = await harness({ data: first.data, history: first.history, now: first.now() + 30000 });
  assert.match((await second.message({ type: 'reconnect' })).error, /连续查询上限/);
  second.advance(30000);
  assert.equal((await second.message({ type: 'check-now' })).ok, true);
  assert.equal(second.requests.length, 1);
  assert.ok(second.data.requestBudget.tokens < 1);
});

test('a second batch waits for budget instead of being sent back to back', async () => {
  const h = await harness({ data: { monitoring: true, tasks: tasks(12), requestBudget: { tokens: 1, updatedAt: baseTime } } });
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 1);
  h.advance(30000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 1);
  h.advance(30000);
  await h.message({ type: 'scheduler-pulse' });
  assert.equal(h.requests.length, 2);
  const parts = request => [...new URL(request.path, 'https://www.apple.com').searchParams].filter(([key]) => key.startsWith('parts.')).map(([, code]) => code);
  // The batch that was starved of budget goes first, so every SKU is covered within two requests.
  assert.equal(new Set([...parts(h.requests[0]), ...parts(h.requests[1])]).size, 12);
});

test('desktop preparation that sends nothing does not spend the request budget', async () => {
  const h = await harness({ data: { monitoring: false, tasks: tasks(), requestBudget: { tokens: 5, updatedAt: baseTime } },
    desktop: { prepareStockCheck: async () => ({ ready: false, reason: 'website-not-ready', message: '请先完成官网门店查询' }) } });
  assert.equal((await h.message({ type: 'check-now' })).ok, false);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.data.requestBudget, { tokens: 5, updatedAt: baseTime });
});

test('Apple session reset is desktop-only, requires a pause, and keeps tasks, history and budget', async () => {
  const plain = await harness({ data: { monitoring: false, tasks: tasks() } });
  assert.match((await plain.message({ type: 'reset-apple-session' })).error, /仅 Windows 桌面版/);

  let resets = 0;
  const desktop = { prepareStockCheck: async () => ({ ready: true }), resetAppleSession: async () => { resets++; return { ok: true }; } };
  const h = await harness({ data: { monitoring: true, tasks: tasks(3), ownedMonitorTab: 7 }, desktop });
  await h.message({ type: 'check-now' });
  assert.equal(h.data.connectionHealth.state, 'healthy');
  assert.match((await h.message({ type: 'reset-apple-session' })).error, /先暂停监控/);
  assert.equal(resets, 0);
  await h.message({ type: 'stop-monitor' });
  const historyBefore = clone(h.history), tasksBefore = clone(h.data.tasks), budgetBefore = clone(h.data.requestBudget);
  const result = await h.message({ type: 'reset-apple-session' });
  assert.equal(result.ok, true);
  assert.equal(resets, 1);
  assert.deepEqual(h.history, historyBefore);
  assert.deepEqual(h.data.tasks, tasksBefore);
  assert.deepEqual(h.data.requestBudget, budgetBefore);
  assert.equal(h.data.ownedMonitorTab, null);
  assert.equal(h.data.monitoring, false);
  assert.equal(h.data.connectionHealth.manualRecoveryRequired, true);
  assert.equal(h.data.connectionHealth.preparationReason, 'session-reset');
  assert.equal(h.data.connectionHealth.lastSuccessAt, undefined);
  assert.match((await h.message({ type: 'start-monitor', tasks: tasksBefore })).error, /官网会话已重置/);
  // The next validation is the single-SKU first-connection probe.
  h.advance(60000);
  const before = h.requests.length;
  assert.equal((await h.message({ type: 'reconnect' })).recoveryValidated, true);
  assert.equal(h.requests.length, before + 1);
  assert.equal(new URL(h.requests.at(-1).path, 'https://www.apple.com').searchParams.has('parts.1'), false);
});
