'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { DEFAULT_PROXY, PROXY_FAILURES, normalizeProxy, proxyConfig, proxyLabel, testProxyPort } = require('../desktop/proxy.cjs');

test('default proxy is the local Clash Verge mixed port over HTTP', () => {
  assert.deepEqual(normalizeProxy(undefined), { mode: 'custom', scheme: 'http', host: '127.0.0.1', port: 7897 });
  assert.deepEqual(DEFAULT_PROXY, normalizeProxy(null));
  assert.deepEqual(proxyConfig(DEFAULT_PROXY), { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7897', proxyBypassRules: '<local>' });
  assert.equal(proxyLabel(DEFAULT_PROXY), 'HTTP 127.0.0.1:7897');
});

test('user-edited proxies are validated and converted to Electron proxy configs', () => {
  const socks = normalizeProxy({ mode: 'custom', scheme: 'socks5', host: ' 192.168.1.20 ', port: '7890' });
  assert.deepEqual(socks, { mode: 'custom', scheme: 'socks5', host: '192.168.1.20', port: 7890 });
  assert.equal(proxyConfig(socks).proxyRules, 'socks5://192.168.1.20:7890');
  assert.equal(normalizeProxy({ mode: 'custom', host: 'localhost', port: 7897 }).host, 'localhost');
  assert.deepEqual(proxyConfig(normalizeProxy({ mode: 'direct' })), { mode: 'direct' });
  assert.deepEqual(proxyConfig(normalizeProxy({ mode: 'system' })), { mode: 'system' });
  for (const bad of [
    { mode: 'custom', host: 'http://127.0.0.1', port: 7897 }, { mode: 'custom', host: 'user:pw@host.com', port: 7897 },
    { mode: 'custom', host: '127.0.0.1;evil', port: 7897 }, { mode: 'custom', host: '999.1.1.1', port: 7897 },
    { mode: 'custom', host: '127.0.0.1', port: 0 }, { mode: 'custom', host: '127.0.0.1', port: 65536 }, { mode: 'custom', host: '127.0.0.1', port: 78.5 },
    { mode: 'custom', scheme: 'https', host: '127.0.0.1', port: 7897 }, { mode: 'pac' }, [], 'proxy'
  ]) assert.throws(() => normalizeProxy(bad), undefined, JSON.stringify(bad));
});

test('direct and system modes keep the last custom address for switching back', () => {
  assert.deepEqual(normalizeProxy({ mode: 'direct', scheme: 'socks5', host: '10.0.0.2', port: 1080 }), { mode: 'direct', scheme: 'socks5', host: '10.0.0.2', port: 1080 });
  assert.deepEqual(normalizeProxy({ mode: 'system', host: 'not valid', port: -1 }), { mode: 'system', scheme: 'http', host: '127.0.0.1', port: 7897 });
});

test('proxy failures are Chromium proxy/tunnel errors only', () => {
  assert.equal(PROXY_FAILURES.has(-130), true);
  assert.equal(PROXY_FAILURES.has(-3), false);
  assert.equal(PROXY_FAILURES.has(-105), false);
});

test('port test only opens a local TCP connection and reports closed ports', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const open = await testProxyPort({ host: '127.0.0.1', port });
  assert.equal(open.ok, true);
  assert.match(open.message, /可以连接/);
  await new Promise(resolve => server.close(resolve));
  const closed = await testProxyPort({ host: '127.0.0.1', port });
  assert.equal(closed.ok, false);
  assert.match(closed.message, /无法连接|超时/);
});
