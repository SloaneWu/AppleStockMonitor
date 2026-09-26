import { groupProductsByModel, unique } from "./shared.js";
import { statusLabel, statusClass, isKnownStatus, taskMatches, summarizeTasks } from "./dashboard.js";

if (globalThis.desktopChrome) globalThis.chrome = globalThis.desktopChrome;

// The preview adapter is available only on an explicit loopback preview, never in an installed extension.
if (!globalThis.chrome?.runtime?.id && ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('preview') === '1') {
  await import('../preview/adapter.js');
  document.getElementById('preview-notice').hidden = false;
}

const elements = Object.fromEntries([
  "store", "model", "capacity", "color", "add", "start", "stop", "check", "tasks",
  "empty-tasks", "monitor-badge", "last-check", "next-check", "logs", "form-message",
  "history-body", "history-message", "history-page", "history-prev", "history-next",
  "history-export", "history-error", "history-all", "history-changes", "task-count",
  "bark-enabled", "bark-url", "bark-configured", "bark-save", "bark-test", "bark-clear",
  "bark-message", "bark-result", "actual-timing", "monitor-interval", "focus-count", "focus-skus",
  "monitor-settings-save", "monitor-settings-message", "schedule-summary", "visibility-badge",
  "connection-badge", "connection-message", "connection-timing", "reconnect", "diagnostics-export",
  "connection-action-message", "purchase-enabled", "purchase-sku", "purchase-max-price", "purchase-stores",
  "purchase-save", "purchase-reset", "purchase-message", "purchase-badge", "purchase-operations",
  "task-search", "task-filter", "filter-summary", "no-matches", "clear-filters", "selected-product",
  "summary-products", "summary-tasks", "summary-stores", "summary-available", "summary-attention",
  "attention-banner", "attention-title", "attention-description", "show-connection", "global-message",
  "desktop-toolbar", "desktop-status", "desktop-data-path", "desktop-open-apple", "desktop-open-data", "desktop-backup", "desktop-message", "desktop-connection-guide"
].map((id) => [id, document.getElementById(id)]));

const PAGE_SIZE = 50;
const desktop = globalThis.chrome?.desktop;
const defaultInterval = desktop ? 60 : 20;
let desktopBusy = false;
let productsByModel = {};
let stores = [];
let tasks = [];
let monitorState = {};
let monitoring = false;
let pendingAction = false;
let pausePending = false;
let initialized = false;
let historyMode = "all";
let taskRenderSignature = "";
let currentView = "overview";
let historyOffset = 0;
let historyTotal = 0;
let historyLoading = false;
let historyLoadFailed = false;
let historyRequest = 0;
let historyRefreshTimer;
let barkSettings = null;
let barkBusy = false;
let barkDirty = false;
let monitorSettings = null;
let settingsBusy = false;
let settingsDirty = false;
let focusDraft = [];
let focusSignature = "";
let connectionHealth = {};
let reconnectBusy = false;
let diagnosticsBusy = false;
let pulsePending = false;
let purchaseSettings = null;
let purchaseOperations = [];
let purchaseBusy = false;
let purchaseDirty = false;
let priorityDraft = [];
let purchaseProductsSignature = "";
let purchaseStoresSignature = "";

initialize().catch((error) => setFormMessage("载入失败：" + error.message, true));

async function initialize() {
  bindEvents();
  initializeDesktop();
  const saved = await chrome.storage.local.get(["tasks", "monitorState", "monitoring", "uiSelection", "connectionHealth"]);
  tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  monitorState = saved.monitorState || {};
  monitoring = Boolean(saved.monitoring ?? monitorState.running);
  connectionHealth = saved.connectionHealth || {};
  await loadData(saved.uiSelection || {});
  initialized = true;
  render();
  await Promise.all([refreshBarkSettings(), refreshMonitorSettings(), refreshPurchaseSettings(), loadHistory()]);
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", tick);
  tick();
}

