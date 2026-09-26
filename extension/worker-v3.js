import { buildFulfillmentPath, productPurchaseURL } from './shared.js';
import { appendHistory, readHistory, exportHistory } from './history.js';
import { groupTasks, retryDelay, classifyResponse, recordOutcome } from './monitor-core.js';
import { parseBarkKey, stockBarkMessages, sendBark } from './bark.js';
import { LEASE_MS, BOOST_MS, REQUEST_BUDGET, budgetValue, budgetReadyAt, spendBudget, settingsValue, intervalForSku, keyForTask, availableFrom, dueAt, nextDue, migrateState, restoreItems, isStockPage, safeDiagnostic, requiresManualRecovery } from './scheduler.js';
import { createNotificationQueue } from './notification-queue.js';
import { createPurchaseManager } from './purchase.js';

const api = chrome;
const ALARM = 'apple-hk-stock-check';
const DASHBOARD = api.runtime.getURL('app.html');
const KEYS = ['tasks', 'monitoring', 'monitorState', 'monitorSettings', 'skuCooldowns', 'stockMemory', 'connectionHealth', 'inflight', 'ownedMonitorTab', 'requestBudget'];
const MANUAL_RECOVERY_MESSAGE = api.desktop
  ? '官网查询受阻，监控已暂停。请打开程序内的官网并查询附近门店，再点击“连接官网，单次验证”；冷却结束不会自动重试。'
  : '官网查询受阻，监控已暂停。请先确认官网附近门店查询恢复，再使用“官网恢复后，单次验证”；冷却结束不会自动重试。';
let currentCheck, revision = 0, barkTestInFlight = false, catalogPromise;
let diagnosticUpdates = Promise.resolve();
const queue = createNotificationQueue(api);
const purchase = createPurchaseManager({ api, getProduct: async code => (await catalog()).products.find(p => p.Code === code),
  onEvent: async operation => queue.enqueue([{ title: operation.status === 'added' ? '已加入购物袋，等待确认' : '购买操作需要查看',
    body: `${operation.sku}\n${operation.detail}\n请在运行插件的电脑浏览器中继续，尚未付款。`, url: 'https://www.apple.com/hk-zh/shop/bag' }], 'purchase:' + operation.sku + ':' + operation.at + ':' + operation.status) });
const ready = initialize();
ready.catch(() => {});

api.runtime.onInstalled.addListener(() => ready.then(openDashboard).catch(reportError));
api.runtime.onStartup.addListener(() => ready.then(ensureSchedule).catch(reportError));
api.action.onClicked.addListener(() => ready.then(openDashboard).catch(reportError));
api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) { void runStockCheck(false).catch(reportError); void ready.then(queue.drain).catch(() => {}); }
});
api.notifications.onClicked.addListener(async id => {
  if (!id.startsWith('stock:')) return;
  const { tasks = [] } = await api.storage.local.get('tasks');
  const task = tasks.find(t => t.id === id.slice(6));
  if (task) await api.tabs.create({ url: productPurchaseURL(task), active: true });
});
api.runtime.onMessage.addListener((message, sender, reply) => {
  if (!isDashboard(sender)) return false;
  ready.then(() => handleMessage(message)).then(reply).catch(error => reply({ ok: false, error: error.message || '操作失败，请重试' }));
  return true;
});

