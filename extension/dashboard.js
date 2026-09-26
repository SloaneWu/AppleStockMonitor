// Accept the worker's persisted Chinese labels and the bridge's enum values.
export function statusLabel(status) {
  return ({ available: '有货', unavailable: '无货', ineligible: '不可提取', unknown: '状态未知',
    error: '查询异常', verification_required: '需官网验证', rate_limited: '请求受限', preorder: '未开放预订',
    not_open: '未开放预订' })[status] || status || '尚未检查';
}

export function statusCategory(status) {
  const label = statusLabel(status);
  if (label === '有货') return 'available';
  if (['查询异常', '状态未知', '官网查询受阻', '需官网验证', '请求受限', '等待恢复'].includes(label)) return 'attention';
  if (['尚未检查', '未开放预订'].includes(label)) return 'waiting';
  return 'other';
}

export function statusClass(status) {
  const label = statusLabel(status);
  if (label === '有货') return 'in-stock';
  if (label === '无货') return 'out-of-stock';
  if (['官网查询受阻', '需官网验证', '请求受限', '等待恢复', '不可提取', '未开放预订'].includes(label)) return 'verify';
  if (['查询异常', '状态未知'].includes(label)) return 'error';
  return 'neutral';
}

export function isKnownStatus(status) {
  return ['有货', '无货', '不可提取'].includes(statusLabel(status));
}

export function taskMatches(task, items = {}, query = '', filter = 'all') {
  const text = [task.product.Model, task.product.Capacity, task.product.Color, task.product.Code,
    task.store.CityStoreName, task.store.City].join(' ').toLocaleLowerCase();
  if (!text.includes(query.trim().toLocaleLowerCase())) return false;
  return filter === 'all' || filter === statusCategory(items?.[task.id]?.status);
}

export function summarizeTasks(tasks, items = {}) {
  return {
    products: new Set(tasks.map(task => task.product.Code)).size,
    tasks: tasks.length,
    stores: new Set(tasks.map(task => task.store.StoreNumber)).size,
    available: tasks.filter(task => statusCategory(items?.[task.id]?.status) === 'available').length,
    attention: tasks.filter(task => statusCategory(items?.[task.id]?.status) === 'attention').length
  };
}
