'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../desktop/storage.cjs');

function temporarySettings(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'apple-stock-storage-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('apple-stock-storage-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, 'settings.json') };
}

test('reads Chrome-style defaults and key selection without writing defaults', async t => {
  const { file } = temporarySettings(t);
  const storage = createStorage(file);
  assert.deepEqual(await storage.get(), {});
  assert.deepEqual(await storage.get(null), {});
  assert.deepEqual(await storage.get({ monitoring: false, options: { interval: 60 } }), { monitoring: false, options: { interval: 60 } });
  assert.equal(fs.existsSync(file), false);
  await storage.set({ monitoring: true, options: { interval: 120 }, nullable: null });
  assert.deepEqual(await storage.get('missing'), {});
  assert.deepEqual(await storage.get(['monitoring', 'missing']), { monitoring: true });
  assert.deepEqual(await storage.get({ monitoring: false, nullable: 'fallback', missing: 12 }), { monitoring: true, nullable: null, missing: 12 });
  await assert.rejects(storage.get(123), TypeError);
  await assert.rejects(storage.get([123]), TypeError);
});

test('concurrent merges serialize without losing updates and survive restart', async t => {
  const { file, directory } = temporarySettings(t);
  const storage = createStorage(file);
  const writes = Array.from({ length: 24 }, (_, index) => storage.set({ [`task${index}`]: { index }, lastWrite: index }));
  await storage.flush();
  await Promise.all(writes);
  const restarted = createStorage(file);
  const saved = await restarted.get();
  assert.equal(saved.lastWrite, 23);
  for (let index = 0; index < 24; index += 1) assert.deepEqual(saved[`task${index}`], { index });
  assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
});

test('input, return values, snapshots and notification values cannot mutate saved state', async t => {
  const { file } = temporarySettings(t);
  const storage = createStorage(file, { onChanged(changes) { changes.tasks.newValue[0].sku = 'listener changed'; } });
  const input = { tasks: [{ sku: 'original' }] };
  const saved = storage.set(input);
  input.tasks[0].sku = 'caller changed';
  await saved;
  const result = await storage.get();
  result.tasks[0].sku = 'read changed';
  const snapshot = storage.snapshot();
  snapshot.tasks[0].sku = 'snapshot changed';
  assert.deepEqual(await storage.get('tasks'), { tasks: [{ sku: 'original' }] });
  assert.deepEqual(createStorage(file).snapshot(), { tasks: [{ sku: 'original' }] });
});

test('notifications occur after durable writes with old/new values and local area', async t => {
  const { file } = temporarySettings(t);
  const events = [];
  const storage = createStorage(file, { onChanged(changes, area) {
    events.push({ changes, area, disk: JSON.parse(fs.readFileSync(file, 'utf8')) });
  } });
  await storage.set({ interval: 60 });
  await storage.set({ interval: 120 });
  await storage.set({ interval: 120 });
  assert.deepEqual(events, [
    { changes: { interval: { newValue: 60 } }, area: 'local', disk: { interval: 60 } },
    { changes: { interval: { oldValue: 60, newValue: 120 } }, area: 'local', disk: { interval: 120 } }
  ]);
});

test('damaged, non-object and invalid numeric settings are preserved with no secret leakage', t => {
  const { file, directory } = temporarySettings(t);
  for (const text of ['{"barkKey":"private-secret",oops', '[]', 'null', '{"bad":1e400}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => createStorage(file), error => {
      assert.equal(error.code, 'STORAGE_INVALID_JSON');
      assert.match(error.message, /原文件已保留/);
      assert.doesNotMatch(error.message, /private-secret/);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
  }
});

test('prototype-like keys remain normal own properties through persistence and defaults', async t => {
  const { file } = temporarySettings(t);
  const storage = createStorage(file);
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"flag":true}},"nested":{"__proto__":"safe"}}');
  await storage.set(input);
  assert.deepEqual(storage.snapshot(), input);
  assert.deepEqual(createStorage(file).snapshot(), input);
  assert.equal(Object.hasOwn(await storage.get('__proto__'), '__proto__'), true);
  assert.deepEqual(await storage.get(JSON.parse('{"__proto__":null,"unknown":false}')), JSON.parse('{"__proto__":{"polluted":true},"unknown":false}'));
  assert.equal({}.polluted, undefined);
  assert.equal({}.flag, undefined);
});

test('invalid JSON values are rejected before a write and do not poison later saves', async t => {
  const { file } = temporarySettings(t);
  const storage = createStorage(file);
  const cyclic = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('must not evaluate'); } });
  for (const invalid of [undefined, null, [], { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: new Date() }, { value: () => {} }, cyclic, getter]) {
    await assert.rejects(storage.set(invalid), TypeError);
  }
  assert.equal(fs.existsSync(file), false);
  await storage.set({ valid: [false, null, 0, 'text'] });
  assert.deepEqual(createStorage(file).snapshot(), { valid: [false, null, 0, 'text'] });
});

test('failed atomic replacement preserves the previous file, state and queue usability', async t => {
  const { file, directory } = temporarySettings(t);
  const notifications = [];
  const storage = createStorage(file, { onChanged: changes => notifications.push(changes) });
  await storage.set({ interval: 60, barkKey: 'private-secret' });
  const before = fs.readFileSync(file, 'utf8');
  const originalRename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (source, destination) => {
    if (destination === file) throw Object.assign(new Error('injected failure'), { code: 'EACCES' });
    return originalRename(source, destination);
  });
  await assert.rejects(storage.set({ interval: 120 }), { code: 'STORAGE_WRITE_FAILED', systemCode: 'EACCES' });
  await assert.rejects(storage.flush(), { code: 'STORAGE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(await storage.get('interval'), { interval: 60 });
  assert.equal(notifications.length, 1);
  assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
  t.mock.restoreAll();
  await storage.set({ interval: 180 });
  await storage.flush();
  assert.deepEqual(createStorage(file).snapshot(), { interval: 180, barkKey: 'private-secret' });
});

test('change listener errors cannot fail a saved value or subsequent saves', async t => {
  const { file } = temporarySettings(t);
  let calls = 0;
  const storage = createStorage(file, { onChanged() {
    calls += 1;
    if (calls === 1) throw new Error('listener failed');
    return Promise.reject(new Error('async listener failed'));
  } });
  await storage.set({ interval: 60 });
  await storage.set({ interval: 120 });
  await storage.flush();
  assert.equal(createStorage(file).snapshot().interval, 120);
});
