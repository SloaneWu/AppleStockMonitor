import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseManager } from './purchase.js';
const product = { Code: 'MJXW4ZA/A', Model: 'iPhone 18 Pro Max', Capacity: '512GB', Color: '冰川色', Price: 13299 };
const settings = { enabled: true, sku: product.Code, maxPrice: 14000, quantity: 1, storePriority: ['R428', 'R409'] };
const tasks = ['R409', 'R428'].map(id => ({ areaCode: 'hk', product, store: { StoreNumber: id, StoreName: id } }));
const clone = value => structuredClone(value);
function harness(options = {}) {
  const data = options.data || { purchaseSettings: clone(settings) }, tabs = [], messages = [], events = [], listeners = new Set();
  let clicked = false;
  const api = {
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])])); },
      async set(values) { Object.assign(data, clone(values)); }
    } },
    tabs: {
      onUpdated: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
      async create(input) { const tab = { ...input, id: tabs.length + 10, status: 'complete' }; tabs.push(tab); return clone(tab); },
      async get(id) { return clone(tabs.find(t => t.id === id)); },
      async update(id, input) { Object.assign(tabs.find(t => t.id === id), input); return this.get(id); },
      async sendMessage(id, input) {
        messages.push(clone(input));
        if (options.onMessage) await options.onMessage(input, manager);
        if (input.type === 'purchase-inspect-bag') {
          if (!clicked) return options.before || { kind: 'bag', verified: true, empty: true, items: [] };
          return options.after || { kind: 'bag', verified: true, items: [{ sku: product.Code, quantity: 1, currency: 'HKD', price: 13299 }] };
        }
        if (input.type === 'purchase-inspect-product') return options.snapshot || { kind: 'product', verified: true, sku: product.Code, quantity: 1, currency: 'HKD', price: 13299, addAvailable: true };
        if (input.type === 'purchase-add-once') {
          assert.equal(clicked, false, 'must not click twice');
          clicked = true;
          if (options.clickError) throw new Error(options.clickError);
          queueMicrotask(() => { for (const listener of listeners) listener(id, { status: 'loading' }); for (const listener of [...listeners]) listener(id, { status: 'complete' }); });
          return { clicked: true };
        }
        throw new Error('unexpected message');
      }
    },
    scripting: { async executeScript(input) {
      assert.deepEqual(input.files, ['purchase-page.js']);
      if (options.onInject) await options.onInject(input, manager, data);
    } }
  };
  const manager = createPurchaseManager({ api, getProduct: async sku => sku === product.Code ? { ...product, ...options.product } : undefined, onEvent: async event => events.push(event) });
  return { manager, data, tabs, messages, events, api };
}

test('manager takes one durable SKU lock across stores, concurrent stock ticks and worker restart', async () => {
  const h = harness();
  await Promise.all([h.manager.onAvailability(tasks, 'now'), h.manager.onAvailability(tasks, 'now')]);
  assert.equal(h.tabs.length, 1);
  assert.equal(h.messages.filter(m => m.type === 'purchase-add-once').length, 1);
  assert.equal(h.data.purchaseLocks[product.Code].status, 'added');
  assert.equal(h.data.purchaseLocks[product.Code].storeNumber, 'R428');
  assert.equal(h.events.length, 1);
  const restarted = harness({ data: h.data });
  await restarted.manager.restore();
  await restarted.manager.onAvailability(tasks, 'later');
  assert.equal(restarted.tabs.length, 0);
});

test('default-disabled, other SKUs and future preorder time never open a purchase tab', async () => {
  for (const options of [{ data: {} }, { product: { PreorderAt: '2099-09-20T00:00:00Z' } }]) {
    const h = harness(options);
    await h.manager.onAvailability(tasks, 'now');
    assert.equal(h.tabs.length, 0);
  }
  const h = harness();
  await h.manager.onAvailability(tasks.map(task => ({ ...task, product: { Code: 'OTHERZA/A' } })), 'now');
  assert.equal(h.tabs.length, 0);
});

