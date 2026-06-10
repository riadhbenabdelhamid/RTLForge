// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// projectState/storage — Pluggable storage adapter abstraction
//
// Defines a stable storage interface and provides three adapter factories:
//
//   createMemoryStorage()  - in-memory key/value store, useful for tests and
//                            for the Node CLI smoke test
//   createBrowserStorage() - tries window.storage (Claude sandbox), then
//                            window.localStorage; logs which it picked.
//   createCloudStorage(window.storage) - explicit injection for environments
//                                        where window.storage may be lazy
//
// The storage adapter interface:
//
//   async get(key)               → { key, value: <string> }
//                                  THROWS on missing key
//   async set(key, value)        → { key, value }
//   async delete(key)            → { key, deleted: <boolean> }
//   async list(prefix?)          → { keys: <string[]>, prefix }
//
// All values must be strings; callers JSON.stringify before set and
// JSON.parse after get. This matches both the window.storage and
// localStorage APIs and avoids serialization quirks.
//
// Why pluggable?
// - Tests can use createMemoryStorage() with no globals
// - Node CLI smoke tests can use the same memory adapter
// - Browser code passes the adapter explicitly to the CheckpointManager
//   factory, which is much easier to reason about than the original
//   getStorage() module-singleton with first-call detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * In-memory key/value store. Data is lost on process exit. Useful for
 * tests and Node smoke tests where persistence is not needed.
 */
export function createMemoryStorage() {
  const store = new Map();
  return {
    type: "memory",
    async get(key) {
      if (!store.has(key)) throw new Error("Key not found: " + key);
      return { key, value: store.get(key) };
    },
    async set(key, value) {
      if (typeof value !== "string") {
        throw new Error("storage.set value must be a string; got " + typeof value);
      }
      store.set(key, value);
      return { key, value };
    },
    async delete(key) {
      const existed = store.has(key);
      store.delete(key);
      return { key, deleted: existed };
    },
    async list(prefix) {
      const keys = [];
      store.forEach(function(_v, k) {
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      });
      return { keys, prefix };
    },
  };
}

/**
 * Wrap an existing window.storage-shaped object (Claude sandbox).
 * The injected object is expected to already implement the interface;
 * this just normalizes errors and stamps the type field.
 */
export function createCloudStorage(windowStorage) {
  if (!windowStorage || typeof windowStorage.get !== "function") {
    throw new Error("createCloudStorage: windowStorage must implement get/set/delete/list");
  }
  return {
    type: "cloud",
    async get(key) {
      const r = await windowStorage.get(key);
      if (!r || r.value == null) throw new Error("Key not found: " + key);
      return { key, value: r.value };
    },
    async set(key, value) {
      if (typeof value !== "string") {
        throw new Error("storage.set value must be a string; got " + typeof value);
      }
      await windowStorage.set(key, value);
      return { key, value };
    },
    async delete(key) {
      const r = await windowStorage.delete(key);
      return { key, deleted: !!(r && r.deleted) };
    },
    async list(prefix) {
      const r = await windowStorage.list(prefix);
      return { keys: (r && r.keys) || [], prefix };
    },
  };
}

/**
 * Wrap window.localStorage. Includes a quota-recovery shim that purges
 * any keys with the given namespace prefix and retries the failed set.
 */
export function createLocalStorageAdapter(localStorage, quotaPrefix) {
  if (!localStorage || typeof localStorage.setItem !== "function") {
    throw new Error("createLocalStorageAdapter: localStorage must be the window.localStorage object");
  }
  const purgePrefix = quotaPrefix || "rtlforge:";
  return {
    type: "local",
    async get(key) {
      const val = localStorage.getItem(key);
      if (val === null) throw new Error("Key not found: " + key);
      return { key, value: val };
    },
    async set(key, value) {
      if (typeof value !== "string") {
        throw new Error("storage.set value must be a string; got " + typeof value);
      }
      try {
        localStorage.setItem(key, value);
      } catch (e) {
        // Quota exceeded — purge namespace and retry once
        try {
          const allKeys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(purgePrefix)) allKeys.push(k);
          }
          allKeys.forEach(function(k) { localStorage.removeItem(k); });
          localStorage.setItem(key, value);
        } catch (e2) {
          throw new Error("localStorage quota exhausted: " + e2.message);
        }
      }
      return { key, value };
    },
    async delete(key) {
      const existed = localStorage.getItem(key) !== null;
      localStorage.removeItem(key);
      return { key, deleted: existed };
    },
    async list(prefix) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (!prefix || k.startsWith(prefix))) keys.push(k);
      }
      return { keys, prefix };
    },
  };
}

/**
 * Browser auto-detect: tries window.storage (Claude sandbox), then
 * window.localStorage, then falls back to in-memory. Returns the first
 * adapter that's available. SAFE to call in Node — if neither global is
 * present, returns the memory adapter without throwing.
 *
 * For tests and Node smoke tests, prefer createMemoryStorage() directly
 * to avoid the implicit fallback chain.
 */
export function createBrowserStorage() {
  if (typeof globalThis !== "undefined") {
    const win = globalThis.window;
    if (win) {
      if (win.storage && typeof win.storage.get === "function") {
        return createCloudStorage(win.storage);
      }
      if (win.localStorage) {
        return createLocalStorageAdapter(win.localStorage);
      }
    }
  }
  return createMemoryStorage();
}
