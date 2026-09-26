'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Construct own properties explicitly: a stored "__proto__" is data, never a setter.
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || (!Array.isArray(value) && !isRecord(value))) {
    throw new TypeError('Storage accepts only JSON values, plain objects and finite numbers.');
  }
  if (ancestors.has(value)) throw new TypeError('Storage values cannot contain circular references.');
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).some(key => Object.getOwnPropertyDescriptor(value, key).enumerable)) {
      throw new TypeError('Storage values cannot contain symbol keys.');
    }
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Storage arrays must contain JSON values without holes or accessors.');
        }
        return copyJson(descriptor.value, ancestors);
      });
    }
    return Object.fromEntries(Object.keys(value).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Storage values cannot contain accessors.');
      return [key, copyJson(descriptor.value, ancestors)];
    }));
  } finally {
    ancestors.delete(value);
  }
}

function readInitialState(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    const failure = new Error(`无法读取本地设置文件：${file}。原文件未被改写，请检查文件访问权限。`);
    failure.code = 'STORAGE_READ_FAILED';
    throw failure;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new TypeError('Settings must be an object.');
    return copyJson(parsed);
  } catch {
    // Do not embed the parser's message: it may include saved notification secrets.
    const failure = new Error(`本地设置文件内容损坏：${file}。原文件已保留，请先备份并修复该文件；程序不会自动清空设置。`);
    failure.code = 'STORAGE_INVALID_JSON';
    throw failure;
  }
}

async function writeAtomic(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let created = false;
  try {
    handle = await fs.promises.open(temporaryFile, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Same-directory rename replaces the prior complete file in one operation.
    // Never delete the destination first: a failed write must retain its data.
    await fs.promises.rename(temporaryFile, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.promises.unlink(temporaryFile).catch(() => {});
    const failure = new Error(`无法保存本地设置文件：${file}。此前已保存的数据仍保留，请检查磁盘空间及文件访问权限。`);
    failure.code = 'STORAGE_WRITE_FAILED';
    failure.systemCode = error.code;
    throw failure;
  }
}

/** A single-owner durable JSON equivalent of the extension's chrome.storage.local. */
function createStorage(file, { onChanged } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('A settings file path is required.');
  if (onChanged !== undefined && typeof onChanged !== 'function') throw new TypeError('onChanged must be a function.');
  const settingsFile = path.resolve(file);
  let state = readInitialState(settingsFile);
  let queue = Promise.resolve();
  let latestWrite = queue;

  async function get(keys) {
    // Capture this point in the queue; a subsequent set does not delay this read.
    await queue;
    if (keys === undefined || keys === null) return copyJson(state);
    if (typeof keys === 'string') {
      return Object.hasOwn(state, keys) ? Object.fromEntries([[keys, copyJson(state[keys])]]) : {};
    }
    if (Array.isArray(keys)) {
      if (!keys.every(key => typeof key === 'string')) throw new TypeError('Storage keys must be strings.');
      return Object.fromEntries(keys.filter(key => Object.hasOwn(state, key)).map(key => [key, copyJson(state[key])]));
    }
    if (isRecord(keys)) {
      const defaults = copyJson(keys);
      return Object.fromEntries(Object.keys(defaults).map(key => [key,
        copyJson(Object.hasOwn(state, key) ? state[key] : defaults[key])
      ]));
    }
    throw new TypeError('Storage keys must be a string, array, defaults object, null or undefined.');
  }

  function set(values) {
    let patch;
    try {
      if (!isRecord(values)) throw new TypeError('Storage.set expects a plain object.');
      patch = copyJson(values);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = queue.then(async () => {
      const entries = Object.entries(patch).filter(([key, value]) => !Object.hasOwn(state, key) || !isDeepStrictEqual(state[key], value));
      if (!entries.length) return;
      const nextState = Object.fromEntries([...Object.entries(state), ...entries]);
      const changes = Object.fromEntries(entries.map(([key, value]) => [key,
        Object.hasOwn(state, key)
          ? { oldValue: copyJson(state[key]), newValue: copyJson(value) }
          : { newValue: copyJson(value) }
      ]));
      await writeAtomic(settingsFile, nextState);
      state = nextState;
      if (onChanged) {
        // Listener failures cannot undo an already durable save or poison writes.
        try { Promise.resolve(onChanged(changes, 'local')).catch(() => {}); } catch {}
      }
    });
    latestWrite = operation;
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    get,
    set,
    snapshot: () => copyJson(state),
    // Report failure of the last queued save instead of claiming a durable backup.
    flush: () => latestWrite.then(() => undefined)
  };
}

module.exports = { createStorage };