function bindEvents() {
  if (desktop) {
    elements["desktop-open-apple"].addEventListener("click", () => runDesktopAction(async () => {
      await desktop.openApple();
      return "已打开程序内的 Apple 官网窗口，可手动查看门店或处理登录与验证。";
    }));
    elements["desktop-open-data"].addEventListener("click", () => runDesktopAction(async () => {
      await desktop.openDataFolder();
      return "已打开本机数据目录。";
    }));
    elements["desktop-backup"].addEventListener("click", () => runDesktopAction(async () => {
      if (monitoring || monitorState.checking) throw new Error("请先暂停监控，等待当前检查结束后再备份。");
      const result = await desktop.backupData();
      return result?.cancelled ? "已取消备份。" : "配置与历史已导出，不含 Apple 登录会话和 Bark 密钥。" + (result?.path ? "保存位置：" + result.path : "");
    }));
  }
  document.querySelector('.skip-link').addEventListener('click', event => {
    event.preventDefault();
    document.getElementById('main-content').focus();
  });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.view; }));
  window.addEventListener('hashchange', switchView);
  switchView();
  elements['task-search'].addEventListener('input', renderTasks);
  elements['task-filter'].addEventListener('change', renderTasks);
  elements['clear-filters'].addEventListener('click', () => {
    elements['task-search'].value = ''; elements['task-filter'].value = 'all'; renderTasks(); elements['task-search'].focus();
  });
  elements['show-connection'].addEventListener('click', () => { document.getElementById('connection-title').scrollIntoView({ behavior: 'smooth', block: 'center' }); elements.reconnect.focus({ preventScroll: true }); });
  window.addEventListener('beforeunload', event => {
    if (barkDirty || settingsDirty || purchaseDirty) { event.preventDefault(); event.returnValue = ''; }
  });
  elements.store.addEventListener("change", () => runAction(saveSelection));
  elements.model.addEventListener("change", () => runAction(async () => {
    populateCapacities(elements.capacity.value, elements.color.value);
    await saveSelection();
  }));
  elements.capacity.addEventListener("change", () => runAction(async () => {
    populateColors(elements.color.value);
    await saveSelection();
  }));
  elements.color.addEventListener("change", () => runAction(saveSelection));
  elements.add.addEventListener("click", () => runAction(addTasks));
  elements.start.addEventListener("click", () => runAction(startMonitoring));
  elements.stop.addEventListener("click", async () => {
    if (pausePending) return;
    pausePending = true;
    renderMonitorState();
    try { await stopMonitoring(); }
    catch (error) { setFormMessage(error.message || String(error), true); }
    finally { pausePending = false; renderMonitorState(); }
  });
  elements.check.addEventListener("click", () => runAction(checkNow));
  elements["history-all"].addEventListener("click", () => changeHistoryMode("all"));
  elements["history-changes"].addEventListener("click", () => changeHistoryMode("changes"));
  elements["history-prev"].addEventListener("click", () => {
    historyOffset = Math.max(0, historyOffset - PAGE_SIZE);
    loadHistory();
  });
  elements["history-next"].addEventListener("click", () => {
    if (historyOffset + PAGE_SIZE < historyTotal) {
      historyOffset += PAGE_SIZE;
      loadHistory();
    }
  });
  elements["history-export"].addEventListener("click", exportHistory);
  elements["bark-enabled"].addEventListener("change", markBarkDirty);
  elements["bark-url"].addEventListener("input", markBarkDirty);
  elements["bark-save"].addEventListener("click", () => runBarkAction(async () => {
    const result = await request({ type: "save-bark-settings", enabled: elements["bark-enabled"].checked,
      url: elements["bark-url"].value.trim() });
    elements["bark-url"].value = "";
    barkDirty = false;
    applyBarkSettings(result);
    setBarkMessage(result.enabled ? "已保存并启用通知。可发送一条测试通知确认手机能收到。" : "已保存，Bark 通知已关闭。");
  }));
  elements["bark-test"].addEventListener("click", () => runBarkAction(async () => {
    if (barkDirty || elements["bark-url"].value.trim()) throw new Error("通知设置有未保存的修改，请先保存，再发送测试通知。");
    const result = await request({ type: "test-bark" });
    setBarkMessage(result.message || "Bark 服务器已接受测试通知，请查看手机。");
    await refreshBarkSettings();
  }));
  elements["bark-clear"].addEventListener("click", () => runBarkAction(async () => {
    const result = await request({ type: "clear-bark-settings" });
    elements["bark-url"].value = "";
    barkDirty = false;
    applyBarkSettings(result);
    setBarkMessage("已清除本机保存的设备密钥，并关闭 Bark 通知。");
  }));
  elements["monitor-interval"].addEventListener("change", markSettingsDirty);
  elements["monitor-settings-save"].addEventListener("click", saveMonitorSettings);
  elements.reconnect.addEventListener("click", reconnect);
  elements["diagnostics-export"].addEventListener("click", exportDiagnostics);
  elements["purchase-enabled"].addEventListener("change", markPurchaseDirty);
  elements["purchase-max-price"].addEventListener("input", markPurchaseDirty);
  elements["purchase-sku"].addEventListener("change", () => {
    priorityDraft = [];
    markPurchaseDirty();
  });
  elements["purchase-save"].addEventListener("click", () => runPurchaseAction(savePurchaseSettings));
  elements["purchase-reset"].addEventListener("click", () => runPurchaseAction(async () => {
    if (purchaseDirty) throw new Error("请先保存购买设置，再允许此商品再次尝试。");
    const sku = purchaseSettings?.sku;
    if (!sku) throw new Error("请先选择并保存指定商品。");
    applyPurchaseSettings(await request({ type: "reset-purchase", sku }));
    setMessage("purchase-message", "已允许此商品再次尝试。请确认购物袋没有重复商品；满足监控条件后才会尝试。");
  }));

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.tasks) tasks = Array.isArray(changes.tasks.newValue) ? changes.tasks.newValue : [];
    if (changes.monitorState) {
      monitorState = changes.monitorState.newValue || {};
      if (typeof monitorState.running === "boolean") monitoring = monitorState.running;
      clearTimeout(historyRefreshTimer);
      historyRefreshTimer = setTimeout(loadHistory, 180);
    }
    if (changes.monitoring) monitoring = Boolean(changes.monitoring.newValue);
    if (changes.connectionHealth) connectionHealth = changes.connectionHealth.newValue || {};
    if (changes.monitorSettings) applyMonitorSettings({ settings: changes.monitorSettings.newValue });
    if (changes.purchaseSettings) applyPurchaseSettings({ settings: changes.purchaseSettings.newValue });
    if (changes.purchaseOperations) {
      purchaseOperations = Array.isArray(changes.purchaseOperations.newValue) ? changes.purchaseOperations.newValue : [];
      renderPurchaseOperations();
    }
    if (changes.barkStatus && barkSettings) {
      barkSettings.lastResult = changes.barkStatus.newValue || null;
      renderBarkSettings();
    }
    // Reload only the public settings view; never read the secret from change data.
    if (changes.barkConfig) refreshBarkSettings();
    render();
  });
}

async function initializeDesktop() {
  if (!desktop) return;
  elements["desktop-toolbar"].hidden = false;
  elements["desktop-connection-guide"].hidden = false;
  renderDesktopControls();
  try {
    const info = await desktop.getInfo();
    elements["desktop-status"].textContent = "Windows 桌面版" + (info.version ? " · v" + info.version : "");
    elements["desktop-data-path"].textContent = info.dataPath ? "数据保存在 " + info.dataPath : "数据保存在程序旁的 Data 文件夹";
    elements["desktop-data-path"].title = info.dataPath || "";
  } catch (error) {
    elements["desktop-message"].hidden = false;
    setMessage("desktop-message", "读取程序信息失败：" + (error.message || String(error)), true);
  }
}

async function runDesktopAction(action) {
  if (desktopBusy) return;
  desktopBusy = true;
  renderDesktopControls();
  elements["desktop-message"].hidden = false;
  setMessage("desktop-message", "正在处理…");
  try { setMessage("desktop-message", await action()); }
  catch (error) { setMessage("desktop-message", error.message || String(error), true); }
  finally { desktopBusy = false; renderDesktopControls(); }
}

function renderDesktopControls() {
  if (!desktop) return;
  elements["desktop-open-apple"].disabled = desktopBusy;
  elements["desktop-open-data"].disabled = desktopBusy;
  elements["desktop-backup"].disabled = desktopBusy || !initialized || monitoring || Boolean(monitorState.checking);
  elements["desktop-backup"].title = monitoring || monitorState.checking ? "暂停监控，等本次检查结束后可备份" : "导出配置与历史 CSV，不含 Apple 登录会话和 Bark 密钥";
}

function setMessage(id, message, isError = false) {
  elements[id].textContent = message;
  elements[id].classList.toggle("error-text", isError);
}

function monitoredProducts() {
  return [...new Map(tasks.filter((task) => task?.product?.Code)
    .map((task) => [task.product.Code, task.product])).values()];
}

function productLabel(product) {
  return [product.Model, product.Capacity, product.Color].filter(Boolean).join(" · ") + " · " + product.Code;
}

