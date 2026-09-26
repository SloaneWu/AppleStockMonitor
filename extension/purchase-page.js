// Injected into the isolated world, on demand, in the manager's separate tab.
// Uses only rendered Apple controls. Never calls cart/checkout APIs, changes
// existing bag items, fills payment forms, or interacts with verification.
(() => {
  if (globalThis.__APPLE_HK_PURCHASE__) return;
  globalThis.__APPLE_HK_PURCHASE__ = true;
  const api = globalThis.chrome;
  let clicked = false;
  const normalize = value => String(value || '').normalize('NFKC').replace(/銀/g, '银').replace(/紅/g, '红').replace(/\s+/g, '').toLowerCase();
  const visible = element => Boolean(element && !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length);
  const all = (root, selector) => [...root.querySelectorAll(selector)];
  const text = element => element?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const failure = detail => ({ verified: false, detail });
  function hkPage() { return location.origin === 'https://www.apple.com' && /^\/hk(?:-zh)?\/shop\//.test(location.pathname); }
  function blocked() {
    if (!hkPage() || /\/(?:checkout|signin|sign-in|login|payment)(?:\/|$)/i.test(location.pathname)) return true;
    return all(document, 'input[type="password"], iframe[src*="captcha"], [data-autom="captcha"]').some(visible);
  }
  function money(value) {
    const matches = [...String(value || '').matchAll(/(?:HK\$|HKD)\s*([\d,]+(?:\.\d{1,2})?)/g)];
    const values = [...new Set(matches.map(match => Number(match[1].replaceAll(',', ''))))];
    return values.length === 1 && values[0] > 0 ? values[0] : NaN;
  }
  function bagSnapshot() {
    if (blocked() || !/^\/hk(?:-zh)?\/shop\/bag\/?$/.test(location.pathname)) return failure('未处于可读取的香港购物袋页面；登录或验证请手动完成');
    const containers = all(document, '.rs-bag-item');
    const empty = all(document, '.rs-bagempty .rs-bag-header').find(visible);
    if (!containers.length && empty && /(?:購物袋沒有任何項目|购物袋没有任何项目|bag is empty)/i.test(text(empty))) return { kind: 'bag', verified: true, empty: true, items: [] };
    if (!containers.length) return failure('购物袋仍在加载或结构无法核对');
    const items = [];
    for (const item of containers) {
      const link = item.querySelector('[data-autom="bag-item-name"]');
      const source = decodeURIComponent(link?.getAttribute('href') || '') + ' ' + text(item.querySelector('.rs-iteminfo-partnumber'));
      const skus = [...new Set(source.match(/[A-Z0-9]+ZA\/A\b/g) || [])];
      const quantityInput = item.querySelector('[data-autom="item-quantity-dropdown"]');
      const quantity = Number(quantityInput?.value);
      const prices = all(item, '.rs-iteminfo-price').filter(visible).map(e => money(text(e)));
      if (skus.length !== 1 || !Number.isInteger(quantity) || quantity < 1 || prices.some(value => !Number.isFinite(value)) || new Set(prices).size !== 1) return failure('购物袋商品的 SKU、数量或港币价格无法逐项核实，请手动检查');
      items.push({ sku: skus[0], quantity, price: prices[0], currency: 'HKD' });
    }
    return { kind: 'bag', verified: true, empty: false, items };
  }
  function productSnapshot(expected) {
    if (blocked() || !/^\/hk(?:-zh)?\/shop\/(?:buy-iphone|product)\//.test(location.pathname)) return failure('当前不是可确认的香港商品页，登录或验证请手动完成');
    if (!expected || !/^[A-Z0-9]+ZA\/A$/.test(expected.sku || '') || expected.quantity !== 1 || !Number.isFinite(expected.price) || !Number.isFinite(expected.maxPrice)) return failure('购买授权缺少准确的 SKU、价格或数量');
    const products = [];
    for (const script of all(document, 'script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        for (const candidate of (Array.isArray(data) ? data : data['@graph'] || [data])) {
          if (candidate['@type'] !== 'Product') continue;
          const url = new URL(candidate.url, location.href);
          if (url.origin === location.origin && decodeURIComponent(url.pathname) === decodeURIComponent(location.pathname)) products.push(candidate);
        }
      } catch {}
    }
    if (products.length !== 1) return failure('无法从当前页面核实唯一的商品信息');
    const product = products[0];
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    if (offers.length !== 1 || offers[0]?.sku !== expected.sku || offers[0]?.priceCurrency !== 'HKD') return failure('当前商品 SKU 或币种与授权不一致');
    const price = Number(offers[0].price);
    if (price !== expected.price || price > expected.maxPrice || !(price > 0)) return failure('当前商品价格不匹配或超过上限');
    if (![expected.model, expected.capacity, expected.color].every(part => part && normalize(product.name).includes(normalize(part)))) return failure('商品型号、容量或颜色与授权不一致');
    const buttons = all(document, 'button, input[type="submit"]').filter(button => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && /^(?:加入購物袋|加入购物袋|Add to Bag)$/i.test(text(button) || button.value || ''));
    if (buttons.length !== 1) return failure('页面尚未提供唯一的“加入购物袋”按钮，请手动完成选配');
    const button = buttons[0];
    const form = button.form || button.closest('form');
    if (!form) return failure('无法核实加入购物袋对应的商品表单');
    const formSKUs = all(form, 'input[name="product"], input[name="part"], input[name="partNumber"]').map(input => input.value).filter(Boolean);
    if (!formSKUs.length || formSKUs.some(sku => sku !== expected.sku)) return failure('当前选配表单的 SKU 无法确认，已停止');
    const quantities = all(form, 'input[name="quantity"], select[name="quantity"]').map(input => Number(input.value));
    if (quantities.length !== 1 || quantities[0] !== 1) return failure('选配表单未明确标明单件数量，需手动确认');
    const summaryPrices = all(document, '[data-autom="summaryHeroPrice"], [data-autom="summaryPrice"], [data-autom="full-price"]').filter(visible).map(e => money(text(e)));
    if (!summaryPrices.length || summaryPrices.some(value => !Number.isFinite(value) || value !== price)) return failure('页面当前显示价格与商品价格不一致，可能有附加服务或分期选项，请手动确认');
    return { kind: 'product', verified: true, sku: expected.sku, quantity: 1, currency: 'HKD', price, addAvailable: true, button };
  }
  async function inspect(reader) {
    let snapshot;
    for (let attempt = 0; attempt < 20; attempt++) {
      snapshot = reader();
      if (snapshot.verified || blocked()) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return snapshot;
  }
  api.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender?.id !== api.runtime.id || sender.tab || (sender.url && !sender.url.startsWith(api.runtime.getURL(''))) || !hkPage()) return false;
    if (!['purchase-inspect-bag', 'purchase-inspect-product', 'purchase-add-once'].includes(message?.type)) return false;
    (async () => {
      if (message.type === 'purchase-inspect-bag') return inspect(bagSnapshot);
      if (message.type === 'purchase-inspect-product') {
        const { button, ...snapshot } = await inspect(() => productSnapshot(message.expected));
        return snapshot;
      }
      if (clicked) return failure('本标签页已经尝试过加袋，不会重复点击');
      const { button, ...snapshot } = productSnapshot(message.expected);
      if (!snapshot.verified) return snapshot;
      // Set the local guard before invoking any page code. The manager has
      // already persisted its cross-reload SKU lock before sending this message.
      clicked = true;
      button.click();
      return { clicked: true, detail: '已点击一次加入购物袋；仍需读取购物袋确认结果' };
    })().then(reply).catch(() => reply(failure('官网页面操作未完成，结果需人工检查；不会重试')));
    return true;
  });
})();
