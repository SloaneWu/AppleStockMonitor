'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../desktop/preload.cjs'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function load(href = 'stockapp://local/app.html') {
  const handlers = new Map(), calls = [], sent = [], exposed = {};
  const ipcRenderer = {
    on(channel, listener) { handlers.set(channel, listener); },
    invoke(channel, payload) { calls.push({ channel, ...plain(payload) }); return Promise.resolve({ ok: true }); },
    send(channel, payload) { sent.push({ channel, ...(payload === undefined ? {} : plain(payload)) }); }
  };
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron', 'Sandbox preload imports only Electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } } };
    },
    URL, location: { href }
  });
  return { api: exposed.desktopChrome, handlers, calls, sent,
    emit(channel, payload) { handlers.get(channel)?.({ sender: 'must never reach page code' }, payload); }
  };
}

test('trusted dashboard exposes fixed methods and keeps raw Electron private', async () => {
  const { api, calls } = load();
  assert.equal(api.runtime.id, 'apple-stock-monitor-desktop');
  assert.equal(api.runtime.getManifest().version, '4.0.1');
  assert.equal(api.runtime.getURL(''), 'stockapp://local/');
  assert.equal(api.runtime.getURL('/data/stores/store_hk.json'), 'stockapp://local/data/stores/store_hk.json');
  await api.storage.local.get(['tasks']);
  await api.runtime.sendMessage({ type: 'pause-monitor' });
  await api.desktop.getInfo();
  assert.deepEqual(calls, [
    { channel: 'desktop:call', method: 'storage.local.get', args: [['tasks']] },
    { channel: 'desktop:call', method: 'runtime.sendMessage', args: [{ type: 'pause-monitor' }] },
    { channel: 'desktop:call', method: 'desktop.getInfo', args: [] }
  ]);
  assert.equal(api.ipcRenderer, undefined);
  assert.equal(api.invoke, undefined);
  assert.equal(api.desktop.engineReady, undefined);
});

test('untrusted or unrelated local documents receive no bridge or IPC listeners', () => {
  for (const url of ['https://www.apple.com/hk/shop/', 'stockapp://other/app.html',
    'stockapp://user@local/app.html', 'stockapp://local/other.html', 'file:///app.html', 'about:blank']) {
    const state = load(url);
    assert.equal(state.api, undefined, url);
    assert.equal(state.handlers.size, 0, url);
  }
});

test('resource URL helper rejects external and traversal paths', () => {
  const { api } = load();
  for (const value of ['https://example.org/', '../desktop/main.cjs', 'data/../main.cjs', 'data\\secret']) {
    assert.throws(() => api.runtime.getURL(value), /无效应用资源路径/);
  }
});

test('event subscription forwards only payload args and honors removal', () => {
  const state = load();
  const received = [], callback = (...args) => received.push(args);
  const event = state.api.storage.onChanged;
  event.addListener(callback);
  event.addListener(callback);
  assert.equal(event.hasListeners(), true);
  assert.equal(event.hasListener(callback), true);
  state.emit('desktop:event', { name: 'storage.onChanged', args: [{ monitoring: { newValue: false } }, 'local'] });
  assert.deepEqual(received, [[{ monitoring: { newValue: false } }, 'local']]);
  event.removeListener(callback);
  state.emit('desktop:event', { name: 'storage.onChanged', args: [{}, 'local'] });
  assert.equal(received.length, 1);
  assert.equal(event.hasListeners(), false);
  state.emit('desktop:event', { name: 'unregistered', args: [] });
  state.emit('desktop:event', { name: 'storage.onChanged', args: {} });
  assert.throws(() => event.addListener(null), /事件处理器/);
});

test('engine routes asynchronous sendResponse once without exposing the IPC event', async () => {
  const state = load('stockapp://local/engine.html');
  const sender = { id: state.api.runtime.id, url: 'stockapp://local/app.html' };
  state.api.runtime.onMessage.addListener((message, actualSender, reply) => {
    assert.deepEqual(message, { type: 'get-monitor-settings' });
    assert.deepEqual(actualSender, sender);
    Promise.resolve().then(() => { reply({ ok: true, value: 60 }); reply({ ok: false }); });
    return true;
  });
  state.emit('desktop:runtime-message', { id: 'request-1', message: { type: 'get-monitor-settings' }, sender });
  assert.equal(state.sent.length, 0);
  await Promise.resolve();
  assert.deepEqual(state.sent, [{ channel: 'desktop:runtime-response', id: 'request-1', result: { ok: true, value: 60 } }]);
  state.api.desktop.engineReady();
  assert.deepEqual(state.sent.at(-1), { channel: 'desktop:engine-ready' });
  assert.equal(state.api.desktop.openApple, undefined);
});

test('engine returns bounded errors when a message cannot be handled', () => {
  const state = load('stockapp://local/engine.html');
  state.emit('desktop:runtime-message', { id: 'missing', message: {}, sender: {} });
  assert.equal(state.sent[0].result.ok, false);
  state.api.runtime.onMessage.addListener(() => { throw new Error('secret diagnostic details'); });
  state.emit('desktop:runtime-message', { id: 'throws', message: {}, sender: {} });
  assert.equal(state.sent[1].result.ok, false);
  assert.doesNotMatch(state.sent[1].result.error, /secret/);
  state.emit('desktop:runtime-message', { message: {}, sender: {} });
  assert.equal(state.sent.length, 2);
});

test('dashboard cannot receive worker messages through its bridge', () => {
  const state = load();
  let seen = false;
  state.api.runtime.onMessage.addListener(() => { seen = true; });
  state.emit('desktop:runtime-message', { id: 'ignored', message: {}, sender: {} });
  assert.equal(seen, false);
  assert.equal(state.sent.length, 0);
});

test('promise-returning engine listener settles a response and can be removed', async () => {
  const state = load('stockapp://local/engine.html');
  const callback = async () => ({ ok: true });
  const event = state.api.runtime.onMessage;
  event.addListener(callback);
  assert.equal(event.hasListener(callback), true);
  state.emit('desktop:runtime-message', { id: 12, message: {}, sender: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.sent, [{ channel: 'desktop:runtime-response', id: 12, result: { ok: true } }]);
  event.removeListener(callback);
  assert.equal(event.hasListeners(), false);
});
