// DOM integration only: real app.html/app.js and preview adapter, with local-file
// fetches. jsdom is not a browser; these tests do not cover Chrome installation,
// layout, Apple sessions, notifications, or purchases. No network is permitted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as immediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
const { JSDOM, VirtualConsole } = await import(process.env.TEST_JSDOM_MODULE || 'jsdom');

const root = new URL('../', import.meta.url);
const sourceURL = new URL('./app.js', import.meta.url);
const html = await readFile(new URL('./app.html', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate, message = 'expected UI to settle') {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail(message);
}

async function harness(t, options = {}) {
  const errors = [], requests = [], fetches = [], intervals = [], downloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/extension/app.html?preview=1',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  t.after(() => { dom.window.close(); assert.deepEqual(errors, [], 'DOM event errors'); });
  const { window } = dom;
  window.structuredClone = clone;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.setInterval = fn => { intervals.push(fn); return intervals.length; };
  window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:local-test'; };
  window.URL.revokeObjectURL = () => {};
  const anchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    if (this.download) downloads.push({ filename: this.download });
    else anchorClick.call(this);
  };
  window.fetch = async input => {
    const url = new URL(String(input));
    const path = url.pathname;
    assert.equal(url.origin, 'http://127.0.0.1:8765', 'no external network permitted');
    assert.match(path, /^\/extension\/data\/(products\/product_data_hk|stores\/store_hk)\.json$/);
    fetches.push(path);
    const data = JSON.parse(await readFile(new URL(path.slice(1), root), 'utf8'));
    return { ok: true, json: async () => clone(data) };
  };
  const context = dom.getInternalVMContext();
  const modules = new Map();
  let override;
  async function load(url) {
    if (modules.has(url.href)) return modules.get(url.href);
    const source = await readFile(url, 'utf8');
    const mod = new vm.SourceTextModule(source, {
      context, identifier: url.href,
      initializeImportMeta(meta) {
        meta.url = 'http://127.0.0.1:8765/' + url.href.slice(root.href.length);
      },
      async importModuleDynamically(specifier, parent) {
        const child = await load(new URL(specifier, parent.identifier));
        await child.evaluate();
        const send = window.chrome.runtime.sendMessage.bind(window.chrome.runtime);
        window.chrome.runtime.sendMessage = async message => {
          requests.push(clone(message));
          const result = override ? await override(message, send) : await send(message);
          return clone(result);
        };
        await options.prepare?.(window.chrome);
        return child;
      }
    });
    modules.set(url.href, mod);
    await mod.link((specifier, parent) => load(new URL(specifier, parent.identifier)));
    return mod;
  }
  const app = await load(sourceURL);
  await app.evaluate();
  const $ = id => window.document.getElementById(id);
  await until(() => !$('purchase-save').disabled && !$('monitor-settings-save').disabled && $('history-page').textContent !== '正在读取…', 'full app initialization');
  const change = (id, value, event = 'change') => {
    const element = $(id);
    if (typeof value === 'boolean') element.checked = value; else element.value = value;
    element.dispatchEvent(new window.Event(event, { bubbles: true }));
  };
  return {
    window, $, change, requests, fetches, intervals, downloads,
    intercept(fn) { override = fn; },
    state: keys => window.chrome.storage.local.get(keys),
    update: values => window.chrome.storage.local.set(values),
    send: message => window.chrome.runtime.sendMessage(message),
    click: id => $(id).click(),
    unsaved() {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }
  };
}

test('full app initializes real HTML, local catalog, demo task groups and controls', async t => {
  const ui = await harness(t);
  assert.equal(ui.$('preview-notice').hidden, false);
  assert.equal(ui.$('desktop-toolbar').hidden, true, 'desktop controls stay hidden without the desktop bridge');
  assert.equal(ui.$('form-message').textContent, '');
  assert.equal(ui.$('add').disabled, false);
  assert.equal(ui.$('start').disabled, false);
  assert.equal(ui.$('stop').disabled, true);
  assert.equal(ui.$('summary-products').textContent, '2');
  assert.equal(ui.$('summary-tasks').textContent, '7');
  assert.equal(ui.$('summary-available').textContent, '2');
  assert.equal(ui.$('tasks').querySelectorAll('.product-group').length, 2);
  assert.equal(ui.$('tasks').querySelectorAll('.task').length, 7);
  assert.match(ui.$('selected-product').textContent, /512GB.*冰川色/s);
  assert.equal(ui.fetches.length, 4);
  assert.equal(ui.unsaved(), false);
});

