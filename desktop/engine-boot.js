globalThis.chrome = globalThis.desktopChrome;
await import('./background.js');

// The worker registers its message handler synchronously and awaits its own
// initialization before handling requests. Main may now release queued calls.
chrome.desktop.engineReady();
