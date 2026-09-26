import assert from "node:assert/strict";
import test from "node:test";
import { AREAS, CHECK_INTERVAL_MINUTES, appleBaseURL, buildFulfillmentPath, groupProductsByModel,
  parseStockResponse, productPurchaseURL } from "./shared.js";

const SKU = "MJXW4ZA/A";
const task = { areaCode: "hk", store: { StoreNumber: "R428" },
  product: { Model: "iPhone 18 Pro Max", Code: SKU, Type: "iphone18pro" } };
const store = (pickupDisplay, overrides = {}) => ({ storeNumber: "R428",
  partsAvailability: { [SKU]: { pickupDisplay, ...overrides } } });
const parse = (payload) => parseStockResponse(payload, "R428", SKU);

test("Hong Kong Chinese storefront and a one-minute interval", () => {
  assert.deepEqual(AREAS, [{ code: "hk", title: "香港" }]);
  assert.equal(CHECK_INTERVAL_MINUTES, 1);
  assert.equal(appleBaseURL("hk"), "https://www.apple.com/hk-zh");
  assert.equal(productPurchaseURL(task), "https://www.apple.com/hk-zh/shop/product/" + SKU);
  assert.throws(() => appleBaseURL("cn"));
});

test("one Central query deduplicates SKUs shared by different stores", () => {
  const path = buildFulfillmentPath([task, { ...task, store: { StoreNumber: "R499" } },
    { ...task, product: { ...task.product, Code: "MJXT4ZA/A" } }]);
  const url = new URL(path, "https://www.apple.com");
  assert.equal(url.pathname, "/hk-zh/shop/fulfillment-messages");
  assert.equal(url.searchParams.get("location"), "central");
  assert.equal(url.searchParams.has("store"), false);
  assert.equal(url.searchParams.get("parts.0"), SKU);
  assert.equal(url.searchParams.get("parts.1"), "MJXT4ZA/A");
  assert.equal(url.searchParams.has("parts.2"), false);
  assert.equal(url.searchParams.get("mts.1"), "regular");
  assert.throws(() => buildFulfillmentPath([]));
  assert.throws(() => buildFulfillmentPath([{ ...task, areaCode: "us" }]));
  assert.throws(() => buildFulfillmentPath([{ ...task, product: { Code: "bad&sku" } }]));
  assert.throws(() => buildFulfillmentPath(Array.from({ length: 9 }, (_, n) =>
    ({ ...task, product: { Code: `M${n}ZA/A` } }))));
});

test("only three exact tokens have a known store-specific meaning", () => {
  for (const token of ["available", "unavailable", "ineligible"]) {
    assert.deepEqual(parse({ body: { stores: [store(token)] } }), {
      known: true, available: token === "available", pickupDisplay: token, detail: "", reason: ""
    });
  }
  for (const token of ["", "unknown", "Available", "available ", "comingSoon", true, null, 0]) {
    const result = parse({ body: { stores: [store(token)] } });
    assert.equal(result.known, false, String(token));
    assert.equal(result.available, false);
    assert.ok(result.reason);
  }
});

test("extracts readable pickup text alongside the exact status", () => {
  const result = parse({ body: { stores: [store("available", {
    pickupQuote: "今日 <b>可提取</b>",
    messageTypes: { regular: { storePickupQuote: "約&nbsp;1 小時後" } }
  })] } });
  assert.equal(result.detail, "今日 可提取 · 約 1 小時後");
});

test("nested per-store format remains visible when the first format lacks this store/SKU", () => {
  const payload = { body: { stores: [{ storeNumber: "R499", partsAvailability: { [SKU]: { pickupDisplay: "unavailable" } } }],
    content: { pickupMessage: { stores: [store("available")] } } } };
  assert.equal(parse(payload).available, true);
  payload.body.stores = [{ storeNumber: "R428", partsAvailability: { OTHER: { pickupDisplay: "unavailable" } } }];
  assert.equal(parse(payload).available, true);
  payload.body.stores = [store("unrecognized")];
  assert.equal(parse(payload).available, true);
});

test("regular message status is accepted only inside the exact store and SKU", () => {
  const payload = { body: { content: { pickupMessage: { stores: [store(undefined, {
    messageTypes: { regular: { pickupDisplay: "ineligible" } }
  })] } } } };
  assert.equal(parse(payload).pickupDisplay, "ineligible");
  assert.equal(parseStockResponse(payload, "R499", SKU).known, false);
  assert.equal(parseStockResponse(payload, "R428", "OTHER").known, false);
});

test("eligibility alone cannot assert availability for any store", () => {
  for (const pickupDisplay of ["available", "unavailable", "ineligible"]) {
    const payload = { body: { content: { pickupMessage: {
      pickupEligibility: { [SKU]: { pickupDisplay } }
    } } } };
    assert.equal(parse(payload).known, false);
  }
});