test('desktop toolbar shows its data location and opens only explicit shell actions', async t => {
  const calls = [];
  const ui = await harness(t, { prepare(chrome) {
    chrome.desktop = {
      getInfo: async () => ({ version: '4.0.1', dataPath: 'D:\\StoreWatch\\Data', platform: 'win32', packaged: true }),
      openApple: async () => { calls.push('apple'); },
      openDataFolder: async () => { calls.push('data'); },
      backupData: async () => { calls.push('backup'); return { path: 'D:\\Exports\\backup' }; }
    };
  } });
  assert.equal(ui.$('desktop-toolbar').hidden, false);
  assert.match(ui.$('desktop-status').textContent, /4\.0\.1/);
  assert.equal(ui.$('desktop-data-path').title, 'D:\\StoreWatch\\Data');
  assert.match(ui.$('visibility-badge').textContent, /后台独立调度/);
  assert.deepEqual(calls, [], 'opening the dashboard does not open Apple or export data');
  ui.click('desktop-open-apple');
  await until(() => !ui.$('desktop-open-apple').disabled);
  assert.match(ui.$('desktop-message').textContent, /程序内的 Apple 官网窗口/);
  ui.click('desktop-open-data');
  await until(() => !ui.$('desktop-open-data').disabled);
  ui.click('desktop-backup');
  await until(() => !ui.$('desktop-backup').disabled);
  assert.deepEqual(calls, ['apple', 'data', 'backup']);
  assert.match(ui.$('desktop-message').textContent, /D:\\Exports\\backup/);
  assert.match(ui.$('desktop-message').textContent, /不含 Apple 登录会话和 Bark 密钥/);
  assert.equal(ui.requests.some(message => ['start-monitor', 'check-now', 'reconnect'].includes(message.type)), false);
});

test('desktop backup is unavailable during monitoring or a check, and reports cancellation and failure', async t => {
  let backupCalls = 0;
  const pending = deferred();
  const ui = await harness(t, { prepare(chrome) {
    chrome.desktop = {
      getInfo: async () => ({ version: '4.0.1' }),
      openApple: async () => {}, openDataFolder: async () => {},
      backupData: async () => {
        backupCalls++;
        if (backupCalls === 1) return pending.promise;
        throw new Error('磁盘写入失败');
      }
    };
  } });
  await ui.update({ monitoring: true });
  ui.click('desktop-backup');
  assert.equal(ui.$('desktop-backup').disabled, true);
  await ui.update({ monitoring: false, monitorState: { checking: true } });
  ui.click('desktop-backup');
  assert.equal(ui.$('desktop-backup').disabled, true);
  assert.equal(backupCalls, 0);
  await ui.update({ monitorState: { checking: false } });
  ui.click('desktop-backup'); ui.click('desktop-backup');
  assert.equal(backupCalls, 1);
  assert.equal(ui.$('desktop-open-apple').disabled, true);
  pending.resolve({ cancelled: true });
  await until(() => !ui.$('desktop-backup').disabled);
  assert.equal(ui.$('desktop-message').textContent, '已取消备份。');
  ui.click('desktop-backup');
  await until(() => !ui.$('desktop-backup').disabled);
  assert.match(ui.$('desktop-message').textContent, /磁盘写入失败/);
  assert.equal(ui.$('desktop-message').classList.contains('error-text'), true);
});

test('desktop monitoring does not depend on dashboard visibility or send extra scheduler pulses', async t => {
  const ui = await harness(t, { prepare(chrome) {
    chrome.desktop = {
      getInfo: async () => ({ version: '4.0.1' }),
      openApple: async () => {}, openDataFolder: async () => {}, backupData: async () => ({ cancelled: true })
    };
  } });
  await ui.update({ monitoring: true, monitorSettings: { intervalSeconds: 60, focusSkus: [] } });
  for (const visibility of ['visible', 'hidden']) {
    Object.defineProperty(ui.window.document, 'visibilityState', { configurable: true, value: visibility });
    ui.intervals.forEach(callback => callback());
  }
  await immediate();
  assert.equal(ui.requests.filter(message => message.type === 'scheduler-pulse').length, 0);
  assert.match(ui.$('schedule-summary').textContent, /最小化到托盘后仍会继续检查/);
  assert.doesNotMatch(ui.$('schedule-summary').textContent, /Chrome|至少间隔 30 秒/);
  assert.equal(ui.$('visibility-badge').textContent, '后台独立调度');
});