function isDashboard(sender) {
  if (sender?.id !== api.runtime.id) return false;
  try { const actual = new URL(sender.url), expected = new URL(DASHBOARD);
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
  } catch { return false; }
}
function initialState() { return { running: false, checking: false, items: {}, log: [], nextCheck: '', notBefore: '' }; }
function addLog(state, message) {
  state.log = [...state.log || [], { time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false }), message }].slice(-100);
}
function catalog() {
  if (!catalogPromise) catalogPromise = Promise.all([
    fetch(api.runtime.getURL('data/products/product_data_hk.json')).then(r => r.json()),
    fetch(api.runtime.getURL('data/stores/store_hk.json')).then(r => r.json())
  ]).then(([p, s]) => ({ products: Object.values(p.products).flat(), stores: s.stores })).catch(error => { catalogPromise = null; throw error; });
  return catalogPromise;
}
async function validateTasks(input) {
  const { products, stores } = await catalog();
  if (!Array.isArray(input) || input.length > products.length * stores.length) throw new Error('监控任务数量超出内置型号与门店范围');
  const pairs = new Set(), ids = new Set();
  return input.map(task => {
    const product = products.find(p => p.Code === task?.product?.Code), store = stores.find(s => s.StoreNumber === task?.store?.StoreNumber);
    if (task?.areaCode !== 'hk' || !product || !store || !/^[a-zA-Z0-9-]{1,80}$/.test(task?.id || '')) throw new Error('任务型号或门店无效，请检查目录');
    const key = product.Code + '|' + store.StoreNumber;
    if (pairs.has(key) || ids.has(task.id)) throw new Error('监控任务重复');
    pairs.add(key); ids.add(task.id);
    return { id: task.id, areaCode: 'hk', areaTitle: '香港', product, store };
  });
}
async function initialize() {
  if (!api.storage.local.setAccessLevel) throw new Error('请使用 Chrome / Edge 120 或更新版本');
  await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await api.storage.local.get([...KEYS, 'cooldowns', 'schedulerVersion']);
  const migrated = migrateState(saved);
  const state = saved.monitorState || initialState();
  state.checking = false;
  state.running = Boolean(saved.monitoring);
  state.items = restoreItems(saved.tasks || [], migrated.stockMemory);
  const inflight = Number(saved.inflight?.until) > Date.now() ? saved.inflight : null;
  if (inflight) addLog(state, '上次后台检查中断，保留任务并等待在途请求到期，避免重复查询。');
  const legacyDeadline = Math.max(0, ...Object.values(migrated.skuCooldowns).filter(item => item.failures > 0).map(item => Number(item.nextAt) || 0));
  const legacyBlocked = Object.values(state.items).some(item => [401, 403, 429, 541].includes(item.httpStatus));
  let health = saved.connectionHealth || (legacyDeadline > Date.now()
    ? { state: legacyBlocked ? 'needs-user' : 'cooldown', message: '已保留旧版的故障等待时间；到期后继续检查，任务无需重加。', notBefore: legacyDeadline,
      failures: Math.max(1, ...Object.values(migrated.skuCooldowns).map(item => Number(item.failures) || 0)), recoveryPending: legacyBlocked }
    : { state: 'unverified', message: '等待首次有效库存响应', notBefore: 0 });
  // An expired retry deadline is not proof that Apple's service/session recovered.
  // Migrate old automatic-reload incidents into the same durable manual hold.
  if (requiresManualRecovery(health) || (!saved.connectionHealth && legacyBlocked)
      || health.state === 'recovering'
      || (health.state !== 'healthy' && (health.firstFailureAt && health.reloadedForIncident
        || [401, 403, 429, 541].includes(health.lastStatus)))) {
    health = { ...health, state: 'needs-user', manualRecoveryRequired: true, recoveryPending: false,
      notBefore: Math.max(Number(health.notBefore) || 0, legacyDeadline), message: health.desktopPreparation ? health.message : MANUAL_RECOVERY_MESSAGE };
    state.running = false;
  }
  await api.storage.local.set({ ...migrated, inflight, monitorState: state, monitorSettings: settingsValue(saved.monitorSettings),
    connectionHealth: health, monitoring: requiresManualRecovery(health) ? false : Boolean(saved.monitoring) });
  await queue.restore();
  // A worker can be suspended after an event is durably queued. Drain it on
  // the next startup even when monitoring is paused; the queue itself applies
  // the Bark opt-in and at-most-once rules.
  void queue.drain().catch(() => {});
  await purchase.restore();
  await ensureSchedule();
  await publishState();
}
async function ensureSchedule() {
  const saved = await api.storage.local.get(['monitoring', 'connectionHealth']);
  const monitoring = saved.monitoring && !requiresManualRecovery(saved.connectionHealth);
  const alarm = await api.alarms.get(ALARM);
  if (monitoring && alarm?.periodInMinutes !== 0.5) await api.alarms.create(ALARM, { periodInMinutes: 0.5 });
  if (!monitoring && alarm) await api.alarms.clear(ALARM);
}
async function publishState(changes = {}) {
  const saved = await api.storage.local.get(KEYS);
  const state = { ...saved.monitorState || initialState(), ...changes, running: Boolean(saved.monitoring) };
  const next = nextDue(saved.tasks || [], saved);
  state.notBefore = next > Date.now() ? new Date(next).toISOString() : '';
  state.nextCheck = saved.monitoring && next ? new Date(Math.max(next, Date.now())).toISOString() : '';
  const budgetWait = budgetReadyAt(saved);
  state.budgetWaitUntil = budgetWait ? new Date(budgetWait).toISOString() : '';
  await api.storage.local.set({ monitorState: state });
  return state;
}
function diagnose(result, extra) {
  const row = safeDiagnostic(result, extra);
  const run = diagnosticUpdates.then(async () => {
    const { diagnostics = [] } = await api.storage.local.get('diagnostics');
    await api.storage.local.set({ diagnostics: [...diagnostics, row].slice(-3000) });
  });
  diagnosticUpdates = run.catch(() => {});
  return run;
}
async function settingsResult() { const { monitorSettings } = await api.storage.local.get('monitorSettings'); return { ok: true, settings: settingsValue(monitorSettings) }; }
async function barkSettings() {
  const { barkConfig = {}, barkStatus = null } = await api.storage.local.get(['barkConfig', 'barkStatus']);
  return { ok: true, enabled: Boolean(barkConfig.enabled), configured: Boolean(barkConfig.key), lastResult: barkStatus };
}
async function handleMessage(message) {
  switch (message?.type) {
    case 'get-monitor-settings': return settingsResult();
    case 'save-monitor-settings': {
      if (![10, 20, 60].includes(message.intervalSeconds)) throw new Error('检查间隔仅支持 10、20 或 60 秒');
      const { products } = await catalog();
      const focusSkus = [...new Set(message.focusSkus || [])];
      if (focusSkus.length > 8 || focusSkus.some(code => !products.some(p => p.Code === code))) throw new Error('最多选择 8 款有效商品加速');
      await api.storage.local.set({ monitorSettings: { intervalSeconds: message.intervalSeconds === 60 ? 60 : 20,
        boostUntil: message.intervalSeconds === 10 ? Date.now() + BOOST_MS : 0, focusSkus } });
      await publishState(); return settingsResult();
    }
    case 'get-purchase-settings': return purchase.getSettings();
    case 'save-purchase-settings': return purchase.saveSettings(message.settings);
    case 'reset-purchase': return purchase.reset(message.sku);
    case 'get-bark-settings': return barkSettings();
    case 'save-bark-settings': {
      const { barkConfig = {} } = await api.storage.local.get('barkConfig');
      const key = String(message.url || '').trim() ? parseBarkKey(message.url) : barkConfig.key || '';
      if (message.enabled && !key) throw new Error('请先填写 Bark 设备地址或密钥');
      await api.storage.local.set({ barkConfig: { enabled: message.enabled === true, key }, barkStatus: null });
      return barkSettings();
    }
    case 'clear-bark-settings':
      await api.storage.local.set({ barkConfig: { enabled: false, key: '' }, barkStatus: null, notificationQueue: [] }); return barkSettings();
    case 'test-bark': {
      if (barkTestInFlight) throw new Error('测试通知正在发送');
      const { barkConfig = {}, barkTestAt = 0 } = await api.storage.local.get(['barkConfig', 'barkTestAt']);
      if (!barkConfig.key) throw new Error('请先保存 Bark 设置');
      if (Date.now() - barkTestAt < 10000) throw new Error('请等待 10 秒后重试测试通知');
      barkTestInFlight = true;
      try {
        await api.storage.local.set({ barkTestAt: Date.now() });
        const result = await sendBark(barkConfig.key, { title: 'Apple 库存监控 · 测试通知', body: '手机收到此消息后，可确认 Bark 通道有效。' });
        await api.storage.local.set({ barkStatus: { ...result, at: new Date().toISOString() } });
        if (!result.ok) throw new Error(result.message);
        return { ok: true, message: result.message };
      } finally { barkTestInFlight = false; }
    }
    case 'get-history': return { ok: true, ...await readHistory(message) };
    case 'export-history': return { ok: true, csv: await exportHistory(message.mode) };
    case 'export-diagnostics': {
      const { diagnostics = [], connectionHealth = {}, monitorSettings = {}, requestBudget } = await api.storage.local.get(['diagnostics', 'connectionHealth', 'monitorSettings', 'requestBudget']);
      return { ok: true, json: JSON.stringify({ version: api.runtime.getManifest().version, exportedAt: new Date().toISOString(),
        diagnostics, connectionHealth, monitorSettings: settingsValue(monitorSettings),
        requestBudget: { ...REQUEST_BUDGET, ...budgetValue({ requestBudget }) }, note: '无 Cookie、Bark 密钥或原始响应内容。' }, null, 2) };
    }
    case 'save-tasks': {
      if (currentCheck) throw new Error('请暂停并等待当前操作结束后修改任务');
      return withCheckLock(async () => {
        const saved = await api.storage.local.get(KEYS);
        if (saved.monitoring) throw new Error('请暂停并等待本次检查结束后修改任务');
        const tasks = await validateTasks(message.tasks);
        await api.storage.local.set({ tasks });
        await publishState({ items: restoreItems(tasks, saved.stockMemory || {}) });
        return { ok: true };
      });
    }
    case 'start-monitor': {
      if (currentCheck) throw new Error('当前操作尚未结束');
      const startRevision = revision;
      return withCheckLock(async () => {
        try {
          const tasks = await validateTasks(message.tasks);
          if (!tasks.length) throw new Error('请先添加监控任务');
          if (revision !== startRevision) return { ok: true, cancelled: true };
          const { stockMemory = {}, connectionHealth } = await api.storage.local.get(['stockMemory', 'connectionHealth']);
          if (requiresManualRecovery(connectionHealth)) throw new Error(connectionHealth.desktopPreparation ? connectionHealth.message : MANUAL_RECOVERY_MESSAGE);
          if (revision !== startRevision) return { ok: true, cancelled: true };
          await api.storage.local.set({ tasks, monitoring: true });
          if (revision !== startRevision) return { ok: true, cancelled: true };
          const state = await publishState({ checking: false, items: restoreItems(tasks, stockMemory) });
          addLog(state, api.desktop ? '开始监控。桌面程序独立调度，最小化后继续检查；退出程序或电脑休眠会停止查询，实际间隔以记录为准。'
            : '开始监控。短周期需要面板可见；后台使用 30 秒定时兜底，实际间隔以记录为准。');
          await api.storage.local.set({ monitorState: state });
          await ensureSchedule();
          return await performStockCheck(false, startRevision);
        } finally {
          // Pause can arrive during any browser API await in the preparation.
          // Commit the cancellation after preparation so no stale write revives it.
          if (revision !== startRevision) {
            await api.storage.local.set({ monitoring: false });
            await ensureSchedule();
            await publishState({ checking: false });
          }
        }
      });
    }
    case 'stop-monitor': {
      revision++;
      await api.storage.local.set({ monitoring: false });
      await api.alarms.clear(ALARM); await publishState(); return { ok: true };
    }
    case 'reset-apple-session': return resetAppleSession();
    case 'check-now': return runStockCheck(true);
    case 'scheduler-pulse': return runStockCheck(false);
    case 'reconnect': return reconnect();
    case 'open-product': {
      const [task] = await validateTasks([message.task]);
      await api.tabs.create({ url: productPurchaseURL(task), active: true }); return { ok: true };
    }
    default: throw new Error('未知操作');
  }
}

