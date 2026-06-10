// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/fsStorage — File-system storage adapter for projectState.checkpoint
//
// Implements the same {get,set,delete,list} interface that the existing
// createMemoryStorage / createBrowserStorage adapters expose, so the
// CheckpointManager works transparently. Keys are URL-encoded and laid
// out under <baseDir>/<encoded-key>.json so listing is just readdir.
//
// Default baseDir: ~/.rtlforge/projects
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Encode a key into a single safe filename. We URL-encode then replace `/`
 * with `_` so colons (used in the rtlforge:project:<id> namespace) and
 * any other shell-meta characters become safe path components.
 */
function keyToFilename(key) {
  return encodeURIComponent(key).replace(/%20/g, "_") + ".json";
}

function filenameToKey(filename) {
  if (!filename.endsWith(".json")) return null;
  return decodeURIComponent(filename.slice(0, -5).replace(/_/g, "%20"));
}

/**
 * Default base directory: $RTLFORGE_HOME/projects, falling back to
 * ~/.rtlforge/projects.
 */
export function defaultProjectsDir() {
  const home = process.env.RTLFORGE_HOME || path.join(os.homedir(), ".rtlforge");
  return path.join(home, "projects");
}

export function createFsStorage(baseDir) {
  const dir = baseDir || defaultProjectsDir();

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }

  return {
    type: "fs",
    baseDir: dir,
    async get(key) {
      ensureDir();
      const filePath = path.join(dir, keyToFilename(key));
      if (!fs.existsSync(filePath)) {
        throw new Error("Key not found: " + key);
      }
      const value = fs.readFileSync(filePath, "utf8");
      return { key, value };
    },
    async set(key, value) {
      if (typeof value !== "string") {
        throw new Error("storage.set value must be a string; got " + typeof value);
      }
      ensureDir();
      const filePath = path.join(dir, keyToFilename(key));
      // Atomic write — write to .tmp then rename, so a SIGINT mid-write
      // doesn't corrupt the on-disk checkpoint.
      const tmpPath = filePath + ".tmp";
      fs.writeFileSync(tmpPath, value, { mode: 0o644 });
      fs.renameSync(tmpPath, filePath);
      return { key, value };
    },
    async delete(key) {
      ensureDir();
      const filePath = path.join(dir, keyToFilename(key));
      if (!fs.existsSync(filePath)) return { key, deleted: false };
      fs.unlinkSync(filePath);
      return { key, deleted: true };
    },
    async list(prefix) {
      ensureDir();
      const all = fs.readdirSync(dir);
      const keys = [];
      for (const f of all) {
        if (f.endsWith(".tmp")) continue;       // skip in-flight writes
        const k = filenameToKey(f);
        if (k != null && (!prefix || k.startsWith(prefix))) keys.push(k);
      }
      return { keys, prefix };
    },
  };
}