test('pre-existing or unverified bag is preserved without any product/add request', async () => {
  for (const before of [{ kind: 'bag', verified: true, empty: false, items: [{ sku: product.Code, quantity: 1 }] }, { verified: false, detail: '需要登录' }]) {
    const h = harness({ before });
    await h.manager.onAvailability(tasks, 'now');
    assert.deepEqual(h.messages.map(m => m.type), ['purchase-inspect-bag']);
    assert.equal(h.data.purchaseLocks[product.Code].status, 'needs-user');
  }
});

test('mismatching product/price prevents the add click and leaves a manual-review lock', async () => {
  const h = harness({ snapshot: { kind: 'product', verified: true, sku: 'OTHERZA/A', quantity: 1, currency: 'HKD', price: 13299, addAvailable: true } });
  await h.manager.onAvailability(tasks, 'now');
  assert.equal(h.messages.some(m => m.type === 'purchase-add-once'), false);
  assert.equal(h.data.purchaseLocks[product.Code].status, 'needs-user');
});

test('ambiguous click or mismatching resulting bag never reports added and cannot retry automatically', async () => {
  for (const options of [{ clickError: 'The message port closed' }, { after: { kind: 'bag', verified: true, items: [{ sku: product.Code, quantity: 2, currency: 'HKD', price: 26598 }] } }]) {
    const h = harness(options);
    await h.manager.onAvailability(tasks, 'now');
    await h.manager.onAvailability(tasks, 'later');
    assert.equal(h.data.purchaseLocks[product.Code].status, 'needs-user');
    assert.equal(h.messages.filter(m => m.type === 'purchase-add-once').length, 1);
    assert.equal(h.events.some(event => event.status === 'added'), false);
  }
});

test('restoring interrupted operations marks manual review and keeps the reservation', async () => {
  const h = harness({ data: { purchaseSettings: settings, purchaseLocks: { [product.Code]: { sku: product.Code, status: 'adding' } }, purchaseOperations: [] } });
  await h.manager.restore();
  await h.manager.onAvailability(tasks, 'now');
  assert.equal(h.tabs.length, 0);
  assert.equal(h.data.purchaseLocks[product.Code].status, 'needs-user');
});

test('turning the setting off before the click cancels the pending addition', async () => {
  const h = harness({ onMessage: async (message, manager) => {
    if (message.type === 'purchase-inspect-product') await manager.saveSettings({ ...settings, enabled: false });
  } });
  await h.manager.onAvailability(tasks, 'now');
  assert.equal(h.messages.some(message => message.type === 'purchase-add-once'), false);
  assert.equal(h.data.purchaseLocks[product.Code].status, 'needs-user');
});

test('revoking consent during the final page injection prevents the click', async () => {
  let injections = 0;
  const h = harness({ onInject: async (_input, manager) => {
    if (++injections === 3) await manager.saveSettings({ ...settings, enabled: false });
  } });
  await h.manager.onAvailability(tasks, 'now');
  assert.equal(injections, 3);
  assert.equal(h.messages.some(message => message.type === 'purchase-add-once'), false);
  assert.equal(h.data.purchaseLocks[product.Code].status, 'needs-user');
  assert.match(h.data.purchaseLocks[product.Code].detail, /关闭/);
});

test('manual reset removes one lock only and operation history stays bounded', async () => {
  const h = harness({ data: { purchaseSettings: settings, purchaseLocks: { OTHERZA: { status: 'needs-user' } }, purchaseOperations: Array.from({ length: 100 }, () => ({ sku: 'older' })) } });
  await h.manager.onAvailability(tasks, 'now');
  assert.equal(h.data.purchaseOperations.length, 100);
  await h.manager.reset(product.Code);
  assert.equal(h.data.purchaseLocks[product.Code], undefined);
  assert.deepEqual(h.data.purchaseLocks.OTHERZA, { status: 'needs-user' });
});

test('reset cannot queue behind an operation before its durable reservation exists', async () => {
  const h = harness();
  const operation = h.manager.onAvailability(tasks, 'now');
  await assert.rejects(h.manager.reset(product.Code), /正在处理/);
  await operation;
  await h.manager.onAvailability(tasks, 'later');
  assert.equal(h.data.purchaseLocks[product.Code].status, 'added');
  assert.equal(h.messages.filter(message => message.type === 'purchase-add-once').length, 1);
});
