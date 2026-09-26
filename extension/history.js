// Local IndexedDB history. No cookies, response bodies or account details stored.
export const HISTORY_LIMIT = 100000;
export const CHANGE_LIMIT = 50000;
let dbPromise;

export function openHistory() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('apple-hk-inventory-history', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('checks')) {
        const store = db.createObjectStore('checks', { keyPath: 'id', autoIncrement: true });
        store.createIndex('changes', 'changeKey');
      }
      if (!db.objectStoreNames.contains('changeArchive')) {
        const archive = db.createObjectStore('changeArchive', { keyPath: 'id', autoIncrement: true });
        // The upgrade transaction is atomic; interrupted upgrades cannot partly
        // import or duplicate the old change history.
        const cursorRequest = request.transaction.objectStore('checks').index('changes').openCursor(IDBKeyRange.only(1), 'prev');
        let count = 0;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || count++ >= CHANGE_LIMIT) return;
          archive.put(cursor.value);
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); dbPromise = null; };
      resolve(request.result);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

function completed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('历史记录写入失败'));
    tx.onabort = () => reject(tx.error || new Error('历史记录事务已取消'));
  });
}

export async function appendHistory(rows) {
  if (!rows.length) return;
  const db = await openHistory();
  const tx = db.transaction(['checks', 'changeArchive'], 'readwrite');
  const done = completed(tx);
  const store = tx.objectStore('checks');
  const archive = tx.objectStore('changeArchive');
  for (const row of rows) {
    const value = { ...row, changeKey: row.changed ? 1 : 0 };
    delete value.id;
    const insert = store.add(value);
    if (row.changed) insert.onsuccess = () => archive.put({ ...value, id: insert.result });
  }
  trimStore(store, HISTORY_LIMIT);
  // Added change rows are queued by insert callbacks, so trim only after those
  // callbacks have run. This count request follows every checks.add request.
  const tail = store.count();
  tail.onsuccess = () => trimStore(archive, CHANGE_LIMIT);
  await done;
}

function trimStore(store, limit) {
  const countRequest = store.count();
  countRequest.onsuccess = () => {
    let excess = countRequest.result - limit;
    if (excess <= 0) return;
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor && excess-- > 0) { cursor.delete(); cursor.continue(); }
    };
  };
}

export async function readHistory({ mode = 'all', offset = 0, limit = 50 } = {}) {
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  limit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)));
  const db = await openHistory();
  const storeName = mode === 'changes' ? 'changeArchive' : 'checks';
  const tx = db.transaction(storeName, 'readonly');
  const done = completed(tx);
  const source = tx.objectStore(storeName);
  const range = null;
  const countRequest = source.count(range);
  const cursorRequest = source.openCursor(range, 'prev');
  const items = [];
  let skipped = false;
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor || items.length >= limit) return;
    if (offset && !skipped) { skipped = true; cursor.advance(offset); return; }
    items.push(cursor.value);
    if (items.length < limit) cursor.continue();
  };
  await done;
  return { items, total: countRequest.result };
}

export function historyCSV(rows) {
  const headers = ['时间（香港）', '门店', '型号', '容量', '颜色', 'SKU', '状态', '详情', 'HTTP', '库存变化', '上次有效状态'];
  const quote = (value) => {
    let text = String(value ?? '');
    // Prevent spreadsheet formula execution when exporting upstream text.
    if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const lines = rows.map(row => [
    new Date(row.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false }),
    row.storeName, row.model, row.capacity, row.color, row.sku, row.status, row.detail,
    row.httpStatus || '', row.changed ? '是' : '否', row.previousStatus || ''
  ]);
  return '\uFEFF' + [headers, ...lines].map(row => row.map(quote).join(',')).join('\r\n');
}

export async function exportHistory(mode = 'all') {
  const db = await openHistory();
  const storeName = mode === 'changes' ? 'changeArchive' : 'checks';
  const tx = db.transaction(storeName, 'readonly');
  const done = completed(tx);
  const request = tx.objectStore(storeName).getAll();
  await done;
  return historyCSV(request.result.reverse());
}
