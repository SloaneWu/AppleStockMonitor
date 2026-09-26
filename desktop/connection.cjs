'use strict';
// Observe only the program's dedicated Apple session. Do not retain URLs,
// query strings, headers, cookies, response bodies or unrelated browsing data.
const BLOCKED = new Set([401, 403, 429, 541]);
function requestKind(value, resourceType) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.apple.com') return null;
    if (/^\/hk(?:-zh)?\/shop\/fulfillment-messages$/.test(url.pathname)) return 'pickup';
    if (resourceType === 'mainFrame' && /^\/hk(?:-zh)?\/shop\//.test(url.pathname)) return 'page';
  } catch {}
  return null;
}
function responseKind(headers = {}) {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type');
  const value = String(entry?.[1] || '');
  return /json/i.test(value) ? 'json' : /html/i.test(value) ? 'html' : 'other';
}
function createConnectionState(now = Date.now) {
  let loading = true, loadError = '', generation = 0, pickup = null, page = null;
  let monitorRequests = 0, approvedGeneration = -1, recent = [];
  const record = row => { recent = [...recent, { at: new Date(now()).toISOString(), ...row }].slice(-24); };
  return {
    begin() { generation++; loading = true; loadError = ''; pickup = null; page = null; approvedGeneration = -1; },
    loaded() { loading = false; },
    failed() { loading = false; loadError = '官网页面加载失败，请在官网窗口手动检查网络连接。'; },
    observe(details) {
      const kind = requestKind(details.url, details.resourceType);
      if (!kind) return;
      const row = { kind, status: Number(details.statusCode) || 0, responseKind: responseKind(details.responseHeaders) };
      if (kind === 'page') page = row;
      else pickup = row;
      record(row);
    },
    // A monitor result is distinguished from ordinary page traffic. Only a
    // completed bridge response can admit later scheduled monitor requests.
    monitorResult(result) {
      monitorRequests++;
      record({ kind: 'monitor', status: Number(result?.status) || 0, responseKind: result?.responseKind || 'unknown' });
      if (result?.status === 200 && result.responseKind === 'json') approvedGeneration = generation;
      else { approvedGeneration = -1; pickup = null; }
    },
    readiness() {
      if (loadError) return { ready: false, reason: 'page-load-failed', message: loadError };
      if (loading) return { ready: false, reason: 'page-loading', message: '官网页面仍在加载，尚未发送库存查询。' };
      if (page && BLOCKED.has(page.status)) return { ready: false, reason: 'website-blocked', status: page.status,
        message: `官网页面本身返回 HTTP ${page.status}，程序未追加库存请求。请在官网窗口确认页面恢复。` };
      if (pickup && (BLOCKED.has(pickup.status) || pickup.responseKind === 'html')) return {
        ready: false, reason: 'website-blocked', status: pickup.status,
        message: `官网自己的门店接口返回 ${pickup.status ? 'HTTP ' + pickup.status : '异常响应'}，程序未追加库存请求。请等待官网门店查询恢复。`
      };
      if (approvedGeneration === generation || (pickup?.status === 200 && pickup.responseKind === 'json')) return { ready: true };
      return { ready: false, reason: 'website-not-ready', message: '首次连接尚未完成：请在已打开的官网窗口查询一次“查找附近的店铺”，再返回点击“连接官网，单次验证”。目前没有发送监控库存请求。' };
    },
    snapshot() { return { loading, loadFailed: Boolean(loadError), monitorRequests, readiness: this.readiness(), recent: recent.map(row => ({ ...row })) }; }
  };
}
module.exports = { createConnectionState, requestKind };