function tick() {
  renderMonitorState();
  renderScheduleSummary();
  renderConnectionHealth();
  renderOverview();
  if (!desktop && initialized && monitoring && !manualRecoveryHeld() && document.visibilityState === "visible" && !pulsePending) {
    pulsePending = true;
    // Only this visible panel supplies fast scheduling pulses; the worker owns due times and overlap protection.
    chrome.runtime.sendMessage({ type: "scheduler-pulse" }).catch((error) => {
      setMessage("connection-action-message", "面板与后台的连接中断，请重新打开面板：" + error.message, true);
    }).finally(() => { pulsePending = false; });
  }
}

async function refreshMonitorSettings() {
  try { applyMonitorSettings(await request({ type: "get-monitor-settings" })); }
  catch (error) { setMessage("monitor-settings-message", "读取检查设置失败：" + error.message, true); }
}

function applyMonitorSettings(result) {
  if (!result.settings) return;
  monitorSettings = result.settings;
  if (!settingsDirty) {
    elements["monitor-interval"].value = timeValue(monitorSettings.boostUntil) > Date.now() ? "10" : String(monitorSettings.intervalSeconds || defaultInterval);
    focusDraft = Array.isArray(monitorSettings.focusSkus) ? [...monitorSettings.focusSkus] : [];
  }
  renderMonitorSettings();
}

function markSettingsDirty() {
  settingsDirty = true;
  setMessage("monitor-settings-message", "检查设置尚未保存。");
  renderMonitorSettings();
}

async function saveMonitorSettings() {
  if (settingsBusy) return;
  settingsBusy = true;
  renderMonitorSettings();
  try {
    const validCodes = new Set(monitoredProducts().map((product) => product.Code));
    const focusSkus = focusDraft.filter((code) => validCodes.has(code));
    if (focusSkus.length > 8) throw new Error("重点商品最多选择 8 个不同 SKU。");
    const intervalSeconds = Number(elements["monitor-interval"].value);
    const result = await request({ type: "save-monitor-settings", intervalSeconds, focusSkus });
    settingsDirty = false;
    applyMonitorSettings(result);
    setMessage("monitor-settings-message", intervalSeconds === 10 ? "已保存：10 秒加速持续 10 分钟，之后恢复 20 秒。" + (desktop ? "最小化后仍会继续检查。" : "请保持此面板可见。") : "检查设置已保存。");
  } catch (error) { setMessage("monitor-settings-message", error.message, true); }
  finally { settingsBusy = false; renderMonitorSettings(); }
}

function renderMonitorSettings() {
  const products = monitoredProducts();
  const signature = JSON.stringify([products, focusDraft]);
  if (signature !== focusSignature) {
    focusSignature = signature;
    elements["focus-skus"].replaceChildren();
    if (!products.length) elements["focus-skus"].append(node("p", "field-note", "先添加监控商品，再选择重点 SKU。"));
    for (const product of products) {
      const label = node("label", "focus-option");
      const input = node("input");
      input.type = "checkbox";
      input.value = product.Code;
      input.checked = focusDraft.includes(product.Code);
      input.addEventListener("change", () => {
        focusDraft = input.checked ? [...new Set([...focusDraft, product.Code])] : focusDraft.filter((code) => code !== product.Code);
        markSettingsDirty();
      });
      label.append(input, node("span", "", productLabel(product)));
      elements["focus-skus"].append(label);
    }
  }
  const selectedCount = products.filter((product) => focusDraft.includes(product.Code)).length;
  elements["focus-count"].textContent = selectedCount + " / 8 款";
  elements["monitor-interval"].disabled = !monitorSettings || settingsBusy;
  elements["monitor-settings-save"].disabled = !monitorSettings || settingsBusy;
  elements["monitor-settings-save"].textContent = settingsBusy ? "正在保存…" : "保存检查设置";
  elements["focus-skus"].querySelectorAll("input").forEach((input) => {
    input.disabled = !monitorSettings || settingsBusy || (!input.checked && selectedCount >= 8);
  });
  renderScheduleSummary();
}

function renderScheduleSummary() {
  const visible = document.visibilityState === "visible";
  elements["visibility-badge"].textContent = desktop ? "后台独立调度" : visible ? "面板可见" : "面板在后台";
  elements["visibility-badge"].className = "status-badge " + (desktop || visible ? "running" : "idle");
  if (!monitorSettings) return;
  const boostSeconds = Math.max(0, Math.ceil((timeValue(monitorSettings.boostUntil) - Date.now()) / 1000));
  if (!settingsDirty && !boostSeconds && elements["monitor-interval"].value === "10") {
    elements["monitor-interval"].value = String(monitorSettings.intervalSeconds || defaultInterval);
  }
  const interval = boostSeconds ? 10 : monitorSettings.intervalSeconds || defaultInterval;
  const productCodes = monitoredProducts().map((product) => product.Code);
  const focused = (monitorSettings.focusSkus || []).filter((code) => productCodes.includes(code));
  const count = monitorSettings.focusSkus?.length ? focused.length : productCodes.length <= 8 ? productCodes.length : 0;
  const text = interval === 60 ? "已保存：全部商品每 60 秒检查。" : count
    ? "已保存：" + count + " 款重点商品每 " + interval + " 秒，其余商品每 60 秒。"
    : "已保存：目前没有重点商品，全部每 60 秒检查。";
  elements["schedule-summary"].textContent = text + (boostSeconds ? " 加速剩余 " + Math.floor(boostSeconds / 60) + " 分 " + boostSeconds % 60 + " 秒。" : "") +
    (desktop ? " 最小化到托盘后仍会继续检查；电脑休眠期间不能检查。" : !visible ? " 面板在后台，自动检查至少间隔 30 秒（Chrome 120+）。" : "") +
    " 全部 " + productCodes.length + " 款查一轮最多分 " + Math.ceil(productCodes.length / 8) + " 批请求；60 秒并不代表每分钟只有一次请求。实际间隔受请求耗时、系统调度及异常等待影响。";
}

function manualRecoveryHeld() {
  return connectionHealth.manualRecoveryRequired === true || connectionHealth.state === 'needs-user';
}

