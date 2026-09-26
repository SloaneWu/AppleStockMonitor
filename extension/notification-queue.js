import { sendBark } from './bark.js';

// Persist before dispatch. An interrupted send is never retried automatically:
// without a server idempotency key its delivery result is ambiguous.
export function createNotificationQueue(api, { send = sendBark } = {}) {
  let active, wakeVersion = 0, changes = Promise.resolve();
  const edit = action => {
    const run = changes.then(action, action);
    changes = run.catch(() => {});
    return run;
  };
  async function restore() {
    await edit(async () => {
      const { notificationQueue = [] } = await api.storage.local.get('notificationQueue');
      const interrupted = notificationQueue.some(item => item.state === 'sending');
      await api.storage.local.set({ notificationQueue: notificationQueue.filter(item => item.state !== 'sending'),
        ...(interrupted ? { barkStatus: { ok: false, at: new Date().toISOString(), message: '上次通知发送被中断，送达状态未知；未自动重发。' } } : {}) });
    });
  }
  async function enqueue(messages, eventId) {
    await edit(async () => {
      const { notificationQueue = [], notificationEvents = [], barkConfig = {} } = await api.storage.local.get(['notificationQueue', 'notificationEvents', 'barkConfig']);
      if (!barkConfig.enabled || !barkConfig.key || notificationEvents.includes(eventId)) return;
      const items = messages.map((message, index) => ({ id: eventId + ':' + index, state: 'pending', message, createdAt: Date.now() }));
      await api.storage.local.set({ notificationQueue: [...notificationQueue, ...items].slice(-100), notificationEvents: [...notificationEvents, eventId].slice(-1000) });
    });
    void drain().catch(() => {});
  }
  function drain() {
    wakeVersion++;
    if (active) return active;
    let observedWake;
    active = (async () => {
      // Finish the queue even when monitoring is paused and no stock alarm
      // will wake us again. Dispatch remains serial and is never retried.
      for (;;) {
        observedWake = wakeVersion;
        let item, key;
        await edit(async () => {
          const { notificationQueue = [], barkConfig = {} } = await api.storage.local.get(['notificationQueue', 'barkConfig']);
          if (!barkConfig.enabled || !barkConfig.key) { await api.storage.local.set({ notificationQueue: [] }); return; }
          item = notificationQueue.find(row => row.state === 'pending' && Date.now() - row.createdAt < 3600000);
          if (!item) return;
          key = barkConfig.key;
          item.state = 'sending';
          await api.storage.local.set({ notificationQueue });
        });
        if (!item) break;
        let result;
        try { result = await send(key, item.message); }
        catch { result = { ok: false, message: 'Bark 配置或发送异常，未自动重发。' }; }
        await edit(async () => {
          const { notificationQueue = [] } = await api.storage.local.get('notificationQueue');
          await api.storage.local.set({ notificationQueue: notificationQueue.filter(row => row.id !== item.id), barkStatus: { ...result, at: new Date().toISOString() } });
        });
      }
    })().finally(() => {
      active = null;
      // An enqueue can finish after the last empty read but before this
      // promise settles. Transfer that wake-up to a new drain instead of
      // leaving the new message pending until a future alarm.
      if (observedWake !== wakeVersion) return drain();
    });
    return active;
  }
  return { restore, enqueue, drain };
}
