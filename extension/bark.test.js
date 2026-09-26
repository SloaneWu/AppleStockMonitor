import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBarkKey, stockBarkMessages, sendBark } from './bark.js';

const key = 'TEST_DEVICE_KEY';
test('accepts a key or exact official HTTPS device address without leaking invalid input', () => {
  assert.equal(parseBarkKey(key), key);
  assert.equal(parseBarkKey(` https://api.day.app/${key}/ `), key);
  for (const value of [`http://api.day.app/${key}`, `https://api.day.app.evil.test/${key}`,
    `https://user:secret@api.day.app/${key}`, `https://api.day.app/${key}/message`,
    `https://api.day.app/${key}?url=x`, '', `https://api.day.app/${key}#anything`]) {
    assert.throws(() => parseBarkKey(value), error => !error.message.includes(key) && !error.message.includes('secret'));
  }
});

test('posts to fixed endpoint with no cookies, redirects or key in URL', async () => {
  let request;
  const result = await sendBark(key, { title: '标题', body: '内容', url: 'https://www.apple.com/hk-zh/' }, {
    fetcher: async (url, init) => { request = { url, init }; return { ok: true, json: async () => ({ code: 200 }) }; }
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.day.app/push');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.method, 'POST');
  assert.equal(JSON.parse(request.init.body).device_key, key);
  assert.equal(JSON.parse(request.init.body).title, '标题');
  assert.ok(!JSON.stringify(result).includes(key));
});

test('server rejection, invalid JSON and network errors are not reported as delivered and are redacted', async () => {
  const responses = [
    async () => ({ ok: false, status: 400 }),
    async () => ({ ok: true, json: async () => ({ code: 400, message: key }) }),
    async () => ({ ok: true, json: async () => { throw new Error(key); } }),
    async () => { throw new Error('bad request ' + key); }
  ];
  for (const fetcher of responses) {
    const result = await sendBark(key, { title: 'test', body: 'test' }, { fetcher });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('timeouts cancel transport without automatically retrying', async () => {
  let calls = 0;
  const result = await sendBark(key, { title: 'test', body: 'test' }, { timeoutMs: 5,
    fetcher: async (_url, init) => { calls++; return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error(key)), { once: true });
    }); }
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.match(result.message, /超时/);
});

test('groups newly available stores by SKU and includes product and time', () => {
  const task = { areaCode: 'hk', product: { Code: 'MJXW4ZA/A', Model: 'iPhone 18 Pro Max', Capacity: '512GB', Color: '冰川色' }, store: { CityStoreName: 'ifc mall' } };
  const messages = stockBarkMessages([task, task, { ...task, store: { CityStoreName: 'Canton Road' } }], '2026-09-20T12:00:00Z');
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /iPhone 18 Pro Max 有货/);
  assert.match(messages[0].body, /512GB · 冰川色/);
  assert.match(messages[0].body, /ifc mall、Canton Road/);
  assert.match(messages[0].body, /20:00:00/);
  assert.equal(messages[0].url, 'https://www.apple.com/hk-zh/shop/product/MJXW4ZA/A');
});