function renderConnectionHealth() {
  const state = connectionHealth.state || "unverified";
  const held = manualRecoveryHeld();
  const labels = { healthy: "连接正常", cooldown: "等待重试", "needs-user": "需要你处理", recovering: "正在恢复", unverified: "尚未验证" };
  elements["connection-badge"].textContent = labels[state] || "尚未验证";
  elements["connection-badge"].className = "status-badge " + ({ healthy: "running", cooldown: "warning", "needs-user": "warning", recovering: "checking" }[state] || "idle");
  elements["connection-message"].textContent = connectionHealth.message || "首次有效查询后确认连接状态。";
  const parts = [];
  if (connectionHealth.firstFailureAt) parts.push("本轮首次异常：" + formatTime(connectionHealth.firstFailureAt));
  const retryAt = timeValue(connectionHealth.notBefore);
  if (retryAt > Date.now()) parts.push((held ? "最早可手动验证：" : "最早重试：") + formatTime(retryAt) + "（剩余 " + Math.ceil((retryAt - Date.now()) / 1000) + " 秒）");
  if (held) parts.push("等待结束后仍保持暂停，不会自动重试或刷新官网");
  elements["connection-timing"].textContent = parts.join(" · ");
  elements.reconnect.disabled = !initialized || !tasks.length || reconnectBusy || pendingAction || monitorState.checking || state === "recovering" || retryAt > Date.now();
  elements.reconnect.textContent = reconnectBusy || state === "recovering" ? "正在单次验证…" : desktop ? "连接官网，单次验证" : "官网恢复后，单次验证";
  elements["diagnostics-export"].disabled = !initialized || diagnosticsBusy;
}

async function reconnect() {
  if (reconnectBusy) return;
  reconnectBusy = true;
  renderConnectionHealth();
  setMessage("connection-action-message", "正在单次验证官网库存服务，验证期间保持暂停…");
  try {
    const result = await request({ type: "reconnect" });
    setMessage("connection-action-message", result.message || "单次验证已结束，请查看连接状态；监控任务与历史已保留。");
  } catch (error) { setMessage("connection-action-message", error.message, true); }
  finally { reconnectBusy = false; renderConnectionHealth(); renderMonitorState(); }
}

async function exportDiagnostics() {
  if (diagnosticsBusy) return;
  diagnosticsBusy = true;
  renderConnectionHealth();
  try {
    const result = await request({ type: "export-diagnostics" });
    if (result.json == null) throw new Error("诊断内容为空");
    const data = typeof result.json === "string" ? JSON.parse(result.json) : result.json;
    if (desktop?.connectionDiagnostics) data.desktopConnection = await desktop.connectionDiagnostics();
    const json = JSON.stringify(data, null, 2);
    downloadFile(json, "application/json;charset=utf-8", "Apple库存诊断-" + new Date().toISOString().slice(0, 10) + ".json");
    setMessage("connection-action-message", "诊断文件已导出。");
  } catch (error) { setMessage("connection-action-message", "导出失败：" + error.message, true); }
  finally { diagnosticsBusy = false; renderConnectionHealth(); }
}

async function refreshPurchaseSettings() {
  try { applyPurchaseSettings(await request({ type: "get-purchase-settings" })); }
  catch (error) { setMessage("purchase-message", "读取购买设置失败：" + error.message, true); }
}

function applyPurchaseSettings(result) {
  if (result.settings) {
    purchaseSettings = result.settings;
    if (!purchaseDirty) {
      elements["purchase-enabled"].checked = Boolean(purchaseSettings.enabled);
      elements["purchase-max-price"].value = purchaseSettings.maxPrice > 0 ? String(purchaseSettings.maxPrice) : "";
      priorityDraft = Array.isArray(purchaseSettings.storePriority) ? [...purchaseSettings.storePriority] : [];
      purchaseProductsSignature = "";
    }
  }
  if (Array.isArray(result.operations)) purchaseOperations = result.operations;
  renderPurchaseSettings();
  renderPurchaseOperations();
}

function markPurchaseDirty() {
  purchaseDirty = true;
  setMessage("purchase-message", "购买设置尚未保存。");
  renderPurchaseSettings();
}

async function runPurchaseAction(action) {
  if (purchaseBusy) return;
  purchaseBusy = true;
  renderPurchaseSettings();
  try { await action(); }
  catch (error) { setMessage("purchase-message", error.message, true); }
  finally { purchaseBusy = false; renderPurchaseSettings(); }
}

async function savePurchaseSettings() {
  const enabled = elements["purchase-enabled"].checked;
  const sku = elements["purchase-sku"].value;
  const maxPrice = Number(elements["purchase-max-price"].value);
  const allowedStores = new Set(tasks.filter((task) => task.product.Code === sku).map((task) => task.store.StoreNumber));
  const storePriority = priorityDraft.filter((code) => allowedStores.has(code));
  if (enabled && !sku) throw new Error("启用前，请从监控列表中指定一款完整商品。");
  if (enabled && (!Number.isFinite(maxPrice) || maxPrice <= 0)) throw new Error("启用前，请填写有效的最高单价（HKD）。");
  if (enabled && !storePriority.length) throw new Error("启用前，请至少选择一家允许提取的门店。");
  const settings = { enabled, sku, maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : 0, quantity: 1, storePriority };
  const result = await request({ type: "save-purchase-settings", settings });
  purchaseDirty = false;
  applyPurchaseSettings(result);
  setMessage("purchase-message", enabled ? "已保存并启用。符合条件时只准备购物袋，付款仍由你完成。" : "已保存，自动加入购物袋已关闭。");
}

