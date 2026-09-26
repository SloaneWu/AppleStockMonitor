import { DEFAULT_PURCHASE_SETTINGS, TERMINAL_PURCHASE_STATUSES, validatePurchaseSettings, purchaseURL, chooseAvailableTask, checkProductSnapshot, verifyAddedBag, priceNumber } from './purchase-core.js';

const BAG = 'https://www.apple.com/hk-zh/shop/bag';
const clone = value => structuredClone(value);
const isHK = url => { try { const u = new URL(url); return u.origin === 'https://www.apple.com' && /^\/hk(?:-zh)?\/shop\//.test(u.pathname); } catch { return false; } };

export function createPurchaseManager({ api, getProduct, onEvent = async () => {} }) {
  let queue = Promise.resolve();
  let executingSku = '';
  let pendingAvailability = 0;
  const serialize = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  async function getSettings() {
    const { purchaseSettings, purchaseOperations = [], purchaseLocks = {} } = await api.storage.local.get(['purchaseSettings', 'purchaseOperations', 'purchaseLocks']);
    return { ok: true, settings: clone(purchaseSettings || DEFAULT_PURCHASE_SETTINGS), operations: clone(purchaseOperations), locks: clone(purchaseLocks) };
  }
  async function saveSettings(input) {
    const product = input?.sku ? await getProduct(input.sku) : null;
    const settings = validatePurchaseSettings(input, product);
    await api.storage.local.set({ purchaseSettings: settings });
    return getSettings();
  }
  async function record(operation, status, detail) {
    const event = { ...operation, at: new Date().toISOString(), status, detail };
    const { purchaseLocks = {}, purchaseOperations = [] } = await api.storage.local.get(['purchaseLocks', 'purchaseOperations']);
    await api.storage.local.set({ purchaseLocks: { ...purchaseLocks, [event.sku]: event }, purchaseOperations: [...purchaseOperations, event].slice(-100) });
    if (TERMINAL_PURCHASE_STATUSES.includes(status)) { try { await onEvent(clone(event)); } catch {} }
    return event;
  }
  async function restore() {
    return serialize(async () => {
      const { locks } = await getSettings();
      for (const lock of Object.values(locks)) if (lock?.sku && !TERMINAL_PURCHASE_STATUSES.includes(lock.status)) {
        await record(lock, 'needs-user', '上次操作在后台重启前未完成；结果可能不确定。请检查购物袋，自动操作不会重试。');
      }
      return getSettings();
    });
  }
  async function reset(sku) {
    if (executingSku || pendingAvailability) throw new Error('自动加袋正在处理，请等待本次操作结束后再重置');
    return serialize(async () => {
      if (!/^[A-Z0-9]+ZA\/A$/.test(sku || '')) throw new Error('重置 SKU 无效');
      const { purchaseLocks = {} } = await api.storage.local.get('purchaseLocks');
      delete purchaseLocks[sku];
      await api.storage.local.set({ purchaseLocks });
      return getSettings();
    });
  }
  async function readyTab(id) {
    const first = await api.tabs.get(id);
    if (!isHK(first.pendingUrl || first.url)) throw new Error('页面已跳到登录、验证或非香港购买页，请手动继续');
    if (first.status === 'complete') return first;
    return new Promise((resolve, reject) => {
      const finish = (error, tab) => { clearTimeout(timer); api.tabs.onUpdated.removeListener(listener); error ? reject(error) : resolve(tab); };
      const inspect = async () => { try {
        const tab = await api.tabs.get(id);
        if (!isHK(tab.pendingUrl || tab.url)) finish(new Error('页面跳转到其他地区或登录页面，已停止'));
        else if (tab.status === 'complete') finish(null, tab);
      } catch { finish(new Error('购买标签页已关闭或无法访问')); } };
      const listener = tabId => { if (tabId === id) void inspect(); };
      const timer = setTimeout(() => finish(new Error('页面加载超时，结果需人工检查')), 20000);
      api.tabs.onUpdated.addListener(listener);
      void inspect();
    });
  }
  async function askPage(id, type, expected, beforeSend) {
    await readyTab(id);
    await api.scripting.executeScript({ target: { tabId: id }, files: ['purchase-page.js'] });
    // Loading and injection can take time. Re-read consent after those waits,
    // immediately before asking the page to perform the one irreversible click.
    if (beforeSend) await beforeSend();
    let timer;
    try {
      return await Promise.race([
        api.tabs.sendMessage(id, { type, expected }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('网页操作未返回明确结果，请人工检查；不会自动重试')), 25000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function stillAuthorized(settings) {
    const latest = (await getSettings()).settings;
    if (!latest.enabled || JSON.stringify(latest) !== JSON.stringify(settings)) throw new Error('自动加袋设置已改变或关闭，已停止本次操作');
  }
  function observeClickNavigation(id) {
    let timer, started = false, finish;
    const promise = new Promise((resolve, reject) => {
      finish = error => { clearTimeout(timer); api.tabs.onUpdated.removeListener(listener); error ? reject(error) : resolve(); };
      const listener = (tabId, change) => {
        if (tabId !== id) return;
        if (change.status === 'loading') started = true;
        if (started && change.status === 'complete') finish();
      };
      api.tabs.onUpdated.addListener(listener);
      timer = setTimeout(() => finish(new Error('加袋后页面未明确完成跳转，结果需人工检查；不会重复点击')), 20000);
    });
    promise.catch(() => {});
    return { promise, cancel: () => finish() };
  }
  async function execute(tasks, checkedAt) {
    const saved = await getSettings();
    if (!saved.settings.enabled) return saved;
    const product = await getProduct(saved.settings.sku);
    const settings = validatePurchaseSettings(saved.settings, product);
    const task = chooseAvailableTask(tasks, settings);
    if (!task || saved.locks[settings.sku]) return saved;
    const preorderAt = product.PreorderAt ? Date.parse(product.PreorderAt) : 0;
    if (product.PreorderAt && (!Number.isFinite(preorderAt) || preorderAt > Date.now())) return saved;
    // This durable reservation precedes even opening a tab. A reload, timeout,
    // another available store or a second inventory tick cannot repeat a click.
    let operation = { sku: settings.sku, storeNumber: task.store.StoreNumber, storeName: task.store.StoreName || task.store.StoreNumber, checkedAt, url: purchaseURL(product), quantity: 1, maxPrice: settings.maxPrice };
    operation = await record(operation, 'opening', '检测到指定门店有货，准备检查购物袋；门店与付款仍需本人最终确认。');
    executingSku = settings.sku;
    try {
      await stillAuthorized(settings);
      const tab = await api.tabs.create({ url: BAG, active: true });
      operation.tabId = tab.id;
      const before = await askPage(tab.id, 'purchase-inspect-bag');
      if (!before?.verified || before.kind !== 'bag' || !before.empty || before.items?.length !== 0) {
        throw new Error(before?.detail || '现有购物袋不是可确认的空袋；为避免改动原有商品，请手动检查');
      }
      await api.tabs.update(tab.id, { url: operation.url, active: true });
      operation = await record(operation, 'checking', '正在核对官网 SKU、价格与数量。');
      const expected = { sku: product.Code, model: product.Model, capacity: product.Capacity, color: product.Color, price: priceNumber(product.Price), maxPrice: settings.maxPrice, quantity: 1 };
      const snapshot = await askPage(tab.id, 'purchase-inspect-product', expected);
      checkProductSnapshot(snapshot, product, settings);
      await stillAuthorized(settings);
      operation = await record(operation, 'adding', '已核对商品，准备点击一次加入购物袋；尚未确认成功。');
      const navigation = observeClickNavigation(tab.id);
      try {
        const clicked = await askPage(tab.id, 'purchase-add-once', expected, () => stillAuthorized(settings));
        if (clicked?.clicked !== true) throw new Error(clicked?.detail || '未收到明确的加袋操作结果，请检查购物袋');
        await navigation.promise;
      } finally { navigation.cancel(); }
      // The click alone is never success. Visit the bag after the normal page
      // navigation settles and verify exactly one matching item.
      await readyTab(tab.id);
      await api.tabs.update(tab.id, { url: BAG, active: true });
      const after = await askPage(tab.id, 'purchase-inspect-bag');
      if (!verifyAddedBag(after, product, settings)) throw new Error('已尝试加袋，但购物袋未能核实准确 SKU、单件数量与价格。请人工检查，自动操作不会重试。');
      await record(operation, 'added', '购物袋已核实：指定 SKU、数量 1、价格在上限内。请手动确认最终提取门店、配送及付款；尚未下单。');
    } catch (error) {
      await record(operation, 'needs-user', (error?.message || '操作结果不确定，请人工检查购物袋').slice(0, 600));
    } finally { executingSku = ''; }
    return getSettings();
  }
  function onAvailability(tasks, checkedAt) {
    // Reserve synchronously, before execute's first storage read. Otherwise a
    // reset queued in this gap could erase the new lock after the click ends.
    pendingAvailability++;
    return serialize(() => execute(tasks, checkedAt)).finally(() => { pendingAvailability--; });
  }
  return { getSettings, saveSettings, reset, restore, onAvailability };
}
