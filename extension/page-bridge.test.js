import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridgeSource = await readFile(new URL("./page-bridge.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("./content.js", import.meta.url), "utf8");
const SOURCE = "apple-hk-stock-page-bridge";
const PATH = "/hk-zh/shop/fulfillment-messages?fae=true&pl=true&location=central&parts.0=MJXW4ZA%2FA&mts.0=regular";

function createPage({ status = 200, fetchError, hang = false, path = "/hk-zh/shop/product/test" } = {}) {
  const listeners = new Map();
  const responses = [];
  const fetchCalls = [];
  const timers = new Map();
  let timerId = 0;
  const window = {
    location: { origin: "https://www.apple.com", pathname: path },
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message, origin) { responses.push({ ...message, targetOrigin: origin }); },
    async fetch(url, options) {
      fetchCalls.push({ url, options });
      if (fetchError) throw new Error(fetchError);
      if (hang) return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { status, headers: { get: (name) => name === "Retry-After" ? "120" : null },
        async text() { return '{"body":{"stores":[]}}'; } };
    }
  };
  const document = {};
  Object.defineProperty(document, "cookie", {
    get() { throw new Error("must not read validation cookies"); },
    set() { throw new Error("must not write validation cookies"); }
  });
  Object.defineProperty(window, "__shldRun", { get() { throw new Error("must not invoke verification"); } });
  const context = { window, document, URL, AbortController, Date, TextEncoder,
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(bridgeSource, context);
  function request({ id = "request-1", path = PATH, direction = "request", origin = window.location.origin, source = window } = {}) {
    return listeners.get("message")?.({ source, origin, data: { source: SOURCE, direction, id, path } });
  }
  return { responses, fetchCalls, timers, request, window };
}

test("one ordinary same-origin request reuses the browser session without reading cookies", async () => {
  const page = createPage();
  await page.request();
  const response = page.responses[0];
  assert.equal(page.fetchCalls.length, 1);
  assert.equal(response.status, 200);
  assert.equal(response.body, '{"body":{"stores":[]}}');
  assert.equal(response.retryAfter, "120");
  assert.ok(Date.parse(response.receivedAt));
  assert.equal(response.targetOrigin, "https://www.apple.com");
  assert.equal(page.fetchCalls[0].options.credentials, "include");
  assert.equal(page.fetchCalls[0].options.mode, "same-origin");
  assert.equal(page.fetchCalls[0].options.redirect, "error");
  assert.equal(page.timers.size, 0);
});

test("MAIN readiness probe performs no fetch and still rejects foreign origins and invalid IDs", async () => {
  const page = createPage();
  await page.request({ direction: "probe", origin: "https://evil.example" });
  await page.request({ direction: "probe", id: "invalid/id" });
  assert.equal(page.responses.length, 0);
  await page.request({ direction: "probe" });
  assert.equal(page.responses[0].bridgeReady, true);
  assert.equal(page.responses[0].id, "request-1");
  assert.equal(page.fetchCalls.length, 0);
  assert.equal(page.timers.size, 0);
});

test("541 performs exactly one fetch and reports unknown cause without touching cookies", async () => {
  const page = createPage({ status: 541 });
  await page.request();
  assert.equal(page.fetchCalls.length, 1);
  assert.equal(page.responses[0].status, 541);
  assert.equal(page.responses[0].body, "");
  assert.match(page.responses[0].error, /原因尚未确定/);
});

test("network failures retain error metadata rather than a successful empty response", async () => {
  const page = createPage({ fetchError: "Network unavailable" });
  await page.request();
  assert.equal(page.responses[0].status, 0);
  assert.match(page.responses[0].error, /Network unavailable/);
  assert.equal(page.responses[0].timedOut, false);
  assert.ok(Date.parse(page.responses[0].receivedAt));
});

test("fetch is aborted after 20 seconds and does not retry", async () => {
  const page = createPage({ hang: true });
  const promise = page.request();
  const timer = [...page.timers.values()][0];
  assert.equal(timer.ms, 20000);
  timer.fn();
  await promise;
  assert.equal(page.fetchCalls.length, 1);
  assert.equal(page.fetchCalls[0].options.signal.aborted, true);
  assert.equal(page.responses[0].timedOut, true);
  assert.equal(page.responses[0].status, 0);
  assert.match(page.responses[0].error, /20 秒/);
});

test("rejects foreign origins, foreign frames, and non-HK pages", async () => {
  const page = createPage();
  await page.request({ origin: "https://evil.example" });
  await page.request({ source: {} });
  assert.equal(page.fetchCalls.length, 0);
  assert.equal(page.responses.length, 0);
  const usPage = createPage({ path: "/us/shop/" });
  await usPage.request();
  assert.equal(usPage.fetchCalls.length, 0);
});

test("blocks foreign paths and unexpected parameters before any network operation", async () => {
  const page = createPage();
  for (const path of ["https://evil.example" + PATH, "/shop/fulfillment-messages", "/hk-zh/shop/bag",
    PATH + "&store=R428", PATH + "&location=other", PATH.replace("central", "other"),
    PATH.replace("parts.0", "parts.2"), PATH.replace("regular", "other")]) {
    await page.request({ path });
    assert.equal(page.responses.at(-1).status, 0);
    assert.ok(page.responses.at(-1).error);
  }
  assert.equal(page.fetchCalls.length, 0);
});

test("an already running request ID cannot produce a duplicate request", async () => {
  const page = createPage({ hang: true });
  const promise = page.request();
  await page.request();
  assert.equal(page.fetchCalls.length, 1);
  [...page.timers.values()][0].fn();
  await promise;
});

function createContent() {
  const listeners = new Map();
  const sent = [];
  const timers = new Map();
  let runtimeListener;
  const window = { location: { origin: "https://www.apple.com", pathname: "/hk/shop/" },
    addEventListener(type, fn) { listeners.set(type, fn); },
    postMessage(message) { sent.push(message); } };
  vm.runInNewContext(contentSource, { window, Date, crypto: { randomUUID: () => "test-uuid" },
    chrome: { runtime: { id: "extension-id", onMessage: { addListener(fn) { runtimeListener = fn; } } } },
    setTimeout(fn, ms) { timers.set(1, { fn, ms }); return 1; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { window, sent, timers,
    runtime: (...args) => runtimeListener(...args),
    response: (origin, values = {}) => listeners.get("message")({ source: window, origin,
      data: { source: SOURCE, direction: "response", id: "test-uuid", status: 200, ...values } }) };
}

test("content accepts runtime messages only from this extension and checks response origin", async () => {
  const content = createContent();
  let result;
  content.runtime({ type: "stock-check", path: PATH }, { id: "another-extension" }, (r) => { result = r; });
  assert.equal(content.sent.length, 0);
  content.runtime({ type: "stock-check", path: PATH }, { id: "extension-id" }, (r) => { result = r; });
  assert.equal(content.sent.length, 1);
  content.response("https://evil.example");
  await Promise.resolve();
  assert.equal(result, undefined);
  content.response("https://www.apple.com", { body: "{}", retryAfter: "60" });
  await Promise.resolve();
  assert.equal(result.status, 200);
  assert.equal(result.retryAfter, "60");
  assert.equal(content.timers.size, 0);
});

test("content gives up after 25 seconds if the bridge is absent", async () => {
  const content = createContent();
  let result;
  content.runtime({ type: "stock-check", path: PATH }, { id: "extension-id" }, (r) => { result = r; });
  const timer = [...content.timers.values()][0];
  assert.equal(timer.ms, 25000);
  timer.fn();
  await Promise.resolve();
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, true);
});

test("content ping proves MAIN readiness instead of merely confirming its own listener", async () => {
  const content = createContent();
  let result;
  assert.equal(content.runtime({ type: "ping" }, { id: "extension-id" }, r => { result = r; }), true);
  assert.equal(result, undefined);
  assert.equal(content.sent[0].direction, "probe");
  assert.equal(content.sent[0].path, undefined);
  content.response("https://evil.example", { bridgeReady: true });
  assert.equal(result, undefined);
  content.response("https://www.apple.com", { bridgeReady: true });
  assert.equal(result.ok, true);
  assert.equal(result.bridgeReady, true);
  assert.equal(content.timers.size, 0);
});

test("content readiness probe expires after 1.5 seconds and ignores a late reply", () => {
  const content = createContent();
  const results = [];
  content.runtime({ type: "ping" }, { id: "extension-id" }, r => results.push(r));
  const timer = [...content.timers.values()][0];
  assert.equal(timer.ms, 1500);
  timer.fn();
  content.response("https://www.apple.com", { bridgeReady: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].bridgeReady, false);
});