function renderPurchaseSettings() {
  const products = monitoredProducts().filter((product) => /^iPhone\b/.test(product.Model));
  const signature = JSON.stringify(products);
  if (signature !== purchaseProductsSignature) {
    purchaseProductsSignature = signature;
    const preferred = purchaseDirty ? elements["purchase-sku"].value : purchaseSettings?.sku || "";
    const options = [{ value: "", label: "请选择一款监控中的商品" }, ...products.map((product) => ({ value: product.Code, label: productLabel(product) }))];
    fillSelect(elements["purchase-sku"], options, preferred);
  }
  const sku = elements["purchase-sku"].value;
  const selectedStores = [...new Map(tasks.filter((task) => task.product.Code === sku)
    .map((task) => [task.store.StoreNumber, task.store])).values()];
  const allowed = new Set(selectedStores.map((store) => store.StoreNumber));
  const priority = priorityDraft.filter((code) => allowed.has(code));
  const orderedCodes = [...priority, ...selectedStores.map((store) => store.StoreNumber).filter((code) => !priority.includes(code))];
  const storesSignature = JSON.stringify([selectedStores, priority]);
  if (storesSignature !== purchaseStoresSignature) {
    purchaseStoresSignature = storesSignature;
    elements["purchase-stores"].replaceChildren();
    if (!selectedStores.length) elements["purchase-stores"].append(node("p", "field-note", "选择指定商品后，这里显示可配置的监控门店。"));
    for (const code of orderedCodes) {
      const store = selectedStores.find((item) => item.StoreNumber === code);
      const index = priority.indexOf(code);
      const row = node("div", "priority-row");
      const label = node("label", "priority-option");
      const input = node("input");
      input.type = "checkbox";
      input.checked = index >= 0;
      input.addEventListener("change", () => {
        priorityDraft = input.checked ? [...priority, code] : priority.filter((item) => item !== code);
        markPurchaseDirty();
      });
      label.append(input, node("span", "", (index >= 0 ? (index + 1) + ". " : "") + store.CityStoreName));
      row.append(label);
      for (const [delta, title] of [[-1, "上移"], [1, "下移"]]) {
        const button = node("button", "small-button priority-move", title);
        button.type = "button";
        button.setAttribute("aria-label", title + store.CityStoreName);
        button.dataset.unavailable = String(index < 0 || index + delta < 0 || index + delta >= priority.length);
        button.addEventListener("click", () => {
          const next = [...priority];
          [next[index], next[index + delta]] = [next[index + delta], next[index]];
          priorityDraft = next;
          markPurchaseDirty();
        });
        row.append(button);
      }
      elements["purchase-stores"].append(row);
    }
  }
  const ready = Boolean(purchaseSettings) && !purchaseBusy;
  for (const id of ["purchase-enabled", "purchase-sku", "purchase-max-price", "purchase-save"]) elements[id].disabled = !ready;
  elements["purchase-stores"].querySelectorAll("input").forEach((input) => { input.disabled = !ready; });
  elements["purchase-stores"].querySelectorAll("button").forEach((button) => { button.disabled = !ready || button.dataset.unavailable === "true"; });
  elements["purchase-reset"].disabled = !ready || purchaseDirty || !purchaseSettings?.sku;
  elements["purchase-save"].textContent = purchaseBusy ? "正在处理…" : "保存购买设置";
  elements["purchase-badge"].textContent = purchaseDirty ? "有未保存修改" : purchaseSettings?.enabled ? "已启用 · 手动付款" : "已关闭";
  elements["purchase-badge"].className = "status-badge " + (purchaseSettings?.enabled ? "running" : "idle");
}

function renderPurchaseOperations() {
  elements["purchase-operations"].replaceChildren();
  const operations = [...purchaseOperations].sort((a, b) => timeValue(b.at) - timeValue(a.at)).slice(0, 30);
  if (!operations.length) elements["purchase-operations"].append(node("p", "field-note", "尚无准备购买记录。该功能默认关闭。"));
  const labels = { "needs-user": "需要你处理", opening: "正在打开官网", checking: "正在核对商品", adding: "正在加入购物袋",
    preparing: "正在准备", added: "已加入购物袋 · 待你核实", failed: "准备失败" };
  for (const entry of operations) {
    const row = node("article", "purchase-operation");
    const heading = node("p", "operation-heading");
    heading.append(node("strong", "", labels[entry.status] || entry.status || "操作记录"), node("span", "attempt-time", formatTime(entry.at)));
    row.append(heading, node("p", "sku", entry.sku || ""), node("p", "status-detail", entry.detail || ""));
    elements["purchase-operations"].append(row);
  }
}

function downloadFile(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function markBarkDirty() {
  barkDirty = true;
  setBarkMessage("通知设置尚未保存。请先保存，再发送测试通知。");
  renderBarkSettings();
}

async function refreshBarkSettings() {
  try {
    applyBarkSettings(await request({ type: "get-bark-settings" }));
  } catch (error) {
    setBarkMessage("读取通知设置失败：" + error.message, true);
  }
}

function applyBarkSettings(result) {
  barkSettings = { enabled: Boolean(result.enabled), configured: Boolean(result.configured),
    lastResult: result.lastResult || null };
  if (!barkDirty) elements["bark-enabled"].checked = barkSettings.enabled;
  renderBarkSettings();
}

async function runBarkAction(action) {
  if (barkBusy) return;
  barkBusy = true;
  renderBarkSettings();
  try {
    await action();
  } catch (error) {
    setBarkMessage(error.message || String(error), true);
  } finally {
    barkBusy = false;
    renderBarkSettings();
  }
}

function setBarkMessage(message, isError = false) {
  elements["bark-message"].textContent = message;
  elements["bark-message"].classList.toggle("error-text", isError);
}

function renderBarkSettings() {
  const ready = Boolean(barkSettings);
  const configured = Boolean(barkSettings?.configured);
  const enabled = configured && barkSettings.enabled;
  elements["bark-configured"].textContent = !ready ? "尚未读取" : !configured ? "未配置" : enabled ? "已配置 · 已启用" : "已配置 · 已关闭";
  elements["bark-configured"].className = "status-badge " + (enabled ? "running" : "idle");
  elements["bark-enabled"].disabled = !ready || barkBusy;
  elements["bark-url"].disabled = !ready || barkBusy;
  elements["bark-save"].disabled = !ready || barkBusy;
  elements["bark-clear"].disabled = !ready || barkBusy || !configured;
  elements["bark-test"].disabled = !ready || barkBusy || !configured || barkDirty;
  elements["bark-test"].title = barkDirty ? "请先保存修改，再发送测试通知" : !configured ? "请先保存 Bark 推送地址或设备密钥" : "向已保存的设备发送一条测试通知";
  const lastResult = barkSettings?.lastResult;
  elements["bark-result"].textContent = lastResult ? "最近发送：" + formatTime(lastResult.at) + " · " + lastResult.message : "尚无发送记录";
  elements["bark-result"].classList.toggle("error-text", Boolean(lastResult && !lastResult.ok));
}

async function loadData(selection) {
  setFormMessage("正在载入香港机型和门店…");
  const [productResponse, storeResponse] = await Promise.all([
    fetch(chrome.runtime.getURL("data/products/product_data_hk.json")),
    fetch(chrome.runtime.getURL("data/stores/store_hk.json"))
  ]);
  if (!productResponse.ok || !storeResponse.ok) throw new Error("内置机型或门店资料无法读取");
  const [productData, storeData] = await Promise.all([productResponse.json(), storeResponse.json()]);
  productsByModel = groupProductsByModel(productData.products);
  stores = Array.isArray(storeData.stores) ? storeData.stores : [];
  if (!stores.length || !Object.keys(productsByModel).length) throw new Error("内置机型或门店资料为空");
  fillSelect(elements.store, [
    { value: "all", label: "Central 附近全部 " + stores.length + " 家门店" },
    ...stores.map((store) => ({ value: store.StoreNumber, label: store.CityStoreName + (store.City ? " · " + store.City : "") }))
  ], selection.storeNumber || "all");
  fillSelect(elements.model, Object.keys(productsByModel).map((value) => ({ value, label: value })),
    selection.model || "iPhone 18 Pro Max");
  populateCapacities(selection.capacity || "512GB", selection.color || "冰川色");
  setFormMessage("");
  renderSelectedProduct();
}

function populateCapacities(preferredCapacity, preferredColor) {
  const products = productsByModel[elements.model.value] || [];
  fillSelect(elements.capacity, unique(products.map((product) => product.Capacity))
    .map((value) => ({ value, label: value })), preferredCapacity);
  populateColors(preferredColor);
}

function populateColors(preferredColor) {
  const products = productsByModel[elements.model.value] || [];
  fillSelect(elements.color, unique(products.filter((product) => product.Capacity === elements.capacity.value)
    .map((product) => product.Color)).map((value) => ({ value, label: value })), preferredColor);
}

function fillSelect(select, options, preferredValue) {
  select.replaceChildren();
  for (const { value, label } of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  if (options.some((option) => option.value === preferredValue)) select.value = preferredValue;
  select.disabled = options.length === 0;
}

async function saveSelection() {
  renderSelectedProduct();
  await chrome.storage.local.set({ uiSelection: {
    areaCode: "hk", storeNumber: elements.store.value, model: elements.model.value,
    capacity: elements.capacity.value, color: elements.color.value
  } });
}

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "后台没有返回有效结果，请重新打开监控面板");
  return result;
}