// True when the shared request budget, not a SKU interval or cooldown, is what delays the earliest check.
function budgetLimits(tasks, saved, now = Date.now()) {
  const wait = budgetReadyAt(saved, now);
  return Boolean(wait) && tasks.length > 0 && wait >= Math.min(...tasks.map(task => dueAt(task, saved, now)));
}
function budgetMessage(readyAt, now = Date.now()) {
  return `已达到连续查询上限：为避免官网会话被拒，程序限制短时间内的查询次数，约 ${Math.ceil((readyAt - now) / 1000)} 秒后可再查询；无需删除监控。`;
}
function runStockCheck(manual) {
  const startRevision = revision;
  return withCheckLock(() => performStockCheck(manual, startRevision));
}
function withCheckLock(operation) {
  // Cover preparation, task changes and reconnects as well as the HTTP request.
  // A visible panel pulse must not query while another action reloads its tab.
  if (currentCheck) return currentCheck;
  currentCheck = ready.then(operation).finally(() => { currentCheck = null; });
  return currentCheck;
}
async function performStockCheck(manual, startRevision = revision, manualRecovery = false) {
  if (revision !== startRevision) return { ok: true, cancelled: true };
  let saved = await api.storage.local.get(KEYS);
  if (requiresManualRecovery(saved.connectionHealth) && !manualRecovery) {
    if (manual) throw new Error(saved.connectionHealth.desktopPreparation ? saved.connectionHealth.message : MANUAL_RECOVERY_MESSAGE);
    return { ok: true, manualRecoveryRequired: true };
  }
  if (!manual && !saved.monitoring) return { ok: true };
  if (!saved.tasks?.length) { if (manual) throw new Error('请添加监控任务'); return { ok: true }; }
  const tasks = await validateTasks(saved.tasks), now = Date.now();
  if (saved.inflight && saved.inflight.until <= now) { await api.storage.local.set({ inflight: null }); saved.inflight = null; }
  const due = tasks.filter(task => dueAt(task, saved, now) <= now);
  if (!due.length) {
    if (manual && budgetLimits(tasks, saved, now)) throw new Error(budgetMessage(budgetReadyAt(saved, now), now));
    if (manual && tasks.some(t => availableFrom(t.product) <= now)) throw new Error('正在等待上次请求或官网冷却，请查看最早可检查时间；无需删除监控。');
    return { ok: true };
  }
  await publishState({ checking: true });
  try {
    // Recovery is one bounded probe, never a sweep over every watched SKU.
    const firstDesktopCheck = Boolean(api.desktop?.prepareStockCheck && (manualRecovery || !saved.connectionHealth?.lastSuccessAt));
    const dueSince = Object.fromEntries(Object.entries(saved.skuCooldowns || {}).map(([code, value]) => [code, value?.nextAt]));
    const groups = groupTasks(due, dueSince).slice(0, manualRecovery || firstDesktopCheck ? 1 : undefined);
    if (firstDesktopCheck && groups[0]) groups[0] = groups[0].filter(task => task.product.Code === groups[0][0].product.Code);
    for (const group of groups) {
      if (revision !== startRevision) break;
      saved = await api.storage.local.get(KEYS);
      if (requiresManualRecovery(saved.connectionHealth) && !manualRecovery) break;
      if ((saved.connectionHealth?.notBefore || 0) > Date.now()) break;
      // Remaining batches wait for the shared budget; their SKU deadlines stay due.
      if (budgetReadyAt(saved)) break;
      const started = Date.now(), skus = [...new Set(group.map(t => t.product.Code))];
      const skuCooldowns = saved.skuCooldowns || {};
      const previousCooldowns = { ...skuCooldowns };
      for (const code of skus) skuCooldowns[code] = { ...skuCooldowns[code], nextAt: started + intervalForSku(code, saved.monitorSettings, tasks, started) };
      const lease = { id: String(started) + ':' + skus.join(','), until: started + LEASE_MS, skus };
      // Charge before dispatch so a suspended worker cannot resend for free.
      await api.storage.local.set({ skuCooldowns, inflight: lease, requestBudget: spendBudget(saved, started) });
      if (revision !== startRevision) break;
      let result, tab, stockSent = false;
      try {
        tab = await ensureMonitorTab(group[0], manualRecovery, !manualRecovery);
        await waitForTabReady(tab.id);
        if (revision !== startRevision) break;
        const preparation = api.desktop?.prepareStockCheck ? await api.desktop.prepareStockCheck(tab.id) : { ready: true };
        if (revision !== startRevision) break;
        if (preparation.ready) { stockSent = true; result = await sendStockRequest(tab.id, buildFulfillmentPath(group), startRevision); }
        else result = { status: 0, preparation };
        if (!result) break;
      } catch (error) { result = api.desktop?.prepareStockCheck && !stockSent
        ? { status: 0, preparation: { ready: false, reason: 'page-connection-failed', message: '官网连接尚未完成，未发送库存查询。请打开官网检查页面，加载完成后再单次验证。' } }
        : { status: 0, needsManualTab: error?.code === 'discarded-monitor-tab',
        error: error?.code === 'discarded-monitor-tab' ? '官网标签页已休眠，请先手动打开官网并确认附近门店查询恢复，再执行单次验证。' : '官网页面连接失败，请使用重新连接并检查网站访问权限。',
        diagnosticStage: error?.diagnosticStage || 'page-connection' }; }
      if (result.preparation) {
        // No inventory request was made: preserve inventory/history and remove
        // only this unissued lease. Do not manufacture HTTP 0/541 stock rows.
        const health = { ...saved.connectionHealth, state: 'needs-user', manualRecoveryRequired: true,
          desktopPreparation: true, preparationReason: result.preparation.reason,
          message: result.preparation.message, recoveryPending: false };
        const restoredCooldowns = { ...skuCooldowns };
        for (const code of skus) {
          if (previousCooldowns[code]) restoredCooldowns[code] = previousCooldowns[code];
          else delete restoredCooldowns[code];
        }
        await api.storage.local.set({ monitoring: false, connectionHealth: health, inflight: null, skuCooldowns: restoredCooldowns,
          requestBudget: saved.requestBudget ?? null });
        await ensureSchedule();
        return { ok: false, manualRecoveryRequired: true, error: health.message };
      }
      result.durationMs = Date.now() - started;
      const outcomes = classifyResponse(result, group);
      const failed = outcomes.some(row => !row.known);
      const oldHealth = saved.connectionHealth || {};
      const failures = failed ? (Number(oldHealth.failures) || 0) + 1 : 0;
      const retry = failed ? Date.now() + retryDelay(failures, result.retryAfter) : 0;
      for (const code of skus) skuCooldowns[code] = { failures, nextAt: failed ? retry : skuCooldowns[code].nextAt };
      const blocked = [401, 403, 429, 541].includes(result.status) || result.responseKind === 'html'
        || /^\s*(?:<!doctype\s+html|<html(?:\s|>))/i.test(String(result.body || ''));
      let keepManualHold = (failed && (blocked || manualRecovery || requiresManualRecovery(oldHealth)))
        || (manualRecovery && revision !== startRevision);
      let health = failed ? { ...oldHealth, state: keepManualHold ? 'needs-user' : 'cooldown', failures, notBefore: retry,
        incident: oldHealth.incident || String(started), firstFailureAt: oldHealth.firstFailureAt || new Date(started).toISOString(),
        message: keepManualHold ? (result.needsManualTab ? result.error : `HTTP ${result.status || 0}：${api.desktop && result.status === 541 && !oldHealth.lastSuccessAt ? '本程序首次库存查询即被官网拒绝，尚未取得有效库存。请在官网窗口检查附近门店查询，并导出诊断。' : MANUAL_RECOVERY_MESSAGE}`) : '查询失败，正在等待重试；旧库存不代表当前状态。',
        desktopPreparation: false,
        manualRecoveryRequired: keepManualHold, recoveryPending: false, lastStatus: result.status || 0 }
        : keepManualHold ? { ...oldHealth, state: 'needs-user', manualRecoveryRequired: true, recoveryPending: false,
          message: '单次验证已停止，返回结果已保留；请重新执行单次验证后再开始监控。' }
        : { state: 'healthy', manualRecoveryRequired: false, message: manualRecovery ? '单次验证通过，监控仍暂停；点击开始监控后才会继续查询。' : '已收到有效库存响应', notBefore: 0, failures: 0, lastSuccessAt: new Date().toISOString() };
      // Persist the circuit breaker before optional history I/O. A suspended
      // worker must retain the hold even if IndexedDB never finishes its write.
      if (keepManualHold) {
        await api.storage.local.set({ connectionHealth: health, monitoring: false });
        await ensureSchedule();
      }
      const state = saved.monitorState || initialState(), memory = saved.stockMemory || {};
      const checkedAt = new Date().toISOString(), rows = [], notify = [];
      for (const outcome of outcomes) {
        const key = keyForTask(outcome.task), recorded = recordOutcome(outcome, memory[key], checkedAt);
        memory[key] = recorded.item; rows.push(recorded.row);
        if (recorded.notify) notify.push(outcome.task);
      }
      if (failed) {
        const attempted = new Set(group.map(keyForTask));
        for (const task of tasks) {
          if (attempted.has(keyForTask(task)) || availableFrom(task.product) > Date.now()) continue;
          const key = keyForTask(task);
          memory[key] = { ...memory[key], status: '等待恢复', detail: '官网会话受阻，该项本轮未查询；上次有效状态仅供参考。', lastSuccess: memory[key]?.lastSuccess || null };
        }
      }
      try { await appendHistory(rows); state.historyError = ''; }
      catch { state.historyError = '本机历史写入失败，请导出已有记录并检查浏览器存储。'; }
      state.items = restoreItems(tasks, memory);
      state.lastCheck = checkedAt;
      state.requestDurationMs = result.durationMs;
      state.actualIntervalMs = state.lastRequestAt ? started - Date.parse(state.lastRequestAt) : 0;
      state.lastRequestAt = new Date(started).toISOString();
      if (manualRecovery && revision !== startRevision) {
        keepManualHold = true;
        health = { ...health, state: 'needs-user', manualRecoveryRequired: true, recoveryPending: false,
          message: '单次验证已停止，返回结果已保留；请重新执行单次验证后再开始监控。' };
      }
      addLog(state, failed ? health.message : `已记录 ${rows.length} 项有效库存结果。`);
      await api.storage.local.set({ monitorState: state, skuCooldowns, stockMemory: memory, connectionHealth: health, inflight: null,
        ...((keepManualHold || manualRecovery) ? { monitoring: false } : {}) });
      if (keepManualHold || manualRecovery) await ensureSchedule();
      await diagnose(result, { tabId: tab?.id, skus, waitUntil: retry });
      if (failed && (!oldHealth.firstFailureAt || failures === 2)) {
        await queue.enqueue([{ title: '库存监控暂时无法查询', body: health.message + '\n监控列表和历史已保留。', url: productPurchaseURL(group[0]) }], 'health:' + health.incident);
      } else if (!failed && !keepManualHold && oldHealth.firstFailureAt) {
        await queue.enqueue([{ title: manualRecovery ? '库存查询单次验证通过' : '库存监控已恢复', body: manualRecovery ? '重新取得有效库存响应，监控仍暂停；请在面板中手动开始监控。' : '重新取得有效库存响应，监控列表和历史保持不变。' }], 'recovered:' + oldHealth.incident);
      }
      if (revision === startRevision) {
        if (notify.length) {
          for (const task of notify) void api.notifications.create('stock:' + task.id, { type: 'basic', iconUrl: 'icons/icon128.png', title: task.store.CityStoreName + ' 有货', message: `${task.product.Model} ${task.product.Capacity} ${task.product.Color}` }).catch(() => {});
          await queue.enqueue(stockBarkMessages(notify, checkedAt), 'stock:' + checkedAt + ':' + skus.join(','));
        }
        // Purchase operation has its own persisted lock and never blocks stock cadence.
        if (!failed && !manualRecovery) void purchase.onAvailability(outcomes.filter(o => o.known && o.status === '有货').map(o => o.task), checkedAt).catch(() => {});
      }
      if (failed) break; // One affected session; do not run the remaining batches into the same failure.
    }
  } finally {
    await api.storage.local.set({ inflight: null });
    await publishState({ checking: false });
  }
  return { ok: true };
}