test('all four navigation buttons and invalid hash update panels and aria-current', async t => {
  const ui = await harness(t);
  for (const view of ['history', 'settings', 'purchase', 'overview']) {
    ui.window.document.querySelector(`[data-view="${view}"]`).click();
    await until(() => ui.window.document.querySelector(`[data-view="${view}"]`).getAttribute('aria-current') === 'page');
    for (const panel of ui.window.document.querySelectorAll('[data-panel]')) {
      if (panel.id !== 'attention-banner') assert.equal(panel.hidden, panel.dataset.panel !== view);
    }
    assert.equal(ui.window.document.querySelectorAll('[aria-current="page"]').length, 1);
  }
  ui.window.location.hash = 'unknown-page';
  await until(() => ui.$('view-title').textContent === '监控概览');
  ui.window.document.querySelector('.skip-link').click();
  assert.equal(ui.window.document.activeElement, ui.$('main-content'));
});

test('real input handlers combine search/status, render empty matches and clear filters', async t => {
  const ui = await harness(t);
  ui.change('task-filter', 'available');
  assert.equal(ui.$('tasks').querySelectorAll('.task').length, 2);
  ui.change('task-search', 'NO SUCH STORE', 'input');
  assert.equal(ui.$('no-matches').hidden, false);
  assert.equal(ui.$('empty-tasks').hidden, true);
  ui.click('clear-filters');
  assert.equal(ui.$('tasks').querySelectorAll('.task').length, 7);
  assert.equal(ui.$('no-matches').hidden, true);
  assert.equal(ui.window.document.activeElement, ui.$('task-search'));
});

test('monitor settings draft survives storage changes and is sent only on save', async t => {
  const ui = await harness(t);
  ui.change('monitor-interval', '60');
  ui.$('focus-skus').querySelector('input').click();
  const selected = ui.$('focus-skus').querySelector('input').value;
  await ui.update({ monitorSettings: { intervalSeconds: 20, focusSkus: [] } });
  assert.equal(ui.$('monitor-interval').value, '60');
  assert.equal(ui.$('focus-skus').querySelector('input').checked, true);
  assert.equal(ui.unsaved(), true);
  assert.equal(ui.requests.some(item => item.type === 'save-monitor-settings'), false);
  ui.click('monitor-settings-save');
  await until(() => ui.$('monitor-settings-message').textContent === '检查设置已保存。');
  assert.deepEqual(ui.requests.find(item => item.type === 'save-monitor-settings'), { type: 'save-monitor-settings', intervalSeconds: 60, focusSkus: [selected] });
  assert.equal(ui.unsaved(), false);
});

test('purchase draft survives unrelated render and remote settings refresh, failed save keeps it', async t => {
  const ui = await harness(t);
  const sku = ui.$('purchase-sku').options[1].value;
  ui.change('purchase-sku', sku);
  ui.change('purchase-enabled', true);
  ui.change('purchase-max-price', '19999', 'input');
  ui.$('purchase-stores').querySelector('input').click();
  await ui.update({ purchaseSettings: { enabled: false, sku: '', maxPrice: 0, quantity: 1, storePriority: [] }, connectionHealth: { state: 'healthy' } });
  assert.equal(ui.$('purchase-sku').value, sku);
  assert.equal(ui.$('purchase-max-price').value, '19999');
  assert.equal(ui.$('purchase-enabled').checked, true);
  assert.equal(ui.$('purchase-stores').querySelector('input').checked, true);
  assert.equal(ui.$('purchase-reset').disabled, true);
  ui.click('purchase-save');
  await until(() => ui.$('purchase-message').textContent.includes('演示模式不保存'));
  assert.equal(ui.$('purchase-max-price').value, '19999');
  assert.equal(ui.unsaved(), true);
  assert.equal((await ui.state(['purchaseSettings'])).purchaseSettings.enabled, false);
});

test('Bark draft survives status refresh and preview refuses secrets and notification sending', async t => {
  const ui = await harness(t);
  ui.change('bark-enabled', true);
  ui.change('bark-url', 'TEST_ONLY_NOT_A_DEVICE_KEY', 'input');
  await ui.update({ barkStatus: { ok: false, at: new Date().toISOString(), message: '模拟错误' }, barkConfig: { enabled: false } });
  await immediate();
  assert.equal(ui.$('bark-enabled').checked, true);
  assert.equal(ui.$('bark-url').value, 'TEST_ONLY_NOT_A_DEVICE_KEY');
  assert.equal(ui.$('bark-test').disabled, true);
  ui.click('bark-save');
  await until(() => ui.$('bark-message').textContent.includes('演示模式不保存设备密钥'));
  assert.equal(ui.unsaved(), true);
  assert.equal((await ui.send({ type: 'get-bark-settings' })).configured, false);
  assert.equal((await ui.send({ type: 'test-bark' })).ok, false);
});