async function runAction(action) {
  if (pendingAction) return;
  pendingAction = true;
  renderMonitorState();
  try {
    await action();
  } catch (error) {
    setFormMessage(error.message || String(error), true);
  } finally {
    pendingAction = false;
    render();
  }
}

async function addTasks() {
  if (monitoring || monitorState.checking) throw new Error("请先暂停监控，并等本次检查完成后再修改列表。");
  const product = (productsByModel[elements.model.value] || []).find((candidate) =>
    candidate.Capacity === elements.capacity.value && candidate.Color === elements.color.value);
  const selectedStores = elements.store.value === "all" ? stores
    : stores.filter((store) => store.StoreNumber === elements.store.value);
  if (!product || !selectedStores.length) throw new Error("请完整选择型号、容量、颜色和门店。");
  const additions = selectedStores.filter((store) => !tasks.some((task) =>
    task.areaCode === "hk" && task.store.StoreNumber === store.StoreNumber && task.product.Code === product.Code))
    .map((store) => ({
      id: crypto.randomUUID(), areaCode: "hk", areaTitle: "香港",
      store: structuredClone(store), product: structuredClone(product)
    }));
  if (!additions.length) throw new Error("所选商品与门店已经全部在监控列表中。");
  const nextTasks = [...tasks, ...additions];
  await request({ type: "save-tasks", tasks: nextTasks });
  tasks = nextTasks;
  await saveSelection();
  setFormMessage("已添加 " + additions.length + " 个门店监控" +
    (additions.length < selectedStores.length ? "，已跳过重复项目" : "") + "。");
}

async function removeTask(taskId) {
  if (monitoring || monitorState.checking) throw new Error("请先暂停监控，并等本次检查完成后再移除项目。");
  const nextTasks = tasks.filter((task) => task.id !== taskId);
  await request({ type: "save-tasks", tasks: nextTasks });
  tasks = nextTasks;
  setFormMessage("已移除监控项目，已保存的历史记录仍然保留。");
}

async function startMonitoring() {
  if (!tasks.length) throw new Error("请先添加要监控的商品。");
  setFormMessage("正在打开 Apple 官网并启动监控…");
  await request({ type: "start-monitor", tasks });
  setFormMessage(monitoring ? desktop ? "监控已启动。可最小化到托盘，请保持程序运行和电脑联网。" : "监控已启动。请保持浏览器和 Apple 标签页打开。" : "当前检查已结束，自动监控已暂停。");
}

async function stopMonitoring() {
  await request({ type: "stop-monitor" });
  setFormMessage("已暂停自动检查；正在进行的检查会完成并保存结果。");
}

async function checkNow() {
  if (!tasks.length) throw new Error("请先添加要检查的商品。");
  setFormMessage("正在读取 Apple 官网库存…");
  await request({ type: "check-now" });
  setFormMessage("本次检查已完成，结果与历史已更新。");
}

function render() {
  renderTasks();
  renderOverview();
  renderMonitorState();
  renderLogs();
  renderMonitorSettings();
  renderConnectionHealth();
  renderPurchaseSettings();
}

function matchesTask(task) {
  return taskMatches(task, monitorState.items, elements['task-search'].value, elements['task-filter'].value);
}

function renderTasks() {
  const signature = JSON.stringify([tasks, monitorState.items, elements['task-search'].value, elements['task-filter'].value, pendingAction, monitoring, monitorState.checking]);
  if (signature === taskRenderSignature) return;
  taskRenderSignature = signature;
  const visible = tasks.filter(matchesTask);
  elements.tasks.replaceChildren();
  elements['empty-tasks'].hidden = tasks.length > 0;
  elements['no-matches'].hidden = !tasks.length || visible.length > 0;
  elements['task-count'].textContent = monitoredProducts().length + ' 款商品 · ' + tasks.length + ' 个门店监控';
  elements['filter-summary'].textContent = tasks.length && (visible.length !== tasks.length || elements['task-search'].value || elements['task-filter'].value !== 'all') ? '显示 ' + visible.length + ' / ' + tasks.length + ' 个门店监控' : '';
  const grouped = new Map();
  visible.forEach(task => { if (!grouped.has(task.product.Code)) grouped.set(task.product.Code, []); grouped.get(task.product.Code).push(task); });
  for (const [code, group] of grouped) {
    const product = group[0].product;
    const section = node('section', 'product-group');
    const heading = node('div', 'product-group-heading');
    const title = node('div');
    title.append(node('h3', '', product.Model), node('p', 'task-product', product.Capacity + ' · ' + product.Color), node('span', 'sku', code));
    const open = node('button', 'small-button product-open', '查看官网 ↗');
    open.type = 'button';
    open.addEventListener('click', () => runAction(() => request({ type: 'open-product', task: group[0] })));
    heading.append(title, open); section.append(heading);
    for (const task of group) {
      const state = monitorState.items?.[task.id];
      const item = node('article', 'task');
      const content = node('div', 'task-content');
      const statusLine = node('div', 'store-line');
      statusLine.append(node('h4', '', task.store.CityStoreName), statusBadge(state?.status));
      content.append(statusLine);
      if (state?.checkedAt) content.append(node('span', 'attempt-time', '最近检查 ' + formatTime(state.checkedAt)));
      if (state?.detail) content.append(node('p', 'status-detail ' + statusClass(state.status), state.detail));
      if (state?.httpStatus && !String(state.detail || '').includes(String(state.httpStatus))) content.append(node('p', 'status-detail', 'HTTP ' + state.httpStatus));
      if (state?.lastSuccess && (!isKnownStatus(state.status) || state.lastSuccess.checkedAt !== state.checkedAt)) {
        content.append(node('p', 'last-success', '历史成功结果：' + statusLabel(state.lastSuccess.status) + ' · ' + formatTime(state.lastSuccess.checkedAt) + '（不代表当前库存）'));
      }
      const remove = node('button', 'small-button remove-button', '移除');
      remove.type = 'button';
      remove.disabled = pendingAction || monitoring || Boolean(monitorState.checking);
      remove.title = remove.disabled ? '暂停监控并等待检查完成后可移除' : '移除监控，保留历史';
      remove.setAttribute('aria-label', '移除 ' + product.Model + ' ' + product.Capacity + ' ' + product.Color + ' · ' + task.store.CityStoreName);
      remove.addEventListener('click', () => runAction(() => removeTask(task.id)));
      item.append(content, remove); section.append(item);
    }
    elements.tasks.append(section);
  }
}

