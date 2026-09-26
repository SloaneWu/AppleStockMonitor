import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsValue, intervalForSku, dueAt, nextDue, restoreItems, keyForTask, isStockPage, safeDiagnostic, REQUEST_BUDGET, budgetValue, budgetReadyAt, spendBudget } from './scheduler.js';

const now = Date.parse('2026-09-22T12:00:00Z');
const tasks = Array.from({ length: 9 }, (_, n) => ({ id: 't' + n, areaCode: 'hk', product: { Code: `MJ${n}ZA/A` }, store: { StoreNumber: 'R428' } }));

test('manual holds expose no automatic next check even after the cooldown expires', () => {
  for (const health of [{ manualRecoveryRequired: true }, { state: 'needs-user' }, { recoveryPending: true }]) {
    assert.equal(nextDue(tasks, { connectionHealth: { ...health, notBefore: now - 1 } }, now), 0);
  }
});
test('large watchlists stay at 60 seconds except up to eight selected focus SKUs', () => {
  assert.equal(intervalForSku('MJ0ZA/A', {}, tasks, now), 60000);
  assert.equal(intervalForSku('MJ0ZA/A', { focusSkus: ['MJ0ZA/A'] }, tasks, now), 20000);
  assert.equal(intervalForSku('MJ1ZA/A', { focusSkus: ['MJ0ZA/A'], boostUntil: now + 600000 }, tasks, now), 60000);
  assert.equal(intervalForSku('MJ0ZA/A', { focusSkus: ['MJ0ZA/A'], boostUntil: now + 600000 }, tasks, now), 10000);
  assert.equal(settingsValue({ boostUntil: now - 1 }, now).boostUntil, 0);
});
test('server cooldown, pending request and product opening time all override short cadence', () => {
  const product = { ...tasks[0], product: { ...tasks[0].product, PreorderAt: '2026-10-16T20:00:00+08:00' } };
  const deadline = Date.parse(product.product.PreorderAt);
  assert.equal(dueAt(product, { connectionHealth: { notBefore: now + 120000 } }, now), deadline);
  const item = restoreItems([product], { [keyForTask(product)]: { status: '无货' } }, now)[product.id];
  assert.equal(item.status, '未开放预订');
  assert.equal(item.lastSuccess, null);
  assert.equal(dueAt(tasks[0], { skuCooldowns: { 'MJ0ZA/A': { nextAt: now + 10000 } }, inflight: { until: now + 60000 }, connectionHealth: { notBefore: now + 120000 } }, now), now + 120000);
});
test('monitor tab classification excludes bags, checkout, login and other regions', () => {
  for (const path of ['/hk-zh/shop/buy-iphone/iphone-18-pro', '/hk-zh/shop/product/MJXW4ZA/A']) assert.equal(isStockPage('https://www.apple.com' + path), true);
  for (const path of ['/hk-zh/shop/bag', '/hk-zh/shop/checkout', '/hk-zh/shop/signIn', '/us/shop/buy-iphone/iphone-18-pro']) assert.equal(isStockPage('https://www.apple.com' + path), false);
  assert.equal(isStockPage('https://www.apple.com.evil.example/hk-zh/shop/buy-iphone/iphone-18-pro'), false);
});
test('diagnostics are an explicit allowlist and cannot persist arbitrary response text', () => {
  const result = safeDiagnostic({ status: 541, body: 'COOKIESECRET', headers: { cookie: 'COOKIESECRET' }, error: 'COOKIESECRET', responseKind: 'html' }, { skus: ['MJXW4ZA/A', 'COOKIESECRET'], arbitrary: 'COOKIESECRET' });
  assert.doesNotMatch(JSON.stringify(result), /COOKIESECRET/);
  assert.equal(result.status, 541);
  assert.equal(safeDiagnostic({ diagnosticStage: 'bridge-probe' }).stage, 'bridge-probe');
  assert.equal(safeDiagnostic({ diagnosticStage: 'COOKIESECRET' }).stage, undefined);
});
test('shared request budget allows a burst, then refills one request per minute', () => {
  assert.deepEqual(budgetValue({}, now), { tokens: REQUEST_BUDGET.capacity, updatedAt: now });
  let saved = {};
  for (let i = 0; i < REQUEST_BUDGET.capacity; i++) {
    assert.equal(budgetReadyAt(saved, now), 0);
    saved = { requestBudget: spendBudget(saved, now) };
  }
  assert.equal(budgetReadyAt(saved, now), now + REQUEST_BUDGET.refillMs);
  assert.equal(dueAt(tasks[0], saved, now), now + REQUEST_BUDGET.refillMs);
  assert.equal(budgetReadyAt(saved, now + REQUEST_BUDGET.refillMs), 0);
  assert.equal(budgetValue(saved, now + 3600000).tokens, REQUEST_BUDGET.capacity);
  assert.equal(budgetValue(saved, now - 3600000).tokens, 0, 'a clock moved backwards grants nothing');
  assert.equal(budgetValue({ requestBudget: { tokens: 'x', updatedAt: now } }, now).tokens, REQUEST_BUDGET.capacity);
});