test('pause remains usable during pending start and stale reply does not restart monitoring', async t => {
  const ui = await harness(t);
  const pending = deferred();
  ui.intercept(async (message, send) => {
    const result = await send(message);
    return message.type === 'start-monitor' ? pending.promise : result;
  });
  ui.click('start');
  await until(() => ui.$('monitor-badge').textContent === '监控中');
  assert.equal(ui.$('stop').disabled, false);
  assert.equal(ui.$('add').disabled, true);
  ui.click('stop');
  await until(() => ui.$('monitor-badge').textContent === '已暂停');
  pending.resolve({ ok: true });
  await until(() => !ui.$('add').disabled);
  assert.equal((await ui.state(['monitoring'])).monitoring, false);
  assert.match(ui.$('global-message').textContent, /自动监控已暂停/);
});

test('connection failures block checks and update attention banner while pause remains available', async t => {
  const ui = await harness(t);
  await ui.update({ monitoring: true, connectionHealth: { state: 'needs-user', message: '模拟需要验证' } });
  assert.equal(ui.$('check').disabled, true);
  assert.equal(ui.$('stop').disabled, false);
  assert.equal(ui.$('attention-banner').hidden, false);
  assert.match(ui.$('attention-description').textContent, /模拟需要验证/);
  ui.click('show-connection');
  assert.equal(ui.window.document.activeElement, ui.$('reconnect'));
  ui.click('reconnect');
  await until(() => ui.$('connection-action-message').textContent === '演示模式未发起官网连接。');
  assert.equal(ui.$('attention-banner').hidden, true);
});

test('persistent protection blocks start/check and scheduling pulses after cooldown expires', async t => {
  const ui = await harness(t);
  const health = { state: 'needs-user', manualRecoveryRequired: true, lastStatus: 541,
    message: 'HTTP 541：监控已暂停', notBefore: Date.now() + 120000 };
  await ui.update({ monitoring: false, connectionHealth: health });
  assert.equal(ui.$('monitor-badge').textContent, '保护性暂停');
  assert.equal(ui.$('start').disabled, true);
  assert.equal(ui.$('check').disabled, true);
  assert.equal(ui.$('reconnect').disabled, true);
  assert.match(ui.$('connection-timing').textContent, /最早可手动验证/);
  assert.match(ui.$('connection-timing').textContent, /不会自动重试或刷新官网/);
  assert.match(ui.$('attention-title').textContent, /保护性暂停/);
  await ui.update({ monitoring: true, connectionHealth: { ...health, state: 'unverified', notBefore: Date.now() - 86400000 } });
  const before = ui.requests.length;
  for (let tick = 0; tick < 120; tick++) ui.intervals.forEach(callback => callback());
  ui.click('check'); ui.click('start');
  await immediate();
  assert.equal(ui.requests.length, before, 'held UI must not send scheduler/check/start messages');
  assert.equal(ui.$('reconnect').disabled, false);
  assert.equal(ui.$('check').disabled, true);
  assert.match(ui.$('next-check').textContent, /自动查询已暂停/);
});

test('manual validation errors remain visible and successful validation requires explicit start', async t => {
  const ui = await harness(t);
  const health = { state: 'needs-user', manualRecoveryRequired: true, notBefore: 0, message: 'HTTP 541：监控已暂停' };
  await ui.update({ monitoring: false, connectionHealth: health });
  ui.intercept(async (message, send) => message.type === 'reconnect'
    ? { ok: false, error: '官网尚未恢复，继续保持暂停' } : send(message));
  ui.click('reconnect');
  await until(() => ui.$('connection-action-message').textContent.includes('官网尚未恢复'));
  assert.equal(ui.$('start').disabled, true);
  assert.equal(ui.$('check').disabled, true);
  ui.intercept(async (message, send) => {
    if (message.type !== 'reconnect') return send(message);
    await ui.update({ monitoring: false, connectionHealth: { state: 'healthy', manualRecoveryRequired: false, message: '有效库存响应' } });
    return { ok: true, message: '验证通过，仍保持暂停；可手动开始监控' };
  });
  await until(() => !ui.$('reconnect').disabled);
  ui.click('reconnect');
  await until(() => ui.$('connection-action-message').textContent.includes('验证通过'));
  ui.intervals.forEach(callback => callback());
  assert.equal((await ui.state(['monitoring'])).monitoring, false);
  assert.equal(ui.$('monitor-badge').textContent, '已暂停');
  assert.equal(ui.$('start').disabled, false);
  assert.equal(ui.requests.filter(item => item.type === 'reconnect').length, 2);
  assert.equal(ui.requests.filter(item => ['start-monitor', 'scheduler-pulse'].includes(item.type)).length, 0);
});

