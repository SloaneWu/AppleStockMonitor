'use strict';
const path = require('node:path');
const APP_ORIGIN = 'stockapp://local';
const APP_ID = 'apple-stock-monitor-desktop';
const VERSION = '4.0.1';
function isAppleNavigation(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
    (u.hostname === 'apple.com' || u.hostname.endsWith('.apple.com')); } catch { return false; }
}
function isAppleShop(value) {
  try { const u = new URL(value); return u.origin === 'https://www.apple.com' && !u.username && !u.password && /^\/hk(?:-zh)?\/shop\//.test(u.pathname); } catch { return false; }
}
function appResource(value, root) {
  const u = new URL(value);
  if (u.origin !== 'null' && u.origin !== APP_ORIGIN) throw new Error('无效应用地址');
  if (u.protocol !== 'stockapp:' || u.host !== 'local' || u.username || u.password) throw new Error('无效应用来源');
  const relative = decodeURIComponent(u.pathname).slice(1);
  if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('无效资源路径');
  if (['engine.html', 'engine-boot.js'].includes(relative)) return path.join(root, 'desktop', relative);
  if (!/\.(?:js|json|html|css|png)$/.test(relative) || /(?:^|\/)(?:node_modules|desktop|tests)\//.test(relative) || /\.test\.js$/.test(relative)) throw new Error('不允许读取此资源');
  const base = path.resolve(root, 'extension'), file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) throw new Error('资源超出应用目录');
  return file;
}
function isLocalPage(value, role) {
  try { const u = new URL(value); return u.protocol === 'stockapp:' && u.host === 'local' && !u.username && !u.password &&
    u.pathname === (role === 'engine' ? '/engine.html' : '/app.html'); } catch { return false; }
}
module.exports = { APP_ORIGIN, APP_ID, VERSION, isAppleNavigation, isAppleShop, appResource, isLocalPage };
