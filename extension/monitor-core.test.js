import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_INTERVAL_MS, classifyResponse, groupKey, groupTasks, recordOutcome, retryDelay
} from './monitor-core.js';

const task = {
  id: 'central-max-512', areaCode: 'hk',
  store: { StoreNumber: 'R428', CityStoreName: 'ifc mall' },
  product: { Code: 'MJXW4ZA/A', Model: 'iPhone 18 Pro Max', Capacity: '512GB', Color: '冰川色' }
};
const checkedAt = '2026-09-20T12:00:00.000Z';
function response(token, overrides = {}) {
  return { status: 200, body: JSON.stringify({ body: { stores: [{
    storeNumber: 'R428', partsAvailability: { 'MJXW4ZA/A': { pickupDisplay: token } }
  }] } }), ...overrides };
}

test('only explicit recognized pickup states yield stock conclusions', () => {
  for (const [raw, expected] of [['available', '有货'], ['unavailable', '无货'], ['ineligible', '不可提取']]) {
    const [outcome] = classifyResponse(response(raw), [task]);
    assert.equal(outcome.status, expected);
    assert.equal(outcome.known, true);
    assert.equal(outcome.httpStatus, 200);
  }
});

test('unknown tokens, missing SKU/store and malformed responses never become out of stock', () => {
  const results = [
    response('unexpected-new-state'), response(''), response('AVAILABLE'), response(null),
    { status: 200, body: '{"body":{"stores":[{"storeNumber":"R428","partsAvailability":{}}]}}' },
    { status: 200, body: '{"body":{"stores":[]}}' },
    { status: 200, body: '{"body":{"content":{"pickupMessage":{"pickupEligibility":{}}}}}' },
    { status: 200, body: '<html>Verify browser</html>' },
    { status: 200, body: 'null' },
    { status: 541 }, { status: 503 }, { status: 429 }, { status: 0, error: 'timeout' }, null
  ];
  for (const result of results) {
    const [outcome] = classifyResponse(result, [task]);
    assert.equal(outcome.known, false, JSON.stringify(result));
    assert.notEqual(outcome.status, '无货');
    assert.notEqual(outcome.status, '有货');
  }
  assert.equal(classifyResponse({ status: 541 }, [task])[0].status, '官网查询受阻');
  assert.equal(classifyResponse({ status: 503 }, [task])[0].status, '查询异常');
  assert.equal(classifyResponse({ status: 429 }, [task])[0].status, '请求受限');
});

test('failed checks preserve the last successful observation and its timestamp', () => {
  const success = recordOutcome(classifyResponse(response('available'), [task])[0], null, checkedAt);
  const later = '2026-09-20T12:02:00.000Z';
  const failed = recordOutcome(classifyResponse({ status: 503 }, [task])[0], success.item, later);
  assert.equal(failed.item.status, '查询异常');
  assert.equal(failed.item.checkedAt, later);
  assert.deepEqual(failed.item.lastSuccess, success.item.lastSuccess);
  assert.equal(failed.item.lastSuccess.checkedAt, checkedAt);
  assert.equal(failed.notify, false);
  assert.equal(failed.row.changed, false);
  assert.equal(failed.row.previousStatus, '有货');
});

test('recovery to the same successful state does not duplicate notifications or stock changes', () => {
  const first = recordOutcome(classifyResponse(response('available'), [task])[0], null, checkedAt);
  assert.equal(first.notify, true);
  assert.equal(first.row.changed, false);
  const failure = recordOutcome(classifyResponse({ status: 541 }, [task])[0], first.item, checkedAt);
  const recovered = recordOutcome(classifyResponse(response('available'), [task])[0], failure.item, checkedAt);
  assert.equal(recovered.notify, false);
  assert.equal(recovered.row.changed, false);
  const unavailable = recordOutcome(classifyResponse(response('unavailable'), [task])[0], recovered.item, checkedAt);
  assert.equal(unavailable.row.changed, true);
  assert.equal(unavailable.notify, false);
  const restocked = recordOutcome(classifyResponse(response('available'), [task])[0], unavailable.item, checkedAt);
  assert.equal(restocked.notify, true);
  assert.equal(restocked.row.changed, true);
  assert.equal(restocked.row.previousStatus, '无货');
});

test('recorded rows identify the exact SKU, store and effective previous state', () => {
  const { row } = recordOutcome(classifyResponse(response('ineligible'), [task])[0], null, checkedAt);
  assert.equal(row.taskId, task.id);
  assert.equal(row.sku, task.product.Code);
  assert.equal(row.storeName, task.store.CityStoreName);
  assert.equal(row.capacity, '512GB');
  assert.equal(row.color, '冰川色');
  assert.equal(row.status, '不可提取');
  assert.match(row.detail, /不代表库存数量/);
});

test('polling floor, bounded backoff and Retry-After are respected', () => {
  const now = Date.parse(checkedAt);
  assert.equal(MIN_INTERVAL_MS, 60000);
  for (const failures of [0, 1, 2, 3, 4, 100]) assert.ok(retryDelay(failures, null, now) >= 60000);
  assert.equal(retryDelay(100, null, now), 900000);
  assert.equal(retryDelay(1, '3600', now), 3600000);
  assert.equal(retryDelay(1, new Date(now + 3600000).toUTCString(), now), 3600000);
  assert.equal(retryDelay(1, 'bad-date', now), 120000);
  assert.equal(retryDelay(1, '-2', now), 120000);
  assert.equal(retryDelay(1, '', now), 120000);
});

test('queries group at most eight unique SKUs while keeping all stores for a SKU', () => {
  const tasks = Array.from({ length: 9 }, (_, i) => [
    { ...task, id: `a-${i}`, product: { ...task.product, Code: `TEST${i}ZA/A` } },
    { ...task, id: `b-${i}`, product: { ...task.product, Code: `TEST${i}ZA/A` }, store: { StoreNumber: 'R499' } }
  ]).flat();
  const groups = groupTasks(tasks);
  assert.deepEqual(groups.map(group => group.length), [16, 2]);
  assert.equal(groups.flat().length, tasks.length);
  assert.equal(new Set(groups[0].map(t => t.product.Code)).size, 8);
  assert.equal(groupKey(groups[0]), groupKey([...groups[0]].reverse()));
});
