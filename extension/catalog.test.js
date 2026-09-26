import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFulfillmentPath, productPurchaseURL } from "./shared.js";

const readJSON = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const catalog = readJSON("./data/products/product_data_hk.json");
const evidence = readJSON("../catalog-provenance/catalog_verified.json");
const products = Object.values(catalog.products).flat();
const originalProCodes = [
  "MJRR4ZA/A", "MJRT4ZA/A", "MJRQ4ZA/A", "MJRP4ZA/A", "MJRW4ZA/A", "MJRX4ZA/A", "MJRV4ZA/A", "MJRU4ZA/A",
  "MJT14ZA/A", "MJT24ZA/A", "MJT04ZA/A", "MJRY4ZA/A", "MJT54ZA/A", "MJT64ZA/A", "MJT44ZA/A", "MJT34ZA/A",
  "MJXQ4ZA/A", "MJXR4ZA/A", "MJXP4ZA/A", "MJXN4ZA/A", "MJXV4ZA/A", "MJXW4ZA/A", "MJXU4ZA/A", "MJXT4ZA/A",
  "MJY04ZA/A", "MJY14ZA/A", "MJXY4ZA/A", "MJXX4ZA/A", "MJY44ZA/A", "MJY54ZA/A", "MJY34ZA/A", "MJY24ZA/A"
];

test("catalog keeps the original 32 Pro identities and contains 8 verified Duo combinations", () => {
  assert.equal(products.length, 40);
  assert.equal(new Set(products.map((product) => product.Code)).size, 40);
  assert.deepEqual([...catalog.products["iPhone 18 Pro"], ...catalog.products["iPhone 18 Pro Max"]]
    .map((product) => product.Code), originalProCodes);
  const duo = catalog.products["iPhone Duo"];
  assert.equal(duo.length, 8);
  assert.deepEqual(new Set(duo.map((product) => `${product.Capacity}:${product.Color}`)),
    new Set(["256GB", "512GB", "1TB", "2TB"].flatMap((capacity) =>
      ["夜空色", "星光白色"].map((color) => `${capacity}:${color}`))));
  assert.deepEqual(duo.map((product) => product.Code), [
    "MK2E4ZA/A", "MK2D4ZA/A", "MK2G4ZA/A", "MK2F4ZA/A", "MK2J4ZA/A", "MK2H4ZA/A", "MK2L4ZA/A", "MK2K4ZA/A"
  ]);
  assert.deepEqual(catalog.pending_products, []);
});

test("every active product is backed by matching official selection, HKD price and variant href evidence", () => {
  assert.equal(evidence.verified_product_count, products.length);
  const records = evidence.sources.flatMap((source) => source.records);
  assert.equal(records.length, products.length);
  for (const product of products) {
    const source = evidence.sources.find((entry) => entry.records.some((record) => record.product.Code === product.Code));
    const record = source.records.find((entry) => entry.product.Code === product.Code);
    assert.deepEqual(product, record.product);
    assert.equal(record.selection.partNumber, product.Code);
    assert.equal(record.selection.dimensionCapacity.toUpperCase(), product.Capacity);
    assert.ok(record.price.validProducts.includes(product.Code));
    assert.equal(record.price.priceCurrency, "HKD");
    assert.equal(product.Price, Number(record.price.currentPrice.raw_amount));
    assert.equal(product.Price, record.price.amountBeforeTradeIn);
    assert.equal(product.CatalogVerifiedAt, source.fetched_at);
    assert.ok(Number.isFinite(Date.parse(product.CatalogVerifiedAt)));
    assert.equal(productPurchaseURL({ areaCode: "hk", product }), record.href);
    assert.match(product.Code, /^[A-Z0-9]+ZA\/A$/);
    assert.match(source.decompressed_html_sha256, /^[a-f0-9]{64}$/);
    assert.equal(source.http_status, 200);
  }
});

test("prices and Duo preorder timestamp preserve verified HK launch facts", () => {
  const prices = {
    "iPhone 18 Pro": [10499, 12299, 15799, 20999],
    "iPhone 18 Pro Max": [11499, 13299, 16799, 21999],
    "iPhone Duo": [17499, 19299, 22799, 27999]
  };
  for (const product of products) {
    assert.equal(product.Price, prices[product.Model][["256GB", "512GB", "1TB", "2TB"].indexOf(product.Capacity)]);
    if (product.Model === "iPhone Duo") {
      assert.equal(product.PreorderAt, "2026-10-16T20:00:00+08:00");
      assert.equal(new Date(product.PreorderAt).toISOString(), "2026-10-16T12:00:00.000Z");
    } else {
      assert.equal(product.PreorderAt, undefined);
    }
  }
});

test("the verified eight Duo SKUs fit one fulfillment batch without placeholder codes", () => {
  const duo = catalog.products["iPhone Duo"];
  const url = new URL(buildFulfillmentPath(duo.map((product) => ({ areaCode: "hk", product }))), "https://www.apple.com");
  duo.forEach((product, index) => assert.equal(url.searchParams.get("parts." + index), product.Code));
  assert.equal(url.searchParams.has("parts.8"), false);
});
