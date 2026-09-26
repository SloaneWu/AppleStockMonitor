'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version');
const portable = path.join(source, 'dist', `AppleStockMonitor-Windows-v${version}-portable`);
const manifestName = '交付文件清单-SHA256.json';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function files(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    if (['Data', 'SelfTestData', 'node_modules', '__pycache__'].includes(entry.name) || entry.name.startsWith('SelfTestData-')) throw new Error('交付目录不应包含用户数据或依赖缓存：' + entry.name);
    const name = path.join(relative, entry.name);
    return entry.isDirectory() ? files(root, name) : [name];
  });
}
for (const relative of files(path.join(portable, 'resources/app'))) {
  const sourceFile = path.join(source, relative);
  if (!fs.existsSync(sourceFile) || hash(sourceFile) !== hash(path.join(portable, 'resources/app', relative))) throw new Error('成品代码与源码不一致：' + relative);
}
for (const directory of [portable]) {
  const rows = files(directory).filter(name => name !== manifestName).sort().map(name => ({
    path: name.split(path.sep).join('/'), bytes: fs.statSync(path.join(directory, name)).size, sha256: hash(path.join(directory, name))
  }));
  fs.writeFileSync(path.join(directory, manifestName), JSON.stringify({ version, frozenAt: new Date().toISOString(),
    note: 'Excludes this manifest. No user Data, Cookie, Bark key or development cache included.', files: rows }, null, 2) + '\n');
  console.log(JSON.stringify({ directory, files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) }));
}
