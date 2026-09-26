'use strict';

// This preload is attached only to the two bundled application pages. Apple
// pages run in separate windows without a preload or access to this bridge.
const { contextBridge, ipcRenderer } = require('electron');
const APP_ROOT = 'stockapp://local/';
const APP_ID = 'apple-stock-monitor-desktop';
const VERSION = '4.0.1';

function pageRole() {
  try {
    const url = new URL(globalThis.location.href);
    if (url.protocol !== 'stockapp:' || url.host !== 'local' || url.username || url.password) return null;
    if (url.pathname === '/app.html') return 'dashboard';
    if (url.pathname === '/engine.html') return 'engine';
  } catch {}
  return null;
}

const role = pageRole();
if (role) {
  const eventListeners = new Map();
  const messageListeners = new Set();
  const invoke = (method, args) => ipcRenderer.invoke('desktop:call', { method, args });
  const method = name => (...args) => invoke(name, args);
  const event = name => {
    const listeners = new Set();
    eventListeners.set(name, listeners);
    return {
      addListener(listener) {
        if (typeof listener !== 'function') throw new TypeError('事件处理器必须是函数');
        listeners.add(listener);
      },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
      hasListeners() { return listeners.size > 0; }
    };
  };
  const chromeAPI = {
    runtime: {
      id: APP_ID,
      getURL(path = '') {
        const relative = String(path).replace(/^\/+/, '');
        if (relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => part === '..' || part === '.')) {
          throw new TypeError('无效应用资源路径');
        }
        return APP_ROOT + relative;
      },
      getManifest: () => ({ version: VERSION, name: 'Apple 香港库存监控 Windows' }),
      sendMessage: method('runtime.sendMessage'),
      onInstalled: event('runtime.onInstalled'),
      onStartup: event('runtime.onStartup'),
      onMessage: {
        addListener(listener) {
          if (typeof listener !== 'function') throw new TypeError('消息处理器必须是函数');
          messageListeners.add(listener);
        },
        removeListener(listener) { messageListeners.delete(listener); },
        hasListener(listener) { return messageListeners.has(listener); },
        hasListeners() { return messageListeners.size > 0; }
      }
    },
    storage: {
      local: {
        get: method('storage.local.get'),
        set: method('storage.local.set'),
        setAccessLevel: method('storage.local.setAccessLevel')
      },
      onChanged: event('storage.onChanged')
    },
    tabs: {
      get: method('tabs.get'),
      query: method('tabs.query'),
      create: method('tabs.create'),
      update: method('tabs.update'),
      reload: method('tabs.reload'),
      sendMessage: method('tabs.sendMessage'),
      onUpdated: event('tabs.onUpdated'),
      onRemoved: event('tabs.onRemoved')
    },
    windows: { update: method('windows.update') },
    scripting: { executeScript: method('scripting.executeScript') },
    alarms: {
      get: method('alarms.get'),
      create: method('alarms.create'),
      clear: method('alarms.clear'),
      onAlarm: event('alarms.onAlarm')
    },
    notifications: {
      create: method('notifications.create'),
      onClicked: event('notifications.onClicked')
    },
    action: { onClicked: event('action.onClicked') },
    desktop: role === 'engine' ? {
      prepareStockCheck: method('desktop.prepareStockCheck'),
      resetAppleSession: method('desktop.resetAppleSession'),
      engineReady() { ipcRenderer.send('desktop:engine-ready'); }
    } : {
      getInfo: method('desktop.getInfo'),
      openApple: method('desktop.openApple'),
      connectionDiagnostics: method('desktop.connectionDiagnostics'),
      openDataFolder: method('desktop.openDataFolder'),
      backupData: method('desktop.backupData'),
      getProxy: method('desktop.getProxy'),
      setProxy: method('desktop.setProxy'),
      testProxy: method('desktop.testProxy')
    }
  };

  ipcRenderer.on('desktop:event', (_electronEvent, payload) => {
    if (!payload || !Array.isArray(payload.args)) return;
    const listeners = eventListeners.get(payload.name);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(...payload.args); } catch { /* One UI listener cannot block the engine. */ }
    }
  });

  if (role === 'engine') {
    ipcRenderer.on('desktop:runtime-message', (_electronEvent, payload) => {
      if (!payload || !['string', 'number'].includes(typeof payload.id)) return;
      let responded = false;
      const reply = result => {
        if (responded) return;
        responded = true;
        ipcRenderer.send('desktop:runtime-response', { id: payload.id, result });
      };
      let pending = false;
      for (const listener of [...messageListeners]) {
        try {
          const result = listener(payload.message, payload.sender, reply);
          if (result === true) pending = true;
          else if (result && typeof result.then === 'function') {
            pending = true;
            Promise.resolve(result).then(reply, () => reply({ ok: false, error: '后台操作失败，请重试' }));
          }
        } catch {
          reply({ ok: false, error: '后台操作失败，请重试' });
        }
        if (responded) break;
      }
      if (!responded && !pending) reply({ ok: false, error: '后台尚未准备就绪，请稍后重试' });
    });
  }

  // Chromium already owns window.chrome. Expose a distinct immutable bridge;
  // trusted bundled entry modules opt into the compatibility API explicitly.
  contextBridge.exposeInMainWorld('desktopChrome', chromeAPI);
}
