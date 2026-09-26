export const AREAS = [{ code: "hk", title: "香港" }];

export const CHECK_INTERVAL_MINUTES = 1;

const WATCH_PATHS = {
  watchs12: "/shop/buy-watch/apple-watch",
  watchse3: "/shop/buy-watch/apple-watch-se",
  watchultra4: "/shop/buy-watch/apple-watch-ultra"
};

const IPHONE_PATHS = {
  "iPhone 18 Pro": { family: "iphone-18-pro", screen: "6.3" },
  "iPhone 18 Pro Max": { family: "iphone-18-pro", screen: "6.9" },
  "iPhone Duo": { family: "iphone-duo", screen: "7.6" }
};
const OFFICIAL_COLORS = {
  "布根地红色": "布根地紅色", "布根地紅色": "布根地紅色", "冰川色": "冰川色",
  "银色": "銀色", "銀色": "銀色", "黑色": "黑色", "星光白色": "星光白色", "夜空色": "夜空色"
};

function localPurchasePath(value) {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      /[\\?#\s\u0000-\u001f\u007f]/u.test(value) || /%[0-7][0-9a-f]/i.test(value)) {
    throw new Error("产品选配地址无效");
  }
  const path = value.startsWith("/hk-zh/shop/") ? value.slice("/hk-zh".length) : value;
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw new Error("产品选配地址编码无效"); }
  if (!path.startsWith("/shop/") || decoded.includes("//") ||
      decoded.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("产品选配地址无效");
  }
  return { path, decoded };
}

export function appleBaseURL(areaCode) {
  if (areaCode === "hk") {
    return "https://www.apple.com/hk-zh";
  }
  throw new Error("不支持的地区: " + areaCode);
}

export function productPurchaseURL(task) {
  const baseURL = appleBaseURL(task.areaCode);
  const defaultWatchPath = WATCH_PATHS[task.product.Type];
  if (defaultWatchPath) {
    const { path, decoded } = localPurchasePath(task.product.PurchasePath || defaultWatchPath);
    if (decoded !== defaultWatchPath && !new RegExp("^" + defaultWatchPath + "/[a-z0-9-]+$").test(decoded)) {
      throw new Error("手表选配地址无效");
    }
    return baseURL + path;
  }

  if (task.product.PurchasePath) {
    const { path, decoded } = localPurchasePath(task.product.PurchasePath);
    const spec = IPHONE_PATHS[task.product.Model];
    const color = OFFICIAL_COLORS[task.product.Color];
    const allowedColors = task.product.Model === "iPhone Duo"
      ? ["星光白色", "夜空色"] : ["布根地紅色", "冰川色", "銀色", "黑色"];
    const capacity = String(task.product.Capacity || "").toLowerCase();
    if (!spec || !allowedColors.includes(color) || !["256gb", "512gb", "1tb", "2tb"].includes(capacity) ||
        decoded !== `/shop/buy-iphone/${spec.family}/${spec.screen}-吋顯示器-${capacity}-${color}`) {
      throw new Error("iPhone 选配地址与型号、容量或颜色不一致");
    }
    return baseURL + path;
  }

  const code = String(task.product.Code || "");
  if (!/^[A-Z0-9]+ZA\/A$/.test(code)) {
    throw new Error("香港产品 SKU 无效");
  }
  return baseURL + "/shop/product/" + code;
}

export function buildFulfillmentPath(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("监控任务为空");
  }

  for (const task of tasks) {
    if (task?.areaCode !== "hk") {
      throw new Error("本版本仅支持香港门店");
    }
    if (!/^[A-Z0-9]+ZA\/A$/.test(task?.product?.Code || "")) {
      throw new Error("香港产品 SKU 无效");
    }
  }

  const codes = unique(tasks.map((task) => task.product.Code));
  if (codes.length > 8) {
    throw new Error("每批最多查询 8 个不同 SKU");
  }
  const params = new URLSearchParams({ fae: "true", pl: "true", location: "central" });
  codes.forEach((code, index) => {
    params.set("mts." + index, "regular");
    params.set("parts." + index, code);
  });
  return "/hk-zh/shop/fulfillment-messages?" + params.toString();
}

function unknown(reason, pickupDisplay = "", detail = "") {
  return { known: false, available: false, pickupDisplay, detail, reason };
}

function readableText(value) {
  return typeof value === "string"
    ? value.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 600)
    : "";
}

function hasError(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export function parseStockResponse(payload, storeNumber, productCode) {
  if (!payload || typeof payload !== "object" || !storeNumber || !productCode) {
    return unknown("响应格式或门店 SKU 无效");
  }
  const pickupMessage = payload?.body?.content?.pickupMessage;
  const status = payload.head?.status;
  if ((status !== undefined && (!Number.isFinite(Number(status)) || Number(status) < 200 || Number(status) >= 300)) ||
      [payload.error, payload.errors, payload.body?.error, payload.body?.errors,
        pickupMessage?.error, pickupMessage?.errors, pickupMessage?.pickupSearchError].some(hasError)) {
    return unknown("Apple 返回查询错误，不能确定库存");
  }
  const candidates = [payload.body?.stores, pickupMessage?.stores].filter(Array.isArray).flat();
  const exactStores = candidates.filter((store) => store?.storeNumber === String(storeNumber));
  if (!exactStores.length) {
    return unknown("响应未包含该门店的库存");
  }
  const availabilities = exactStores
    .filter((store) => store.partsAvailability && Object.hasOwn(store.partsAvailability, productCode))
    .map((store) => store.partsAvailability[productCode])
    .filter((value) => value && typeof value === "object");
  if (!availabilities.length) {
    return unknown("响应未包含该门店的指定 SKU");
  }
  const results = availabilities.map((availability) => {
    const regular = availability.messageTypes?.regular;
    const pickupDisplay = typeof availability.pickupDisplay === "string" && availability.pickupDisplay
      ? availability.pickupDisplay
      : (typeof regular?.pickupDisplay === "string" ? regular.pickupDisplay : "");
    const detail = [...new Set([
      availability.pickupDisplayString, availability.pickupQuote, availability.pickupSubQuote,
      regular?.storePickupQuote, regular?.storePickupQuote2, regular?.pickupQuote, regular?.pickupSubQuote
    ].map(readableText).filter(Boolean))].join(" · ");
    if (!["available", "unavailable", "ineligible"].includes(pickupDisplay)) {
      return unknown(pickupDisplay ? "Apple 返回未识别的提取状态" : "响应缺少提取状态", pickupDisplay, detail);
    }
    return { known: true, available: pickupDisplay === "available", pickupDisplay, detail, reason: "" };
  });
  const known = results.filter((result) => result.known);
  if (new Set(known.map((result) => result.pickupDisplay)).size > 1) {
    return unknown("响应中的同一门店 SKU 状态相互冲突");
  }
  return known[0] || results[0];
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function groupProductsByModel(productGroups) {
  const models = {};
  for (const product of Object.values(productGroups || {}).flat()) {
    if (product?.Model) {
      (models[product.Model] ||= []).push(product);
    }
  }
  return models;
}
