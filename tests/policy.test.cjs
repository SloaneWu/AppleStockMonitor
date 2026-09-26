const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isAppleNavigation, isAppleShop, isLocalPage, appResource } = require('../desktop/policy.cjs');
test('Apple window navigation never accepts lookalike, credentials, non-HTTPS or external hosts', () => {
  for (const u of ['https://www.apple.com/hk-zh/shop/bag', 'https://idmsa.apple.com/']) assert.equal(isAppleNavigation(u), true);
  for (const u of ['http://www.apple.com/', 'https://apple.com.evil.example/', 'https://evil-apple.com/', 'file:///C:/private', 'https://name@apple.com/', 'javascript:alert(1)']) assert.equal(isAppleNavigation(u), false, u);
  assert.equal(isAppleShop('https://idmsa.apple.com/'), false);
  assert.equal(isAppleShop('https://www.apple.com/us/shop/bag'), false);
  assert.equal(isAppleShop('https://www.apple.com/hk/shop/bag'), true);
});
test('trusted local page roles cannot be supplied by remote or lookalike hosts', () => {
  assert.equal(isLocalPage('stockapp://local/app.html#history', 'dashboard'), true);
  assert.equal(isLocalPage('stockapp://local/engine.html', 'engine'), true);
  for (const url of ['https://local/app.html', 'stockapp://other/app.html', 'stockapp://user@local/app.html', 'stockapp://local/engine.html']) assert.equal(isLocalPage(url, 'dashboard'), false);
});
test('protocol serves only bundled web assets and rejects encoded traversal/private files', () => {
  const root = path.resolve('fixture');
  assert.equal(appResource('stockapp://local/app.html', root), path.join(root, 'extension/app.html'));
  assert.equal(appResource('stockapp://local/engine.html', root), path.join(root, 'desktop/engine.html'));
  for (const url of ['stockapp://local/%2e%2e%2fdesktop/main.cjs', 'stockapp://local/%5c..%5csettings.json', 'stockapp://local/desktop/main.cjs', 'stockapp://local/settings.txt', 'stockapp://local/app.test.js', 'https://local/app.html']) assert.throws(() => appResource(url, root), undefined, url);
});
