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

/** The Verilator config file staged next to a shared package. */
export const SHARED_PKG_WAIVER_FILE = "shared_pkg_waivers.vlt";

/**
 * Hygiene rules a PER-MODULE compile cannot decide about a shared package.
 *
 * A package exists to be shared, so it necessarily holds items that only
 * SOME of its modules use. Compiling one module against it, Verilator sees
 * the rest as unused and says so — and Verilator makes warnings fatal, so
 * a compile under warnings-as-errors exits with "%Error: Exiting due to N
 * warning(s)" and never produces a binary.
 *
 * LATENT, not live: verify injects -Wno-fatal unless verifyWarningsAsErrors
 * is set (run 10), so the default configuration builds fine. Measured three
 * ways on run 48's merge_pkg, which declares N_CH for the arbiter's port
 * widths while the FIFO uses only beat_t:
 *
 *   -Wall -Wno-fatal, no waiver   → binary built      (the default path)
 *   -Wall,            no waiver   → NO BINARY, "Parameter is not used: N_CH"
 *   -Wall,            waiver      → binary built
 *
 * So turning verifyWarningsAsErrors on would have failed every module that
 * does not use every package item — a correct module against a correct
 * package, with no simulation and nothing to attribute it to. Lint would
 * still have passed it (UNUSEDPARAM is hygiene-tier and does not gate, run
 * 36), so the two checks disagree about what counts as a problem, and the
 * failure that lands names a file the module's fix loop must not touch: its
 * only escapes are deleting an item another module needs or inventing a
 * fake use.
 *
 * The waiver is scoped to the package FILE and to those rules alone, so
 * every other file keeps full -Wall. Integration deliberately gets no
 * waiver: there the whole system is compiled at once, and an item no module
 * uses is real dead code that should still be reported.
 */
const PKG_WAIVED_RULES = ["UNUSEDPARAM", "UNUSEDSIGNAL"];

export function sharedPkgWaiver(pkgFileName) {
  return "`verilator_config\n"
    + PKG_WAIVED_RULES.map(function(rule) {
        return "lint_off -rule " + rule + " -file \"*" + pkgFileName + "\"";
      }).join("\n")
    + "\n";
}

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
    files: Object.assign({
      [SHARED_PKG_WAIVER_FILE]: sharedPkgWaiver(name),
      [name]: pkgCode,
    }, files),
    order: [SHARED_PKG_WAIVER_FILE, name].concat(own),
  };
}

/**
 * Substitute the {RTL} slot of a command template with a file list.
 *
 * ONLY THE FIRST occurrence becomes the list. The default simCmds uses {RTL}
 * three times — once for the sources and twice to name the output binary:
 *
 *   verilator --binary --build -Wall {RTL} {TB} -o {RTL}.sim
 *   ./obj_dir/{RTL}.sim
 *
 * so substituting every slot with "uart_pkg.sv uart_tx.sv" produced
 * `-o uart_pkg.sv uart_tx.sv.sim` and a run command that could not exist.
 *
 * The list belongs ONLY to a compiler invocation, and only to its first slot.
 * Scoping it "first occurrence per command string" is not enough: simCmds is
 * a multi-line script, each line substituted separately, so the RUN line's
 * slot counted as its own first occurrence and became
 * `./obj_dir/uart_pkg.sv uart_tx.sv.sim` — which the shell reported as
 * `./obj_dir/uart_pkg.sv: not found` (measured, run 47).
 */
const COMPILER_RE = /\b(verilator|iverilog|vlog|xvlog|vcs|xrun)\b/;

export function cmdWithFiles(template, order, primary) {
  const t = String(template || "");
  const list = order.join(" ");
  const one = primary || order[order.length - 1] || "";
  // A run command names the binary, never the sources.
  if (!COMPILER_RE.test(t)) return t.replace(/\{RTL\}/g, one);
  let first = true;
  return t.replace(/\{RTL\}/g, function() {
    if (first) { first = false; return list; }
    return one;
  });
}

/**
 * Child RTL for a parent module's own stages. A parent instantiates its
 * children by name, so a lint or a simulation that sees only the parent
 * reports "Cannot find file containing module" — true of every top level in
 * every system, and not a defect in the parent (run 47).
 *
 * @param {Array} childInterfaces  descriptors from buildChildInterfaces
 * @returns {object} { "<modName>.sv": code } for every child that has RTL
 */
export function childRtlFiles(childInterfaces) {
  const out = {};
  for (const ci of (childInterfaces || [])) {
    if (ci && ci.code && ci.modName) out[ci.modName + ".sv"] = ci.code;
  }
  return out;
}
