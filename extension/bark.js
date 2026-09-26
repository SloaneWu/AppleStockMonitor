import { productPurchaseURL } from './shared.js';

const ENDPOINT = 'https://api.day.app/push';
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,200}$/;

export function parseBarkKey(input) {
  const value = String(input || '').trim();
  if (KEY_PATTERN.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://api.day.app' || url.username || url.password || url.search || url.hash) throw new Error();
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1 || !KEY_PATTERN.test(parts[0])) throw new Error();
    return parts[0];
  } catch {
    // Never include the original address or device key in an error message.
    throw new Error('请输入 Bark 设备密钥，或 https://api.day.app/设备密钥（不含推送标题、正文或参数）');
  }
}

export function stockBarkMessages(tasks, checkedAt) {
  const groups = new Map();
  for (const task of tasks) {
    const group = groups.get(task.product.Code) || { task, stores: new Set() };
    group.stores.add(task.store.CityStoreName);
    groups.set(task.product.Code, group);
  }
  return [...groups.values()].map(({ task, stores }) => ({
    title: `${task.product.Model} 有货`,
    body: `${task.product.Capacity} · ${task.product.Color}\n门店：${[...stores].join('、')}\n检查：${new Date(checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false })}\n以 Apple 官网实际提取情况为准。`,
    url: productPurchaseURL(task),
    group: 'Apple 香港库存'
  }));
}

export async function sendBark(deviceKey, message, { fetcher = fetch, timeoutMs = 10000 } = {}) {
  // Fixed HTTPS destination and a POST body keep the key out of URLs and logs.
  const key = parseBarkKey(deviceKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetcher(ENDPOINT, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_key: key, title: message.title, body: message.body,
        group: message.group || 'Apple 香港库存', ...(message.url ? { url: message.url } : {}) }),
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, message: `Bark 推送失败（HTTP ${response.status}），请检查设备密钥及网络。` };
    let result;
    try { result = await response.json(); }
    catch { return { ok: false, message: 'Bark 返回了无法识别的响应，未确认发送成功。' }; }
    if (result?.code !== 200) return { ok: false, message: 'Bark 未接受推送，请检查设备密钥是否有效。' };
    return { ok: true, message: 'Bark 服务器已接受通知，请查看手机。' };
  } catch {
    return { ok: false, message: controller.signal.aborted
      ? 'Bark 请求超时，是否送达未知；为避免重复提醒，不自动重发。'
      : '无法连接 Bark，未确认发送成功；请检查网络及扩展的网站访问权限。' };
  } finally { clearTimeout(timer); }
}