test('history mode changes ignore stale responses, preserve failure detail and export current mode', async t => {
  const ui = await harness(t);
  const oldPage = deferred();
  ui.intercept(async (message, send) => {
    if (message.type === 'get-history' && message.mode === 'changes') return oldPage.promise;
    return send(message);
  });
  ui.click('history-changes');
  ui.click('history-all');
  await until(() => ui.$('history-page').textContent.includes('共 7 条'));
  oldPage.resolve({ ok: true, total: 0, items: [] });
  await immediate();
  assert.equal(ui.$('history-body').querySelectorAll('tr').length, 7);
  assert.equal(ui.$('history-all').getAttribute('aria-pressed'), 'true');
  await ui.update({ monitorState: { historyError: '模拟磁盘写入失败' } });
  assert.equal(ui.$('history-error').hidden, false);
  assert.match(ui.$('history-error').textContent, /模拟磁盘写入失败/);
  ui.click('history-export');
  await until(() => ui.downloads.length === 2);
  assert.match(ui.downloads[1].filename, /全部检查.*\.csv$/);
  assert.equal(ui.requests.find(item => item.type === 'export-history').mode, 'all');
});

test('preview history respects pagination contract', async t => {
  const ui = await harness(t);
  const all = await ui.send({ type: 'get-history', mode: 'all', offset: 0, limit: 50 });
  const page = await ui.send({ type: 'get-history', mode: 'all', offset: 2, limit: 2 });
  assert.equal(page.total, all.total);
  assert.deepEqual(page.items, all.items.slice(2, 4));
  assert.deepEqual((await ui.send({ type: 'get-history', mode: 'all', offset: 100, limit: 50 })).items, []);
});

test('failed history filter load cannot leave rows/counts from the previous filter', async t => {
  const ui = await harness(t);
  ui.intercept(async (message, send) => message.type === 'get-history'
    ? { ok: false, error: '模拟历史读取失败' } : send(message));
  ui.click('history-changes');
  await until(() => ui.$('history-message').textContent.includes('模拟历史读取失败'));
  assert.equal(ui.$('history-body').querySelectorAll('.history-product').length, 0);
  assert.equal(ui.$('history-page').textContent, '读取失败');
  assert.equal(ui.$('history-prev').disabled, true);
  assert.equal(ui.$('history-next').disabled, true);
  ui.intercept(undefined);
  ui.click('history-changes');
  await until(() => ui.$('history-page').textContent === '共 0 条');
  assert.match(ui.$('history-body').textContent, /还没有确认的库存变化/);
});

test('DOM first-install empty storage supports adding all six stores and removing back to empty', async t => {
  const ui = await harness(t, { prepare: chrome => chrome.storage.local.set({
    tasks: [], monitorState: {}, monitoring: false, uiSelection: undefined
  }) });
  assert.equal(ui.$('empty-tasks').hidden, false);
  assert.equal(ui.$('summary-products').textContent, '0');
  assert.equal(ui.$('summary-tasks').textContent, '0');
  assert.equal(ui.$('start').disabled, true);
  assert.equal(ui.$('check').disabled, true);
  assert.equal(ui.$('add').disabled, false);
  ui.click('add');
  await until(() => ui.$('tasks').querySelectorAll('.task').length === 6 && !ui.$('add').disabled);
  assert.equal(ui.$('empty-tasks').hidden, true);
  assert.equal(ui.$('summary-products').textContent, '1');
  assert.equal(ui.$('start').disabled, false);
  assert.equal(ui.$('check').disabled, false);
  assert.equal((await ui.state(['tasks'])).tasks.length, 6);
  ui.click('add');
  await until(() => ui.$('form-message').textContent.includes('已经全部在监控列表'));
  assert.equal((await ui.state(['tasks'])).tasks.length, 6);
  for (let remaining = 5; remaining >= 0; remaining--) {
    await until(() => !ui.$('tasks').querySelector('.remove-button').disabled);
    ui.$('tasks').querySelector('.remove-button').click();
    await until(() => ui.$('tasks').querySelectorAll('.task').length === remaining);
  }
  assert.equal(ui.$('empty-tasks').hidden, false);
  assert.equal(ui.$('start').disabled, true);
  assert.equal(ui.$('check').disabled, true);
  assert.equal(ui.$('no-matches').hidden, true);
  assert.equal((await ui.state(['tasks'])).tasks.length, 0);
});
