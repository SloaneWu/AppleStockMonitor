import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PURCHASE_SETTINGS, validatePurchaseSettings, purchaseURL, chooseAvailableTask, checkProductSnapshot, verifyAddedBag } from './purchase-core.js';
const product = { Code: 'MJXW4ZA/A', Model: 'iPhone 18 Pro Max', Capacity: '512GB', Color: '冰川色', Price: 13299, PurchasePath: '/shop/buy-iphone/iphone-18-pro/6.9-512gb-glacier' };
const settings = { enabled: true, sku: product.Code, maxPrice: 14000, quantity: 1, storePriority: ['R428', 'R409'] };
const snapshot = { verified: true, kind: 'product', sku: product.Code, quantity: 1, price: 13299, currency: 'HKD', addAvailable: true };

test('automatic bag feature defaults off and requires a catalog SKU, explicit ceiling, one item and HK stores', () => {
  assert.equal(DEFAULT_PURCHASE_SETTINGS.enabled, false);
  assert.deepEqual(validatePurchaseSettings(settings, product), settings);
  for (const patch of [{ sku: 'OTHERZA/A' }, { quantity: 2 }, { maxPrice: '' }, { maxPrice: 13000 }, { storePriority: ['R999'] }, { storePriority: ['R428', 'R428'] }]) {
    assert.throws(() => validatePurchaseSettings({ ...settings, ...patch }, product));
  }
  assert.throws(() => validatePurchaseSettings(settings, { ...product, Price: undefined }));
  assert.throws(() => validatePurchaseSettings(settings, { ...product, Color: '' }));
});

test('purchase link uses only the canonical Apple HK product path', () => {
  assert.equal(purchaseURL(product), 'https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro/6.9-512gb-glacier');
  for (const path of ['https://example.com/hk-zh/shop/product/MJXW4ZA/A', '/us/shop/product/MJXW4ZA/A', '/hk-zh/shop/checkout', '/hk-zh/shop/product/test?redirect=bad']) {
    assert.throws(() => purchaseURL({ ...product, PurchasePath: path }));
  }
});

test('available store priority is deterministic and never substitutes another SKU', () => {
  const tasks = ['R409', 'R428'].map(id => ({ areaCode: 'hk', product, store: { StoreNumber: id } }));
  assert.equal(chooseAvailableTask(tasks, settings).store.StoreNumber, 'R428');
  assert.equal(chooseAvailableTask(tasks, { ...settings, sku: 'OTHERZA/A' }), undefined);
  assert.equal(chooseAvailableTask([{ ...tasks[0], areaCode: 'cn' }], settings), undefined);
});

test('product verification blocks price, SKU, currency, quantity and unresolved selection mismatches', () => {
  checkProductSnapshot(snapshot, product, settings);
  for (const patch of [{ sku: 'OTHERZA/A' }, { price: 14001 }, { price: 13298 }, { price: NaN }, { quantity: 2 }, { currency: 'USD' }, { addAvailable: false }, { verified: false }]) {
    assert.throws(() => checkProductSnapshot({ ...snapshot, ...patch }, product, settings));
  }
});

test('only exact single-item bag evidence is confirmation; a click cannot establish success', () => {
  const item = { sku: product.Code, quantity: 1, price: 13299, currency: 'HKD' };
  const bag = { kind: 'bag', verified: true, items: [item] };
  assert.equal(verifyAddedBag(bag, product, settings), true);
  for (const candidate of [{ clicked: true }, { ...bag, items: [] }, { ...bag, items: [item, item] }, { ...bag, items: [{ ...item, quantity: 2 }] }, { ...bag, items: [{ ...item, sku: 'OTHERZA/A' }] }, { ...bag, items: [{ ...item, price: 14001 }] }]) {
    assert.equal(verifyAddedBag(candidate, product, settings), false);
  }
});