async function ensureMonitorTab(task, active, allowDiscardedReload = true) {
  const { ownedMonitorTab } = await api.storage.local.get('ownedMonitorTab');
  let tab;
  if (Number.isInteger(ownedMonitorTab)) {
    try { const candidate = await api.tabs.get(ownedMonitorTab);
      if (isStockPage(candidate.pendingUrl || candidate.url)) tab = candidate;
    } catch {}
  }
  if (!tab) {
    tab = await api.tabs.create({ url: productPurchaseURL(task), active });
    await api.storage.local.set({ ownedMonitorTab: tab.id });
  } else if (tab.discarded) {
    if (!allowDiscardedReload) {
      const error = new Error('官网标签页已休眠');
      error.code = 'discarded-monitor-tab';
      throw error;
    }
    await api.tabs.reload(tab.id);
    if (active) await api.tabs.update(tab.id, { active: true });
  } else if (active) await api.tabs.update(tab.id, { active: true });
  return tab;
}
async function waitForTabReady(id) {
  if ((await api.tabs.get(id)).status === 'complete') return;
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); api.tabs.onUpdated.removeListener(listener); error ? reject(error) : resolve(); };
    const listener = (tabId, change) => { if (tabId === id && change.status === 'complete') finish(); };
    const timer = setTimeout(() => finish(new Error('官网页面加载超时')), 20000);
    api.tabs.onUpdated.addListener(listener);
    api.tabs.get(id).then(tab => { if (tab.status === 'complete') finish(); }).catch(finish);
  });
}
async function sendStockRequest(tabId, path, startRevision) {
  let diagnosticStage = 'bridge-probe';
  const probe = async () => {
    let timer;
    try {
      const result = await Promise.race([
        api.tabs.sendMessage(tabId, { type: 'ping' }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('官网页面桥接探测超时')), 2000); })
      ]);
      if (result?.ok !== true || result?.bridgeReady !== true) throw new Error('官网页面桥接尚未就绪');
    } finally { clearTimeout(timer); }
  };
  try {
    try { await probe(); }
    catch {
      if (revision !== startRevision) return null;
      diagnosticStage = 'bridge-injection';
      await api.scripting.executeScript({ target: { tabId }, files: ['page-bridge.js'], world: 'MAIN' });
      if (revision !== startRevision) return null;
      await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      if (revision !== startRevision) return null;
      diagnosticStage = 'bridge-probe';
      await probe();
    }
    if (revision !== startRevision) return null;
    diagnosticStage = 'stock-request';
    const result = await api.tabs.sendMessage(tabId, { type: 'stock-check', path });
    if (!result) throw new Error('没有收到页面响应');
    return { ...result, diagnosticStage };
  } catch {
    const error = new Error('官网页面连接失败');
    error.diagnosticStage = diagnosticStage;
    throw error;
  }
}
function reconnect() {
  if (currentCheck) throw new Error('请等待当前检查结束后再重新连接');
  const startRevision = revision;
  return withCheckLock(() => performReconnect(startRevision));
}
async function performReconnect(startRevision) {
  const saved = await api.storage.local.get(KEYS);
  if (revision !== startRevision) return { ok: true, cancelled: true };
  if (!saved.tasks?.length) throw new Error('请先添加一个监控商品');
  if ((saved.inflight?.until || 0) > Date.now()) throw new Error('上次请求仍可能在途，请等待到期后重连');
  if ((saved.connectionHealth?.notBefore || 0) > Date.now()) {
    return { ok: false, error: '官网冷却仍在生效，未发起请求。请等待最早可验证时间，并确认官网附近门店查询恢复后再单次验证。', manualRecoveryRequired: requiresManualRecovery(saved.connectionHealth) };
  }
  const tasks = await validateTasks(saved.tasks);
  if (revision !== startRevision) return { ok: true, cancelled: true };
  if (!tasks.some(task => dueAt(task, saved) <= Date.now())) {
    throw new Error(budgetLimits(tasks, saved) ? budgetMessage(budgetReadyAt(saved)) : '尚未到达可验证时间，请等待商品开放、请求间隔或冷却结束后再试。');
  }
  // Keep the durable latch throughout the probe, including worker suspension or
  // cancellation. Only a fully parsed response may clear it, never opening a tab.
  await api.storage.local.set({ monitoring: false, connectionHealth: { ...saved.connectionHealth, state: 'recovering',
    manualRecoveryRequired: true, recoveryPending: false, message: '正在单次验证官网库存响应；监控保持暂停。' } });
  await ensureSchedule();
  try {
    await performStockCheck(true, startRevision, true);
  } finally {
    const { connectionHealth } = await api.storage.local.get('connectionHealth');
    if (requiresManualRecovery(connectionHealth) || revision !== startRevision) {
      await api.storage.local.set({ monitoring: false, connectionHealth: { ...connectionHealth, state: 'needs-user',
        manualRecoveryRequired: true, recoveryPending: false,
        message: connectionHealth.state === 'recovering' || revision !== startRevision ? '单次验证未完成，监控保持暂停；请确认官网恢复后再试。' : connectionHealth.message } });
    }
    await publishState({ checking: false });
  }
  const { connectionHealth } = await api.storage.local.get('connectionHealth');
  if (requiresManualRecovery(connectionHealth)) return { ok: false, manualRecoveryRequired: true, error: connectionHealth.message };
  return { ok: true, recoveryValidated: true, message: '单次验证通过；任务、历史和设置均保留。监控仍暂停，请手动开始监控。' };
}
function resetAppleSession() {
  if (!api.desktop?.resetAppleSession) throw new Error('仅 Windows 桌面版支持重置官网会话');
  if (currentCheck) throw new Error('请等待当前检查结束后再重置官网会话');
  return withCheckLock(async () => {
    const saved = await api.storage.local.get(KEYS);
    if (saved.monitoring) throw new Error('请先暂停监控，再重置官网会话');
    if ((saved.inflight?.until || 0) > Date.now()) throw new Error('上次请求仍可能在途，请等待到期后再重置官网会话');
    await api.desktop.resetAppleSession();
    // A fresh session has no proof of a working store service. Keep any active
    // cooldown and the request budget; require the normal first-connection probe.
    const { lastSuccessAt, ...previous } = saved.connectionHealth || {};
    const health = { ...previous, state: 'needs-user', manualRecoveryRequired: true, recoveryPending: false,
      desktopPreparation: true, preparationReason: 'session-reset',
      message: '官网会话已重置（程序内官网的 Cookie 与缓存已清空，任务和历史保留）。请打开 Apple 官网并查询一次附近门店，再点击“连接官网，单次验证”。' };
    await api.storage.local.set({ connectionHealth: health, ownedMonitorTab: null, monitoring: false });
    await ensureSchedule();
    const state = await publishState();
    addLog(state, '已重置程序内官网会话；任务、历史和设置保留，需重新连接官网并单次验证。');
    await api.storage.local.set({ monitorState: state });
    return { ok: true, message: health.message };
  });
}
async function openDashboard() {
  const tabs = await api.tabs.query({ url: DASHBOARD });
  if (tabs[0]) { await api.tabs.update(tabs[0].id, { active: true }); await api.windows.update(tabs[0].windowId, { focused: true }); }
  else await api.tabs.create({ url: DASHBOARD });
}
async function reportError() {
  try { const state = await publishState({ checking: false }); addLog(state, '后台操作异常，请导出诊断记录或重新连接官网；任务已保留。'); await api.storage.local.set({ monitorState: state }); } catch {}
}
