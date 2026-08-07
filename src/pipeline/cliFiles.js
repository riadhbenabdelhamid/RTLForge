// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// cliFiles — build the file set a CLI invocation needs
//
// A module in a multi-module system imports the shared package: that is the
// whole point of having one. The per-module stages compiled the module ALONE,
// so `import uart_pkg::*;` failed with "Import package not found" — and the
// fix loop would then have pushed the model to DELETE the import to satisfy
// lint, breaking the contract the package exists to enforce (run 47, the
// campaign's first system run).
//
// The package has to lead the file list: Verilator elaborates in order, and a
// package must be defined before the module that imports it.
// ═══════════════════════════════════════════════════════════════════════════

export const SHARED_PKG_FILE = "shared_pkg.sv";

/**
 * The file a package must live in. Verilator's DECLFILENAME warns when a
 * package is not in a file named after it, and under warnings-as-errors that
 * warning FAILS the stage — so a fixed "shared_pkg.sv" would have made every
 * system run fail lint on a package that is otherwise perfectly good
 * (run 47). Derived from the declaration so no extra plumbing is needed.
 */
export function sharedPkgFileName(pkgCode) {
  const m = /\bpackage\s+([A-Za-z_]\w*)\s*;/.exec(String(pkgCode || ""));
  return m ? m[1] + ".sv" : SHARED_PKG_FILE;
}

/**
 * @param {object} files        the stage's own files, e.g. { "dut.sv": code }
 * @param {string|null} pkgCode the shared package source, when the run has one
 * @returns {{ files: object, order: string[] }}
 *   `order` is the file list in elaboration order, ready to substitute into a
 *   command template's {RTL} slot.
 */
export function withSharedPackage(files, pkgCode) {
  const own = Object.keys(files || {});
  if (!pkgCode || typeof pkgCode !== "string" || !pkgCode.trim()) {
    return { files: Object.assign({}, files), order: own };
  }
  const name = sharedPkgFileName(pkgCode);
  return {
    files: Object.assign({ [name]: pkgCode }, files),
    order: [name].concat(own),
  };
}

/**
 * Substitute the {RTL} slot of a command template with a file list.
 * Kept beside withSharedPackage so the two cannot drift: a command that names
 * only the module while the file set carries the package would elaborate the
 * package as dead weight and still fail the import.
 */
export function cmdWithFiles(template, order) {
  return String(template || "").replace(/\{RTL\}/g, order.join(" "));
}
