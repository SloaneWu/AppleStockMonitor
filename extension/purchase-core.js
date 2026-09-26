export const HK_STORES = ['R428', 'R499', 'R409', 'R485', 'R673', 'R610'];
export const DEFAULT_PURCHASE_SETTINGS = { enabled: false, sku: '', maxPrice: null, quantity: 1, storePriority: [...HK_STORES] };
export const TERMINAL_PURCHASE_STATUSES = ['added', 'needs-user'];

export function priceNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : NaN;
  const text = String(value ?? '').trim().replace(/^(HK\$|HKD)\s*/i, '').replaceAll(',', '');
  return /^\d+(\.\d{1,2})?$/.test(text) && Number(text) > 0 ? Number(text) : NaN;
}

export function purchaseURL(product) {
  if (!/^[A-Z0-9]+ZA\/A$/.test(product?.Code || '')) throw new Error('自动加袋仅支持香港目录中的准确 SKU');
  const path = product.PurchasePath;
  if (path) {
    const url = new URL(path.startsWith('/shop/') ? '/hk-zh' + path : path, 'https://www.apple.com/hk-zh');
    if (url.origin !== 'https://www.apple.com' || !/^\/hk(?:-zh)?\/shop\/(?:buy-iphone|product)\//.test(url.pathname) || url.username || url.password || url.search || url.hash) {
      throw new Error('商品选配链接不属于 Apple 香港商品页');
    }
    return url.href;
  }
  return 'https://www.apple.com/hk-zh/shop/product/' + product.Code;
}

export function validatePurchaseSettings(input, product) {
  if (!input || typeof input !== 'object') throw new Error('自动加袋设置无效');
  const enabled = input.enabled === true;
  const sku = String(input.sku || '').trim();
  if (input.quantity !== undefined && input.quantity !== 1) throw new Error('自动加袋数量必须为 1');
  const storePriority = input.storePriority ?? HK_STORES;
  if (!Array.isArray(storePriority) || !storePriority.length || storePriority.length > 6 || new Set(storePriority).size !== storePriority.length || storePriority.some(s => !HK_STORES.includes(s))) {
    throw new Error('请选择不重复的香港门店优先顺序');
  }
  const maxPrice = priceNumber(input.maxPrice);
  if (enabled || sku) {
    if (!product || product.Code !== sku || !product.Model || !product.Color || !product.Capacity || !/^iPhone\b/.test(product.Model)) throw new Error('请从目录选择准确的 iPhone 型号、颜色和容量');
    purchaseURL(product);
  }
  if (enabled && (!Number.isFinite(maxPrice) || !Number.isFinite(priceNumber(product.Price)))) throw new Error('请填写港币价格上限，且商品必须有可核对的官网价格');
  if (enabled && priceNumber(product.Price) > maxPrice) throw new Error('官网目录价格高于你设置的价格上限');
  return { enabled, sku, maxPrice: Number.isFinite(maxPrice) ? maxPrice : null, quantity: 1, storePriority: [...storePriority] };
}

export function chooseAvailableTask(tasks, settings) {
  return settings.storePriority.map(store => (tasks || []).find(task => task?.areaCode === 'hk' && task.product?.Code === settings.sku && task.store?.StoreNumber === store)).find(Boolean);
}

export function checkProductSnapshot(snapshot, product, settings) {
  if (!snapshot?.verified || snapshot.kind !== 'product') throw new Error(snapshot?.detail || '无法可靠核对商品页面，请手动确认');
  if (snapshot.sku !== product.Code || snapshot.quantity !== 1 || snapshot.currency !== 'HKD') throw new Error('页面 SKU、数量或币种与授权不一致，已停止');
  if (!Number.isFinite(snapshot.price) || snapshot.price <= 0 || snapshot.price > settings.maxPrice || snapshot.price !== priceNumber(product.Price)) throw new Error('页面价格不匹配或超过上限，已停止');
  if (!snapshot.addAvailable) throw new Error('网页尚未提供可直接点击的“加入购物袋”，请手动完成选配');
}

export function verifyAddedBag(snapshot, product, settings) {
  if (!snapshot?.verified || snapshot.kind !== 'bag' || snapshot.items?.length !== 1) return false;
  const item = snapshot.items[0];
  return item.sku === product.Code && item.quantity === 1 && item.currency === 'HKD' && Number.isFinite(item.price) && item.price > 0 && item.price <= settings.maxPrice && item.price === priceNumber(product.Price);
}
