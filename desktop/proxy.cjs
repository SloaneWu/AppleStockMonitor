'use strict';
const net = require('node:net');

// Applies to the Apple window session only. Bark and the local pages keep their own connections.
const DEFAULT_PROXY = Object.freeze({ mode: 'custom', scheme: 'http', host: '127.0.0.1', port: 7897 });
// Chromium net errors that mean the proxy itself, not Apple, failed.
const PROXY_FAILURES = new Set([-111, -120, -130]);
const HOST = /^(?:localhost|(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i;

function normalizeProxy(input) {
  if (input == null) return { ...DEFAULT_PROXY };
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('代理设置无效');
  const mode = input.mode;
  if (!['custom', 'system', 'direct'].includes(mode)) throw new Error('代理方式无效');
  const scheme = input.scheme ?? DEFAULT_PROXY.scheme;
  if (!['http', 'socks5'].includes(scheme)) throw new Error('代理类型仅支持 HTTP 或 SOCKS5');
  const host = String(input.host ?? DEFAULT_PROXY.host).trim();
  const port = Number(input.port ?? DEFAULT_PROXY.port);
  if (mode === 'custom' && !HOST.test(host)) throw new Error('代理地址应为 IP 或主机名，例如 127.0.0.1');
  if (mode === 'custom' && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('代理端口应为 1–65535 的整数');
  // Keep the last custom address while direct/system is selected so switching back is one click.
  return { mode, scheme, host: HOST.test(host) ? host : DEFAULT_PROXY.host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PROXY.port };
}

function proxyConfig(settings) {
  if (settings.mode === 'direct') return { mode: 'direct' };
  if (settings.mode === 'system') return { mode: 'system' };
  return { mode: 'fixed_servers', proxyRules: `${settings.scheme}://${settings.host}:${settings.port}`, proxyBypassRules: '<local>' };
}

function proxyLabel(settings) {
  if (settings.mode === 'direct') return '直连（不使用代理）';
  if (settings.mode === 'system') return '跟随 Windows 系统代理';
  return `${settings.scheme === 'socks5' ? 'SOCKS5' : 'HTTP'} ${settings.host}:${settings.port}`;
}

// Opens a TCP connection to the proxy port only; no request is sent through it.
function testProxyPort(settings, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = net.connect({ host: settings.host, port: settings.port });
    const finish = (ok, message) => { socket.destroy(); resolve({ ok, message }); };
    socket.setTimeout(timeoutMs, () => finish(false, `连接 ${settings.host}:${settings.port} 超时，请确认代理软件已运行。`));
    socket.once('connect', () => finish(true, `代理端口 ${settings.host}:${settings.port} 可以连接。未通过代理访问 Apple。`));
    socket.once('error', error => finish(false, `无法连接 ${settings.host}:${settings.port}（${error.code || '连接失败'}），请确认 Clash Verge 等代理软件已运行且端口正确。`));
  });
}

module.exports = { DEFAULT_PROXY, PROXY_FAILURES, normalizeProxy, proxyConfig, proxyLabel, testProxyPort };
