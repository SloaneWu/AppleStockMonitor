(() => {
  if (window.__APPLE_HK_STOCK_BRIDGE__) return;
  if (window.location.origin !== "https://www.apple.com" || !/^\/hk(?:-zh)?\//.test(window.location.pathname)) return;
  window.__APPLE_HK_STOCK_BRIDGE__ = true;

  const SOURCE = "apple-hk-stock-page-bridge";
  const inFlight = new Set();

  function validateURL(path) {
    if (typeof path !== "string" || path.length > 3000 || !path.startsWith("/")) {
      throw new Error("库存查询地址无效");
    }
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password || url.hash ||
        !/^\/hk(?:-zh)?\/shop\/fulfillment-messages$/.test(url.pathname)) {
      throw new Error("仅允许请求 Apple 香港库存接口");
    }
    const params = url.searchParams;
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length || params.get("location") !== "central" ||
        params.get("fae") !== "true" || params.get("pl") !== "true" ||
        keys.some((key) => !/^(fae|pl|location|parts\.[0-7]|mts\.[0-7])$/.test(key))) {
      throw new Error("库存查询参数无效");
    }
    const parts = keys.filter((key) => key.startsWith("parts."));
    if (!parts.length || keys.filter((key) => key.startsWith("mts.")).length !== parts.length) {
      throw new Error("库存查询缺少产品 SKU");
    }
    for (let index = 0; index < parts.length; index += 1) {
      if (!/^[A-Z0-9]+ZA\/A$/.test(params.get("parts." + index) || "") || params.get("mts." + index) !== "regular") {
        throw new Error("库存查询 SKU 参数无效");
      }
    }
    return url;
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.location.origin ||
        message?.source !== SOURCE || !["request", "probe"].includes(message?.direction) ||
        typeof message.id !== "string" || !/^[\w-]{1,100}$/.test(message.id) || inFlight.has(message.id)) return;

    // A probe proves that the MAIN-world listener is alive without contacting Apple.
    if (message.direction === "probe") {
      window.postMessage({ source: SOURCE, direction: "response", id: message.id, bridgeReady: true }, window.location.origin);
      return;
    }

    inFlight.add(message.id);
    let timeout;
    let timedOut = false;
    let status = 0;
    let retryAfter = "";
    const started = Date.now();
    try {
      const requestURL = validateURL(message.path);
      const controller = new AbortController();
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
      const response = await window.fetch(requestURL.href, {
        method: "GET",
        credentials: "include",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" }
      });
      status = response.status;
      retryAfter = response.headers.get("Retry-After") || "";
      const raw = await response.text();
      const contentType = response.headers.get("Content-Type") || "";
      const responseKind = /json/i.test(contentType) || /^\s*[\[{]/.test(raw) ? "json"
        : /html/i.test(contentType) || /^\s*</.test(raw) ? "html" : raw ? "text" : "unknown";
      const body = status === 200 ? raw : "";
      window.postMessage({ source: SOURCE, direction: "response", id: message.id,
        status, body, retryAfter, receivedAt: new Date().toISOString(), timedOut: false,
        responseKind, responseBytes: new TextEncoder().encode(raw).length, durationMs: Date.now() - started,
        error: status === 200 ? "" : (status === 541 || status === 403
          ? "Apple 官网查询受阻，原因尚未确定；请暂停监控并检查官网附近门店查询是否正常"
          : "Apple 库存接口返回 HTTP " + status)
      }, window.location.origin);
    } catch (error) {
      window.postMessage({ source: SOURCE, direction: "response", id: message.id,
        status, body: "", retryAfter, receivedAt: new Date().toISOString(), timedOut,
        error: timedOut ? "Apple 页面请求超过 20 秒，已取消" : String(error?.message || error)
      }, window.location.origin);
    } finally {
      clearTimeout(timeout);
      inFlight.delete(message.id);
    }
  });
})();
