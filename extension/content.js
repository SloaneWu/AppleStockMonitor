(() => {
  if (globalThis.__APPLE_HK_STOCK_CONTENT__) return;
  if (window.location.origin !== "https://www.apple.com" || !/^\/hk(?:-zh)?\//.test(window.location.pathname)) return;
  globalThis.__APPLE_HK_STOCK_CONTENT__ = true;

  const SOURCE = "apple-hk-stock-page-bridge";
  const pending = new Map();

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.location.origin ||
        message?.source !== SOURCE || message?.direction !== "response") return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    request.resolve({
      bridgeReady: message.bridgeReady === true,
      status: Number.isInteger(message.status) ? message.status : 0,
      body: typeof message.body === "string" ? message.body : "",
      error: typeof message.error === "string" ? message.error : "",
      retryAfter: typeof message.retryAfter === "string" ? message.retryAfter : "",
      receivedAt: typeof message.receivedAt === "string" ? message.receivedAt : new Date().toISOString(),
      timedOut: message.timedOut === true,
      responseKind: ["json", "html", "text", "unknown"].includes(message.responseKind) ? message.responseKind : "unknown",
      responseBytes: Math.max(0, Number(message.responseBytes) || 0),
      durationMs: Math.max(0, Number(message.durationMs) || 0)
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (message?.type === "ping") {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        sendResponse({ ok: false, bridgeReady: false });
      }, 1500);
      pending.set(id, { timer, resolve: result => sendResponse({ ok: result.bridgeReady, bridgeReady: result.bridgeReady }) });
      window.postMessage({ source: SOURCE, direction: "probe", id }, window.location.origin);
      return true;
    }
    if (message?.type !== "stock-check") return false;
    if (typeof message.path !== "string" || !/^\/hk(?:-zh)?\/shop\/fulfillment-messages\?/.test(message.path)) {
      sendResponse({ status: 0, error: "仅允许请求 Apple 香港库存接口", receivedAt: new Date().toISOString() });
      return false;
    }
    const id = crypto.randomUUID();
    const responsePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: 0, body: "", error: "Apple 页面桥接超时，请刷新官网页面后重试", retryAfter: "",
          receivedAt: new Date().toISOString(), timedOut: true });
      }, 25000);
      pending.set(id, { resolve, timer });
    });
    window.postMessage({ source: SOURCE, direction: "request", id, path: message.path }, window.location.origin);
    responsePromise.then(sendResponse);
    return true;
  });
})();
