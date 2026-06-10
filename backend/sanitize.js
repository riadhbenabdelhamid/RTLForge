// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// backend/sanitize.js — filename sanitization
//
// Pure module, no Node-specific imports. Used by backend.js. Safe to
// import from the frontend if ever needed.
// ═══════════════════════════════════════════════════════════════════════════

export class SanitizeError extends Error {
  constructor(name, reason) {
    super("Unsafe filename '" + name + "': " + reason);
    this.name = "SanitizeError";
    this.unsafeName = name;
    this.reason = reason;
  }
}

/**
 * Validates a filename to be safely written into a flat staging directory
 * and consumed by EDA tools (Verilator, Yosys, etc.). Throws SanitizeError
 * with a descriptive reason if the filename is unsafe.
 *
 * Rules:
 *   - Non-empty string ≤ 255 chars
 *   - Not "." or ".."
 *   - Cannot start with "."
 *   - No path separators (/ \ \0)
 *   - Charset: [a-zA-Z0-9._-]
 */
export function sanitizeFilename(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new SanitizeError(String(name), "empty filename");
  }
  if (name.length > 255) {
    throw new SanitizeError(name, "filename longer than 255 chars");
  }
  if (name === "." || name === "..") {
    throw new SanitizeError(name, "reserved filename");
  }
  if (name.startsWith(".")) {
    throw new SanitizeError(name, "filename cannot start with '.'");
  }
  if (name.indexOf("/") >= 0 || name.indexOf("\\") >= 0 || name.indexOf("\0") >= 0) {
    throw new SanitizeError(name, "path separators not allowed");
  }
  if (!/^[a-zA-Z0-9._\-]+$/.test(name)) {
    throw new SanitizeError(name, "characters outside [a-zA-Z0-9._-] not allowed");
  }
  return name;
}
