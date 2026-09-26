'use strict';
// Only official Electron release assets; verify the binary against its release checksum.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const version = '44.4.5';
const name = `electron-v${version}-win32-x64.zip`;
const cache = process.env.APPLE_STOCK_RUNTIME_CACHE
  ? path.resolve(process.env.APPLE_STOCK_RUNTIME_CACHE) : path.resolve(__dirname, '../.cache/electron-runtime');
async function main() {
  fs.mkdirSync(cache, { recursive: true });
  const base = `https://github.com/electron/electron/releases/download/v${version}/`;
  const sums = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(60000) });
  if (!sums.ok) throw new Error(`校验清单下载失败 HTTP ${sums.status}`);
  const text = await sums.text();
  const row = text.split(/\r?\n/).find(row => row.trim().split(/\s+/).at(-1)?.replace(/^\*/, '') === name);
  const expected = row?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('官方清单缺少 Windows x64 文件');
  const target = path.join(cache, name);
  if (!fs.existsSync(target)) {
    const response = await fetch(base + name, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`运行时下载失败 HTTP ${response.status}`);
    const partial = target + '.partial';
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
    const actual = crypto.createHash('sha256').update(fs.readFileSync(partial)).digest('hex');
    if (actual !== expected) throw new Error('运行时 SHA256 不匹配，未采用下载文件');
    fs.renameSync(partial, target);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (digest !== expected) throw new Error('已存在运行时 SHA256 不匹配');
  fs.writeFileSync(path.join(cache, 'runtime-verified.json'), JSON.stringify({ version, name, sha256: digest, source: base + name }, null, 2) + '\n');
  console.log(JSON.stringify({ version, target, bytes: fs.statSync(target).size, sha256: digest }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
