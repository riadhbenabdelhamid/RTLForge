// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// hash — djb2 string hash + interface signature computation
// ═══════════════════════════════════════════════════════════════════════════

/** djb2 string hash → 8-char hex. Stable, fast, no crypto needed. */
export function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

/**
 * Compute deterministic interface signature for module library matching.
 * Produces { portHash, paramHash } from sorted port/param lists.
 */
export function computeInterfaceSignature(iface, params) {
  const ports = (iface || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const portStr = ports.map((p) => (p.name || "") + (p.dir || "") + (p.width || "")).join("|");

  const pars = (params || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const paramStr = pars.map((p) => (p.name || "") + String(p.def != null ? p.def : "")).join("|");

  return { portHash: djb2(portStr), paramHash: djb2(paramStr) };
}
