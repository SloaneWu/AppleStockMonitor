'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionState, requestKind } = require('../desktop/connection.cjs');
const endpoint = 'https://www.apple.com/hk-zh/shop/fulfillment-messages?location=private&token=secret';
const pickup = (state, status = 200, contentType = 'application/json') => state.observe({ url: endpoint,
  resourceType: 'xhr', statusCode: status, responseHeaders: { 'Content-Type': [contentType], 'Set-Cookie': ['private'] } });
test('page load and bridge presence do not establish pickup readiness', () => {
  const state = createConnectionState();
  assert.equal(state.readiness().reason, 'page-loading');
  state.loaded();
  assert.equal(state.readiness().reason, 'website-not-ready');
  state.observe({ url: 'https://www.apple.com/hk-zh/shop/buy-iphone', resourceType: 'mainFrame', statusCode: 200 });
  assert.equal(state.readiness().ready, false);
  pickup(state);
  assert.equal(state.readiness().ready, true);
});
test('a website 541 is detected before adding a monitor request', () => {
  const state = createConnectionState(); state.loaded(); pickup(state, 541, 'text/html');
  assert.equal(state.readiness().status, 541);
  assert.equal(state.readiness().reason, 'website-blocked');
  assert.equal(state.snapshot().monitorRequests, 0);
  pickup(state); assert.equal(state.readiness().ready, true);
});
test('HTML including HTTP 200 is never pickup readiness', () => {
  const state = createConnectionState(); state.loaded(); pickup(state, 200, 'text/html');
  assert.equal(state.readiness().ready, false);
});
test('navigation and load failure discard previous readiness', () => {
  const state = createConnectionState(); state.loaded(); pickup(state);
  state.begin(); assert.equal(state.readiness().reason, 'page-loading');
  state.loaded(); assert.equal(state.readiness().ready, false);
  state.failed(); assert.equal(state.readiness().reason, 'page-load-failed');
  state.begin(); state.loaded(); pickup(state); assert.equal(state.readiness().ready, true);
});
test('top-level block wins even if a subrequest had JSON', () => {
  const state = createConnectionState(); state.loaded(); pickup(state);
  state.observe({ url: 'https://www.apple.com/hk/shop/buy-iphone', resourceType: 'mainFrame', statusCode: 403 });
  assert.equal(state.readiness().status, 403);
});
test('diagnostics are bounded and contain no URLs headers or response bodies', () => {
  const state = createConnectionState(); state.loaded();
  for (let i = 0; i < 40; i++) pickup(state);
  const snapshot = state.snapshot();
  assert.equal(snapshot.recent.length, 24);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|Cookie|token|https/);
  snapshot.recent[0].status = 541;
  assert.equal(state.snapshot().recent[0].status, 200);
});
test('request filter ignores other origins regions and unrelated paths', () => {
  for (const url of ['https://example.com/hk/shop/fulfillment-messages', 'https://www.apple.com/us/shop/fulfillment-messages',
    'https://www.apple.com/hk/shop/bag', 'invalid']) assert.equal(requestKind(url, 'xhr'), null);
});
test('monitor response evidence and counts remain separate from website traffic', () => {
  const state = createConnectionState(); state.loaded();
  state.monitorResult({ status: 200, responseKind: 'json' });
  assert.equal(state.readiness().ready, true);
  state.monitorResult({ status: 541, responseKind: 'html', body: 'private' });
  assert.equal(state.readiness().ready, false);
  assert.equal(state.snapshot().monitorRequests, 2);
  assert.equal(state.snapshot().recent.at(-1).kind, 'monitor');
});