test("missing, malformed, and conflicting responses remain unknown", () => {
  for (const payload of [null, {}, "html", { body: { stores: [] } },
    { body: { stores: [null, { storeNumber: "R428" }] } }]) {
    assert.equal(parse(payload).known, false);
  }
  const result = parse({ body: { stores: [store("available")],
    content: { pickupMessage: { stores: [store("unavailable")] } } } });
  assert.equal(result.known, false);
  assert.match(result.reason, /冲突/);
});

test("an application-level error overrides a stale or contradictory store entry", () => {
  const good = { body: { stores: [store("available")] } };
  assert.equal(parse({ ...good, head: { status: "200" } }).known, true);
  for (const status of [0, 302, 400, 541, "invalid"]) {
    assert.equal(parse({ ...good, head: { status } }).known, false);
  }
  assert.equal(parse({ ...good, error: "server failure" }).known, false);
  assert.equal(parse({ body: { ...good.body, errors: [{ message: "invalid location" }] } }).known, false);
  assert.equal(parse({ body: { ...good.body,
    content: { pickupMessage: { pickupSearchError: true } } } }).known, false);
  assert.equal(parse({ ...good, errors: [], error: false }).known, true);
});

test("models remain separated by their actual model name", () => {
  const products = groupProductsByModel({ "iPhone 18 Pro": [
    { Model: "iPhone 18 Pro Max", Code: "MAX" }, { Model: "iPhone 18 Pro", Code: "PRO" }
  ] });
  assert.deepEqual(Object.keys(products), ["iPhone 18 Pro Max", "iPhone 18 Pro"]);
});

const duoProduct = { Model: "iPhone Duo", Capacity: "256GB", Color: "夜空色", Code: "MK2E4ZA/A", Type: "iphone",
  PurchasePath: "/hk-zh/shop/buy-iphone/iphone-duo/7.6-%E5%90%8B%E9%A1%AF%E7%A4%BA%E5%99%A8-256gb-%E5%A4%9C%E7%A9%BA%E8%89%B2" };

test("iPhone purchase links preserve official HK pathnames and match the exact configuration", () => {
  const url = "https://www.apple.com" + duoProduct.PurchasePath;
  assert.equal(productPurchaseURL({ ...task, product: duoProduct }), url);
  assert.equal(productPurchaseURL({ ...task, product: {
    ...duoProduct, PurchasePath: duoProduct.PurchasePath.slice("/hk-zh".length)
  } }), url);
  for (const changes of [{ Model: "iPhone 18 Pro" }, { Model: "iPhone 18 Pro Max" },
    { Capacity: "512GB" }, { Color: "星光白色" }, { Model: "unknown" }, { Color: "black" }]) {
    assert.throws(() => productPurchaseURL({ ...task, product: { ...duoProduct, ...changes } }));
  }
});

test("purchase links reject checkout, add-to-bag, other hosts, countries, traversal and URL parameters", () => {
  const valid = duoProduct.PurchasePath;
  for (const PurchasePath of ["https://www.apple.com" + valid, "//evil.example" + valid,
    "/hk-zh/shop/bag", "/hk-zh/shop/checkout", "/hk-zh/shop/bag/add", "/hk-zh/shop/product/MK2E4ZA/A",
    valid + "?addToBag=true", valid + "#checkout", valid + "/checkout", valid + "/../checkout",
    valid + "%3faddToBag=true", valid + "%23checkout", valid + "%253faddToBag=true",
    valid.replace("/iphone-duo/", "/iphone-duo%2f"), valid.replace("/iphone-duo/", "/iphone-duo/../iphone-duo/"),
    valid.replace("/iphone-duo/", "/iphone-duo/%2e%2e/iphone-duo/"),
    valid.replace("/hk-zh/", "/us/"), valid.replace("/shop/", "\\shop/"), valid + "\n", " " + valid, valid + "%ZZ"]) {
    assert.throws(() => productPurchaseURL({ ...task, product: { ...duoProduct, PurchasePath } }), PurchasePath);
  }
  for (const Code of ["", "../bag", "MK2E4ZA/A?addToBag=true", "MK2E4LL/A"]) {
    assert.throws(() => productPurchaseURL({ ...task, product: { Code } }));
  }
});

test("watch selectors retain their family-bound path behavior", () => {
  const product = { Type: "watchs12", PurchasePath: "/shop/buy-watch/apple-watch/42mm-gps-space-gray-aluminum-olive-sport-band" };
  assert.equal(productPurchaseURL({ ...task, product }), "https://www.apple.com/hk-zh" + product.PurchasePath);
  for (const PurchasePath of [product.PurchasePath + "?addToBag=true", "/shop/buy-watch/apple-watch-se",
    "/shop/buy-watch/apple-watch/../../checkout"]) {
    assert.throws(() => productPurchaseURL({ ...task, product: { ...product, PurchasePath } }));
  }
});
