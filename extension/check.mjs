import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const file of readdirSync(new URL('.', import.meta.url)).filter(file => /\.(?:js|mjs)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: new URL('.', import.meta.url), encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr || 'Syntax check failed: ' + file); process.exit(result.status || 1); }
}
console.log('All JavaScript files passed syntax checks.');