function switchView() {
  const views = { overview: ['监控概览', '关注你的下一部 iPhone，掌握每家门店的最近库存。'], history: ['历史与日志', '回看每次检查，区分库存变化与连接异常。'], settings: ['频率与通知', '设置检查节奏，让有货提醒及时到达。'], purchase: ['购买准备', '指定商品、门店与价格上限，随时接管后续购买。'] };
  currentView = Object.hasOwn(views, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== currentView; });
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === currentView;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.getElementById('view-title').textContent = views[currentView][0];
  document.getElementById('view-subtitle').textContent = views[currentView][1];
  renderOverview();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderOverview() {
  const summary = summarizeTasks(tasks, monitorState.items);
  elements['summary-products'].textContent = summary.products;
  elements['summary-tasks'].textContent = summary.tasks;
  elements['summary-stores'].textContent = '覆盖 ' + summary.stores + ' 家门店';
  elements['summary-available'].textContent = summary.available;
  elements['summary-attention'].textContent = summary.attention;
  const state = connectionHealth.state;
  const held = manualRecoveryHeld();
  const attention = held || ['cooldown','recovering'].includes(state);
  elements['attention-banner'].hidden = currentView !== 'overview' || !attention;
  elements['attention-title'].textContent = state === 'recovering' ? '正在单次验证官网服务' : held ? '官网查询受阻，监控已保护性暂停' : 'Apple 连接正在等待重试';
  elements['attention-description'].textContent = connectionHealth.message || '监控列表和历史已保留，请查看下方连接状态。';
}

function renderSelectedProduct() {
  const product = (productsByModel[elements.model.value] || []).find(item => item.Capacity === elements.capacity.value && item.Color === elements.color.value);
  const preview = elements['selected-product']; preview.replaceChildren();
  if (!product) return;
  preview.append(node('span', 'selection-caption', '所选商品'), node('strong', '', product.Model + ' · ' + product.Capacity), node('span', '', product.Color + ' · ' + product.Code));
  if (product.Price > 0) preview.append(node('span', 'selection-price', '目录参考价 HK$ ' + Number(product.Price).toLocaleString('en-HK')));
  if (timeValue(product.PreorderAt) > Date.now()) preview.append(node('span', 'preorder-note', '未开放预订 · 目录时间 ' + formatTime(product.PreorderAt)));
}

function renderMonitorState() {
  renderDesktopControls();
  const checking = Boolean(monitorState.checking);
  const notBefore = Math.max(timeValue(monitorState.notBefore), timeValue(connectionHealth.notBefore));
  const cooldown = Math.max(0, Math.ceil((notBefore - Date.now()) / 1000));
  const needsUser = manualRecoveryHeld();
  const recovering = reconnectBusy || connectionHealth.state === 'recovering';
  const waiting = monitoring && (needsUser || ['cooldown', 'recovering'].includes(connectionHealth.state));
  elements["monitor-badge"].className = "status-badge " + (checking ? "checking" : needsUser || waiting ? "warning" : monitoring ? "running" : "idle");
  elements["monitor-badge"].textContent = checking ? "正在检查" : needsUser ? "保护性暂停" : waiting ? connectionHealth.state === 'recovering' ? "正在恢复" : "等待重试" : monitoring ? "监控中" : "已暂停";
  elements.add.disabled = !initialized || pendingAction || monitoring || checking;
  elements.add.title = monitoring || checking ? "暂停监控并等待检查完成后可修改列表" : "";
  elements.start.disabled = !initialized || pendingAction || !tasks.length || monitoring || checking || needsUser || recovering;
  elements.start.title = needsUser ? "先确认官网恢复，再点击下方的单次验证；验证通过后才能启动" : "";
  elements.stop.disabled = pausePending || (!monitoring && !checking);
  elements.check.disabled = !initialized || pendingAction || !tasks.length || checking || recovering || cooldown > 0 || needsUser;
  elements.check.textContent = checking ? "检查中…" : needsUser ? "请先确认官网恢复" : cooldown > 0 ? "等待 " + cooldown + " 秒" : "立即检查";
  elements.check.title = needsUser ? "官网附近门店查询正常后，点击下方的单次验证" : cooldown > 0 ? "遵守查询间隔或异常后的重试等待时间" : "暂停时也可单次检查";
  elements["last-check"].textContent = monitorState.lastCheck ? "最近一轮检查 " + formatTime(monitorState.lastCheck) : "尚未检查";
  if (needsUser) {
    elements["next-check"].textContent = "自动查询已暂停。确认 Apple 官网附近门店查询恢复后，点击「官网恢复后，单次验证」。成功后再手动开始监控；任务和历史保留。";
  } else if (cooldown > 0) {
    elements["next-check"].textContent = "最早可再次检查：" + formatTime(notBefore) + "。查询异常时会延长等待时间。";
  } else if (monitoring && monitorState.nextCheck) {
    const due = timeValue(monitorState.nextCheck);
    elements["next-check"].textContent = "下次计划检查：" + formatTime(monitorState.nextCheck) + (due > Date.now()
      ? "（约 " + Math.ceil((due - Date.now()) / 1000) + " 秒后）" : "（等待后台调度）");
  } else {
    elements["next-check"].textContent = monitoring ? "等待后台更新下一次检查时间；电脑休眠会延迟检查。" : "暂停时仍可点击「立即检查」；历史记录会保留。";
  }
  const timing = [];
  if (Number(monitorState.actualIntervalMs) > 0) timing.push("最近实际请求间隔 " + (monitorState.actualIntervalMs / 1000).toFixed(1) + " 秒");
  if (Number(monitorState.requestDurationMs) >= 0 && monitorState.requestDurationMs != null) timing.push("请求耗时 " + (monitorState.requestDurationMs / 1000).toFixed(1) + " 秒");
  if (monitorState.lastRequestAt) timing.push("最近请求 " + formatTime(monitorState.lastRequestAt));
  elements["actual-timing"].textContent = timing.length ? timing.join(" · ") : "尚无实际请求间隔记录，完成连续检查后显示。";
  elements["history-error"].hidden = !monitorState.historyError;
  elements["history-error"].textContent = monitorState.historyError ? "历史保存异常：" + monitorState.historyError : "";
  document.querySelectorAll(".remove-button").forEach((button) => {
    button.disabled = pendingAction || monitoring || checking;
  });
}

