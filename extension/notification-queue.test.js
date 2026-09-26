import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationQueue } from './notification-queue.js';

const clone = value => structuredClone(value);
const message = index => ({ title: '库存 ' + index, body: '测试消息' });
function harness({ initial = {}, send } = {}) {
  const data = { barkConfig: { enabled: true, key: 'TEST_DEVICE_KEY' }, ...clone(initial) };
  const sent = [];
  const api = { storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])])); },
    async set(values) { Object.assign(data, clone(values)); }
  } } };
  const queue = createNotificationQueue(api, { send: async (key, value) => {
    // Verify the durable marker exists before any request could be made.
    assert.ok(data.notificationQueue.some(row => row.state === 'sending' && row.message.title === value.title));
    sent.push(clone(value));
    return send ? send(key, value) : { ok: true, message: '服务器已接受' };
  } });
  return { data, sent, queue, api };
}

test('a paused monitor can drain more than ten pending messages without another alarm', async () => {
  const h = harness();
  await h.queue.enqueue(Array.from({ length: 15 }, (_, i) => message(i)), 'batch');
  await h.queue.drain();
  assert.equal(h.sent.length, 15);
  assert.deepEqual(h.data.notificationQueue, []);
  assert.equal(h.data.barkStatus.ok, true);
});

test('concurrent event enqueues and drains send each message only once', async () => {
  const h = harness();
  await Promise.all([
    h.queue.enqueue([message(1)], 'same-event'),
    h.queue.enqueue([message(1)], 'same-event'),
    h.queue.enqueue([message(2)], 'another-event'),
    h.queue.drain()
  ]);
  await Promise.all([h.queue.drain(), h.queue.drain()]);
  assert.deepEqual(h.sent.map(row => row.title), ['库存 1', '库存 2']);
  assert.deepEqual(h.data.notificationQueue, []);
});

test('restoring an interrupted send preserves unknown delivery and never retries it', async () => {
  const h = harness({ initial: { notificationQueue: [
    { id: 'interrupted', state: 'sending', createdAt: Date.now(), message: message(1) },
    { id: 'pending', state: 'pending', createdAt: Date.now(), message: message(2) }
  ] } });
  await h.queue.restore();
  assert.equal(h.data.barkStatus.ok, false);
  assert.match(h.data.barkStatus.message, /状态未知/);
  await h.queue.drain();
  assert.deepEqual(h.sent.map(row => row.title), ['库存 2']);
});

test('failed or ambiguous delivery is recorded and not retried on later drains', async () => {
  for (const send of [
    async () => ({ ok: false, message: '请求超时，送达未知' }),
    async () => { throw new Error('TEST_DEVICE_KEY'); }
  ]) {
    const h = harness({ send });
    await h.queue.enqueue([message(1)], 'failed');
    await h.queue.drain();
    await h.queue.enqueue([message(1)], 'failed');
    await h.queue.drain();
    assert.equal(h.sent.length, 1);
    assert.equal(h.data.barkStatus.ok, false);
    assert.ok(!JSON.stringify(h.data.barkStatus).includes('TEST_DEVICE_KEY'));
    assert.deepEqual(h.data.notificationQueue, []);
  }
});

test('disabled notifications and expired messages never reach the sender', async () => {
  const h = harness({ initial: { notificationQueue: [
    { id: 'expired', state: 'pending', createdAt: Date.now() - 3600001, message: message(1) }
  ] } });
  await h.queue.drain();
  h.data.barkConfig.enabled = false;
  await h.queue.enqueue([message(2)], 'disabled');
  await h.queue.drain();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.data.notificationQueue, []);
});
