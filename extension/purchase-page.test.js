import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./purchase-page.js', import.meta.url), 'utf8');
const expected = { sku: 'MJXW4ZA/A', model: 'iPhone 18 Pro Max', capacity: '512GB', color: '冰川色', price: 13299, maxPrice: 14000, quantity: 1 };

// Minimal DOM fixture: real selectors are interpreted against element trees;
// tests execute the unmodified injected script, not substitute its readers.
class Element {
  constructor(tag, attrs = {}, content = '', children = []) {
    this.tag = tag; this.attrs = attrs; this.content = content; this.children = children;
    this.value = attrs.value; this.hidden = attrs.hidden || false; this.disabled = attrs.disabled || false; this.clicks = 0;
    for (const child of children) child.parent = this;
  }
  get textContent() { return this.content + this.children.map(c => c.textContent).join(''); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  click() { this.clicks++; }
  closest(tag) { for (let p = this; p; p = p.parent) if (p.tag === tag) return p; return null; }
  matches(selector) {
    const parts = selector.trim().split(/\s+(?![^[]*\])/);
    if (parts.length > 1) {
      if (!this.matches(parts.pop())) return false;
      for (let p = this.parent; p; p = p.parent) if (p.matches(parts.join(' '))) return true;
      return false;
    }
    const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
    if (tag && tag !== this.tag) return false;
    for (const match of selector.matchAll(/\.([a-z0-9-]+)/gi)) if (!String(this.attrs.class || '').split(' ').includes(match[1])) return false;
    for (const match of selector.matchAll(/\[([^=*\]]+)(\*?=)"([^"]*)"\]/g)) {
      const value = this.getAttribute(match[1]);
      if (match[2] === '=' ? value !== match[3] : !String(value || '').includes(match[3])) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',');
    const found = [];
    const visit = item => { for (const child of item.children) { if (selectors.some(s => child.matches(s.trim()))) found.push(child); visit(child); } };
    visit(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const node = (...args) => new Element(...args);
function page({ bag = false, productPatch = {}, quantity = '1', priceText = 'HK$13,299', buttonText = '加入購物袋', contents } = {}) {
  const path = bag ? '/hk-zh/shop/bag' : '/hk-zh/shop/buy-iphone/iphone-18-pro/exact';
  const location = new URL('https://www.apple.com' + path);
  const button = node('button', {}, buttonText);
  const quantityInput = node('input', { name: 'quantity', value: quantity });
  const form = node('form', {}, '', [node('input', { name: 'product', value: expected.sku }), quantityInput, button]);
  const data = { '@type': 'Product', url: location.href, name: 'iPhone 18 Pro Max 512GB 冰川色', offers: [{ sku: expected.sku, priceCurrency: 'HKD', price: expected.price }], ...productPatch };
  const defaultContents = bag ? [node('div', { class: 'rs-bagempty' }, '', [node('h1', { class: 'rs-bag-header' }, '你的購物袋沒有任何項目。')])] : [
    node('script', { type: 'application/ld+json' }, JSON.stringify(data)), form,
    node('div', { 'data-autom': 'summaryHeroPrice' }, priceText)
  ];
  const document = node('document', {}, '', contents || defaultContents);
  let listener;
  const context = vm.createContext({ document, location, URL, console,
    chrome: { runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path, onMessage: { addListener(fn) { listener = fn; } } } },
    setTimeout(fn) { queueMicrotask(fn); return 1; }
  });
  vm.runInContext(source, context);
  async function message(type, overrides = {}, sender = { id: 'test-extension', url: 'chrome-extension://test-extension/worker-v3.js' }) {
    return new Promise(resolve => { const open = listener({ type, expected: { ...expected, ...overrides } }, sender, resolve); if (!open) resolve(undefined); });
  }
  return { message, button, quantityInput, document, location, context };
}

test('page rechecks exact product/price/quantity and clicks only the add button once', async () => {
  const h = page();
  const inspected = await h.message('purchase-inspect-product');
  assert.equal(inspected.verified, true);
  assert.equal(inspected.sku, expected.sku);
  assert.equal(inspected.button, undefined);
  assert.equal((await h.message('purchase-add-once')).clicked, true);
  assert.equal(h.button.clicks, 1);
  assert.equal((await h.message('purchase-add-once')).verified, false);
  assert.equal(h.button.clicks, 1);
});

test('changed quantity, mismatched price/color/SKU and checkout buttons cannot be clicked', async () => {
  for (const options of [
    { quantity: '2' }, { quantity: undefined, priceText: 'HK$14,299' }, { buttonText: '結帳' },
    { productPatch: { name: 'iPhone 18 Pro Max 512GB 黑色' } },
    { productPatch: { offers: [{ sku: 'OTHERZA/A', priceCurrency: 'HKD', price: 13299 }] } }
  ]) {
    const h = page(options);
    assert.equal((await h.message('purchase-add-once')).verified, false);
    assert.equal(h.button.clicks, 0);
  }
  const changed = page();
  assert.equal((await changed.message('purchase-inspect-product')).verified, true);
  changed.quantityInput.value = '2';
  assert.equal((await changed.message('purchase-add-once')).verified, false);
  assert.equal(changed.button.clicks, 0);
});

test('page accepts only its background sender and refuses web content, other extensions and login pages', async () => {
  const h = page();
  for (const sender of [
    { id: 'other', url: 'chrome-extension://other/worker.js' },
    { id: 'test-extension', url: 'https://www.apple.com/hk-zh/shop/', tab: { id: 1 } },
    { id: 'test-extension', url: 'https://example.com/' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/worker-v3.js', tab: { id: 1 } }
  ]) assert.equal(await h.message('purchase-add-once', {}, sender), undefined);
  h.location.pathname = '/hk-zh/shop/signin';
  assert.equal((await h.message('purchase-add-once')).verified, false);
  assert.equal(h.button.clicks, 0);
});

test('bag parser requires an actual empty-bag heading or exact per-item SKU, quantity and price', async () => {
  assert.equal((await page({ bag: true }).message('purchase-inspect-bag')).empty, true);
  const item = node('li', { class: 'rs-bag-item' }, '', [
    node('a', { 'data-autom': 'bag-item-name', href: '/hk-zh/shop/product/MJXW4ZA/A' }, 'iPhone 18 Pro Max'),
    node('select', { 'data-autom': 'item-quantity-dropdown', value: '1' }), node('div', { class: 'rs-iteminfo-price' }, 'HK$13,299')
  ]);
  const bag = await page({ bag: true, contents: [item] }).message('purchase-inspect-bag');
  assert.equal(bag.verified, true);
  assert.equal(bag.items[0].sku, expected.sku);
  assert.equal(bag.items[0].quantity, 1);
  assert.equal(bag.items[0].price, 13299);
  item.children[0].attrs.href = '/hk-zh/shop/buy-iphone/iphone-18-pro';
  assert.equal((await page({ bag: true, contents: [item] }).message('purchase-inspect-bag')).verified, false);
});

test('an ambiguous visible price cannot be discarded in favor of another matching price', async () => {
  const h = page();
  h.document.children.push(node('div', { 'data-autom': 'summaryPrice' }, 'HK$13,299 或 HK$554 每月'));
  assert.equal((await h.message('purchase-add-once')).verified, false);
  assert.equal(h.button.clicks, 0);

  const item = node('li', { class: 'rs-bag-item' }, '', [
    node('a', { 'data-autom': 'bag-item-name', href: '/hk-zh/shop/product/MJXW4ZA/A' }, 'iPhone 18 Pro Max'),
    node('select', { 'data-autom': 'item-quantity-dropdown', value: '1' }),
    node('div', { class: 'rs-iteminfo-price' }, 'HK$13,299'),
    node('div', { class: 'rs-iteminfo-price' }, 'HK$13,299 或 HK$554 每月')
  ]);
  assert.equal((await page({ bag: true, contents: [item] }).message('purchase-inspect-bag')).verified, false);
});
