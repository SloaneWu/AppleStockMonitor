import test from 'node:test';
import assert from 'node:assert/strict';
const fake = await import(process.env.TEST_IDB_MODULE || 'fake-indexeddb');
globalThis.indexedDB = new fake.IDBFactory();
globalThis.IDBKeyRange = fake.IDBKeyRange;

test('v2 atomically migrates old v1 history, retaining original ids and check rows', async () => {
  const old = await new Promise((resolve, reject) => {
    const request = indexedDB.open('apple-hk-inventory-history', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('checks', { keyPath: 'id', autoIncrement: true }).createIndex('changes', 'changeKey');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise((resolve, reject) => {
    const tx = old.transaction('checks', 'readwrite');
    tx.objectStore('checks').add({ changed: false, changeKey: 0, status: '无货', checkedAt: '2026-09-20T00:00:00Z' });
    tx.objectStore('checks').add({ changed: true, changeKey: 1, status: '有货', checkedAt: '2026-09-20T00:01:00Z' });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  old.close();
  const history = await import('./history.js');
  const all = await history.readHistory();
  assert.equal(all.total, 2);
  const changes = await history.readHistory({ mode: 'changes' });
  assert.equal(changes.total, 1);
  assert.equal(changes.items[0].id, 2);
  await history.appendHistory([{ changed: true, status: '无货', checkedAt: '2026-09-20T00:02:00Z' }]);
  assert.equal((await history.readHistory({ mode: 'changes' })).items[0].id, 3);
  assert.equal((await history.readHistory()).total, 3);
  (await history.openHistory()).close();
});
