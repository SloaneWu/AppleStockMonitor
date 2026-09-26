import test from 'node:test';
import assert from 'node:assert/strict';
const fake = await import(process.env.TEST_IDB_MODULE || 'fake-indexeddb');
globalThis.indexedDB = fake.indexedDB;
globalThis.IDBKeyRange = fake.IDBKeyRange;
const { appendHistory, readHistory, exportHistory, historyCSV, openHistory, HISTORY_LIMIT } = await import('./history.js');

test('persists attempts and filters real stock changes with stable pagination', async () => {
  await appendHistory([
    { checkedAt: '2026-09-20T13:00:00Z', status: '无货', changed: false },
    { checkedAt: '2026-09-20T13:01:00Z', status: '查询异常', changed: false },
    { checkedAt: '2026-09-20T13:02:00Z', status: '有货', changed: true }
  ]);
  const latest = await readHistory({ limit: 1 });
  assert.equal(latest.total, 3);
  assert.equal(latest.items[0].status, '有货');
  assert.equal((await readHistory({ offset: 1, limit: 1 })).items[0].status, '查询异常');
  const changes = await readHistory({ mode: 'changes' });
  assert.equal(changes.total, 1);
  assert.equal(changes.items[0].status, '有货');
  assert.equal((await readHistory({ offset: 1000 })).items.length, 0);
  // A fresh module instance reconnects to the same database after worker restart.
  const restarted = await import('./history.js?restart-test');
  assert.equal((await restarted.readHistory()).total, 3);
  (await restarted.openHistory()).close();
  const csv = await exportHistory('changes');
  assert.match(csv, /有货/);
  assert.doesNotMatch(csv, /查询异常/);
  assert.ok(csv.startsWith('\uFEFF'));
});

test('CSV quotes commas/newlines and neutralizes spreadsheet formulas', () => {
  const csv = historyCSV([{ checkedAt: '2026-09-20T13:00:00Z', storeName: '=HYPERLINK("x")', detail: 'a,b\nc', changed: false }]);
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(csv.includes('"a,b\nc"'));
  assert.ok(csv.includes('21:00:00'));
});

test('pruning 100000 checks preserves older changes in the separate archive', async () => {
  const rows = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
    checkedAt: '2026-09-20T13:00:00Z', status: '无货', changed: index === HISTORY_LIMIT - 1
  }));
  await appendHistory(rows);
  const result = await readHistory({ limit: 2 });
  assert.equal(result.total, HISTORY_LIMIT);
  assert.equal(result.items[0].id, HISTORY_LIMIT + 3);
  assert.equal(result.items[0].changed, true);
  const changes = await readHistory({ mode: 'changes' });
  assert.equal(changes.total, 2);
  assert.equal(changes.items[1].id, 3);
  (await openHistory()).close();
});
