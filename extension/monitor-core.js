import { parseStockResponse } from './shared.js';

export const STATUS = { available: '有货', unavailable: '无货', ineligible: '不可提取' };
export const MIN_INTERVAL_MS = 60000;

export function groupTasks(tasks) {
  const skus = [...new Set(tasks.map(t => t.product.Code))].sort();
  const groups = [];
  for (let i = 0; i < skus.length; i += 8) {
    const selected = new Set(skus.slice(i, i + 8));
    groups.push(tasks.filter(t => selected.has(t.product.Code)));
  }
  return groups;
}

export function groupKey(tasks) {
  return [...new Set(tasks.map(t => t.product.Code))].sort().join('|');
}

export function retryDelay(failures, retryAfter, now = Date.now()) {
  let delay = Math.min(900000, MIN_INTERVAL_MS * 2 ** Math.min(failures, 4));
  if (retryAfter != null && String(retryAfter).trim()) {
    const seconds = Number(retryAfter);
    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(requested) && requested > 0) delay = Math.max(delay, requested);
  }
  return delay;
}

export function classifyResponse(result, tasks) {
  let payload;
  let status, detail;
  if ([401, 403, 541].includes(result?.status)) {
    status = '官网查询受阻';
    detail = `HTTP ${result.status}：官网查询受阻，原因尚未确定；自动监控已暂停。待官网附近门店查询恢复后，点击“官网恢复后，单次验证”。`;
  } else if (result?.status === 429) {
    status = '请求受限'; detail = 'HTTP 429：官网限制查询频率，自动监控已暂停。等待结束并确认官网恢复后，可手动单次验证。';
  } else if (result?.status !== 200) {
    status = '查询异常'; detail = result?.error || `Apple 接口返回 HTTP ${result?.status || 0}`;
  } else {
    try { payload = JSON.parse(result.body); }
    catch { status = '查询异常'; detail = 'HTTP 200，但返回的不是库存 JSON（可能为官网验证页）。'; }
  }
  return tasks.map(task => {
    if (status) return { task, status, detail, known: false, httpStatus: result?.status || 0 };
    const parsed = parseStockResponse(payload, task.store.StoreNumber, task.product.Code);
    const known = parsed.known && Object.hasOwn(STATUS, parsed.pickupDisplay);
    return {
      task, known, httpStatus: 200,
      status: known ? STATUS[parsed.pickupDisplay] : '查询异常',
      detail: known
        ? `${parsed.detail || ''}${parsed.detail ? ' · ' : ''}官网状态：${parsed.pickupDisplay}${parsed.pickupDisplay === 'ineligible' ? '（当前不可到店提取，不代表库存数量）' : ''}`
        : (parsed.reason || '响应中缺少准确的门店、SKU 或可识别的库存状态') +
          (parsed.pickupDisplay ? ' · 官网原始状态：' + String(parsed.pickupDisplay).slice(0, 100) : ''),
      pickupDisplay: parsed.pickupDisplay || ''
    };
  });
}

export function recordOutcome(outcome, previous, checkedAt) {
  const { task, status, detail, known, httpStatus } = outcome;
  const lastSuccess = previous?.lastSuccess;
  const changed = Boolean(known && lastSuccess && lastSuccess.status !== status);
  const item = {
    status, detail, checkedAt, httpStatus,
    lastSuccess: known ? { status, detail, checkedAt } : (lastSuccess || null)
  };
  return {
    item,
    notify: known && status === '有货' && lastSuccess?.status !== '有货',
    row: {
      checkedAt, taskId: task.id, storeName: task.store.CityStoreName,
      model: task.product.Model, capacity: task.product.Capacity, color: task.product.Color,
      sku: task.product.Code, status, detail, httpStatus, changed,
      previousStatus: lastSuccess?.status || ''
    }
  };
}