function renderLogs() {
  elements.logs.replaceChildren();
  const log = Array.isArray(monitorState.log) ? [...monitorState.log].reverse() : [];
  if (!log.length) {
    elements.logs.append(node("p", "muted", "检查开始后，这里会显示请求进度、官网验证和重试原因。"));
    return;
  }
  for (const entry of log) {
    const row = node("p", "log-line");
    row.append(node("span", "log-time", formatTime(entry.time)), node("span", "", entry.message || ""));
    elements.logs.append(row);
  }
}

function changeHistoryMode(mode) {
  historyMode = mode;
  historyOffset = 0;
  loadHistory();
}

async function loadHistory() {
  const currentRequest = ++historyRequest;
  historyLoading = true;
  historyLoadFailed = false;
  const loadingRow = node("tr");
  const loadingCell = node("td", "history-empty", "正在读取当前筛选的历史…");
  loadingCell.colSpan = 5;
  loadingRow.append(loadingCell);
  elements["history-body"].replaceChildren(loadingRow);
  renderHistoryControls();
  try {
    const result = await request({ type: "get-history", mode: historyMode, offset: historyOffset, limit: PAGE_SIZE });
    if (currentRequest !== historyRequest) return;
    historyTotal = Number(result.total) || 0;
    if (historyOffset >= historyTotal && historyOffset > 0) {
      historyOffset = Math.max(0, Math.floor((historyTotal - 1) / PAGE_SIZE) * PAGE_SIZE);
      return loadHistory();
    }
    elements["history-body"].replaceChildren();
    const items = Array.isArray(result.items) ? result.items : [];
    for (const entry of items) renderHistoryRow(entry);
    if (!items.length) {
      const row = node("tr");
      const cell = node("td", "history-empty", historyMode === "changes"
        ? "还没有确认的库存变化。只有两次有效库存结果发生变化，才会出现在这里。"
        : "还没有检查记录。添加商品后，开始监控或立即检查一次。");
      cell.colSpan = 5;
      row.append(cell);
      elements["history-body"].append(row);
    }
    elements["history-message"].textContent = "每页 50 条，最新记录在前。失败和验证记录也会保留在「全部检查」中。";
    elements["history-message"].classList.remove("error-text");
  } catch (error) {
    if (currentRequest !== historyRequest) return;
    historyLoadFailed = true;
    const row = node("tr");
    const cell = node("td", "history-empty", "无法读取当前筛选的历史。点击上方筛选按钮可重试。");
    cell.colSpan = 5;
    row.append(cell);
    elements["history-body"].replaceChildren(row);
    elements["history-message"].textContent = "读取历史失败：" + error.message;
    elements["history-message"].classList.add("error-text");
  } finally {
    if (currentRequest === historyRequest) {
      historyLoading = false;
      renderHistoryControls();
    }
  }
}

function renderHistoryRow(entry) {
  const row = node("tr");
  row.append(node("td", "history-time", formatTime(entry.checkedAt)));
  row.append(node("td", "", entry.storeName || "—"));
  const product = node("td", "history-product");
  product.append(node("span", "", [entry.model, entry.capacity, entry.color].filter(Boolean).join(" · ")));
  product.append(node("small", "sku", entry.sku || ""));
  row.append(product);
  const status = node("td", "history-status");
  status.append(statusBadge(entry.status));
  if (entry.changed) status.append(node("small", "change-note", statusLabel(entry.previousStatus) + " → " + statusLabel(entry.status)));
  row.append(status);
  const detail = node("td", "history-detail", entry.detail || "—");
  if (entry.httpStatus && !String(entry.detail || "").includes(String(entry.httpStatus))) detail.append(node("small", "", "HTTP " + entry.httpStatus));
  row.append(detail);
  elements["history-body"].append(row);
}

function renderHistoryControls() {
  elements["history-all"].setAttribute("aria-pressed", String(historyMode === "all"));
  elements["history-changes"].setAttribute("aria-pressed", String(historyMode === "changes"));
  elements["history-prev"].disabled = historyLoading || historyLoadFailed || historyOffset === 0;
  elements["history-next"].disabled = historyLoading || historyLoadFailed || historyOffset + PAGE_SIZE >= historyTotal;
  elements["history-page"].textContent = historyLoading ? "正在读取…" : historyLoadFailed ? "读取失败" : historyTotal
    ? "第 " + (Math.floor(historyOffset / PAGE_SIZE) + 1) + " / " + Math.ceil(historyTotal / PAGE_SIZE) + " 页 · 共 " + historyTotal + " 条"
    : "共 0 条";
}

async function exportHistory() {
  elements["history-export"].disabled = true;
  elements["history-export"].textContent = "正在导出…";
  try {
    const result = await request({ type: "export-history", mode: historyMode });
    if (typeof result.csv !== "string") throw new Error("导出内容为空");
    downloadFile(result.csv.startsWith("\uFEFF") ? result.csv : "\uFEFF" + result.csv, "text/csv;charset=utf-8",
      "Apple香港库存-" + (historyMode === "changes" ? "库存变化" : "全部检查") + "-" + new Date().toISOString().slice(0, 10) + ".csv");
    elements["history-message"].textContent = "已导出当前筛选下的全部历史记录。";
    elements["history-message"].classList.remove("error-text");
  } catch (error) {
    elements["history-message"].textContent = "导出失败：" + error.message;
    elements["history-message"].classList.add("error-text");
  } finally {
    elements["history-export"].disabled = false;
    elements["history-export"].textContent = "导出 CSV";
  }
}

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function statusBadge(status) {
  return node("span", "task-status " + statusClass(status), statusLabel(status));
}




function setFormMessage(message, isError = false) {
  elements["form-message"].textContent = message;
  elements["form-message"].classList.toggle("error-text", isError);
  elements['global-message'].textContent = message;
  elements['global-message'].hidden = !message;
  elements['global-message'].classList.toggle('error-text', isError);
}

function timeValue(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatTime(value) {
  const time = timeValue(value);
  return time ? new Date(time).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Hong_Kong" }) : value || "—";
}
