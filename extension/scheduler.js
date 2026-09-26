export const LEASE_MS = 60000;
export const BOOST_MS = 600000;
export const DEFAULT_SETTINGS = { intervalSeconds: 20, boostUntil: 0, focusSkus: [] };
// One shared bucket for every inventory request this program sends, whatever
// the SKU interval or manual action. Field reports tie HTTP 541 to the number of
// queries a session has made (bursts of ~30 back-to-back), after which the
// session stays blocked; short intervals therefore drain to about one per minute.
export const REQUEST_BUDGET = { capacity: 20, refillMs: 60000 };
export const keyForTask = task => task.areaCode + '|' + task.product.Code + '|' + task.store.StoreNumber;
export const requiresManualRecovery = health => health?.manualRecoveryRequired === true || health?.state === 'needs-user' || health?.recoveryPending === true;

export function budgetValue(saved = {}, now = Date.now()) {
  const budget = saved.requestBudget, capacity = REQUEST_BUDGET.capacity;
  const tokens = Number(budget?.tokens), updatedAt = Number(budget?.updatedAt);
  if (!Number.isFinite(tokens) || !Number.isFinite(updatedAt)) return { tokens: capacity, updatedAt: now };
  // A clock moved backwards grants no refill.
  const refill = Math.max(0, now - updatedAt) / REQUEST_BUDGET.refillMs;
  return { tokens: Math.min(capacity, Math.max(0, tokens) + refill), updatedAt: now };
}

export function budgetReadyAt(saved, now = Date.now()) {
  const { tokens } = budgetValue(saved, now);
  return tokens >= 1 - 1e-9 ? 0 : now + Math.ceil((1 - tokens) * REQUEST_BUDGET.refillMs);
}

export function spendBudget(saved, now = Date.now()) {
  const { tokens } = budgetValue(saved, now);
  return { tokens: Math.max(0, tokens - 1), updatedAt: now };
}

export function settingsValue(saved = {}, now = Date.now()) {
  return { intervalSeconds: saved.intervalSeconds === 60 ? 60 : 20,
    boostUntil: Number(saved.boostUntil) > now ? Number(saved.boostUntil) : 0,
    focusSkus: [...new Set(Array.isArray(saved.focusSkus) ? saved.focusSkus : [])].sort().slice(0, 8) };
}

export function intervalForSku(code, settings, tasks, now = Date.now()) {
  const s = settingsValue(settings, now);
  const codes = new Set(tasks.map(task => task.product.Code));
  const focused = s.focusSkus.length ? s.focusSkus.includes(code) : codes.size <= 8;
  return focused ? (s.boostUntil > now ? 10000 : s.intervalSeconds * 1000) : 60000;
}

export function availableFrom(product) {
  const value = Date.parse(product.PreorderAt || '');
  return Number.isFinite(value) ? value : 0;
}

export function dueAt(task, saved, now = Date.now()) {
  return Math.max(availableFrom(task.product), Number(saved.skuCooldowns?.[task.product.Code]?.nextAt) || 0,
    Number(saved.connectionHealth?.notBefore) || 0, Number(saved.inflight?.until) || 0, budgetReadyAt(saved, now));
}

export function nextDue(tasks, saved, now = Date.now()) {
  if (requiresManualRecovery(saved.connectionHealth)) return 0;
  return tasks.length ? Math.min(...tasks.map(task => dueAt(task, saved, now))) : 0;
}

export function migrateState(saved) {
  const skuCooldowns = { ...saved.skuCooldowns };
  for (const [batch, value] of Object.entries(saved.cooldowns || {})) {
    for (const code of batch.split('|')) {
      if (!/^[A-Z0-9]+ZA\/A$/.test(code)) continue;
      // Apply old batch cooldowns only once. Keep the stricter deadline.
      if (!saved.schedulerVersion) skuCooldowns[code] = {
        nextAt: Math.max(Number(skuCooldowns[code]?.nextAt) || 0, Number(value.nextAt) || 0),
        failures: Math.max(Number(skuCooldowns[code]?.failures) || 0, Number(value.failures) || 0)
      };
    }
  }
  const stockMemory = { ...saved.stockMemory };
  for (const task of saved.tasks || []) {
    const item = saved.monitorState?.items?.[task.id];
    if (item && !stockMemory[keyForTask(task)]) stockMemory[keyForTask(task)] = item;
  }
  return { skuCooldowns, stockMemory, schedulerVersion: 3 };
}

export function restoreItems(tasks, memory, now = Date.now()) {
  return Object.fromEntries(tasks.map(task => [task.id, availableFrom(task.product) > now
    ? { status: '未开放预订', detail: '预计开放：' + new Date(availableFrom(task.product)).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false }), checkedAt: '', lastSuccess: null }
    : memory[keyForTask(task)] || { status: '尚未检查', detail: '', checkedAt: '', lastSuccess: null }]));
}

export function isStockPage(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://www.apple.com' && /^\/hk(?:-zh)?\/shop\/(?:buy-iphone\/iphone-[a-z0-9-]+(?:\/[^?#]*)?|product\/[a-zA-Z0-9]+(?:\/|%2[fF])A)\/?$/.test(u.pathname);
  } catch { return false; }
}

export function safeDiagnostic(result, extra = {}) {
  // Strict allowlist: never persist upstream response text, request headers or cookies.
  return { at: new Date().toISOString(), status: Number(result?.status) || 0,
    ...(['page-connection', 'bridge-probe', 'bridge-injection', 'stock-request'].includes(result?.diagnosticStage)
      ? { stage: result.diagnosticStage } : {}),
    responseKind: ['json', 'html', 'text', 'unknown'].includes(result?.responseKind) ? result.responseKind : 'unknown',
    responseBytes: Math.max(0, Number(result?.responseBytes) || 0),
    durationMs: Math.max(0, Number(result?.durationMs) || 0), timedOut: result?.timedOut === true,
    ...(Number.isInteger(extra.tabId) ? { tabId: extra.tabId } : {}),
    ...(Array.isArray(extra.skus) ? { skus: extra.skus.filter(s => /^[A-Z0-9]+ZA\/A$/.test(s)) } : {}),
    event: String(extra.event || 'stock-check').replace(/[^a-z-]/g, '').slice(0, 40),
    waitUntil: Number(extra.waitUntil) || 0 };
}
