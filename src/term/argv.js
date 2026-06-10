// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/argv — Minimal flag parser
//
// Supports:
//   --name=value    --name value    --flag    -n value    -f
// Bare positional args land in `_`. Boolean flags (declared in `boolFlags`)
// don't consume the next token. Unknown flags are kept verbatim so the
// caller can decide policy.
//
// We deliberately don't bring in yargs / commander — this is one screen
// of code, fully testable, no transitive deps in the rtlforge install.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {string[]} argv  - process.argv.slice(2) typically
 * @param {object}   [opts]
 * @param {string[]} [opts.boolFlags]  - long names that are booleans (no value)
 * @param {object}   [opts.aliases]    - { short: "long" }
 */
export function parseArgs(argv, opts) {
  const o = opts || {};
  const boolSet = new Set(o.boolFlags || []);
  const aliases = o.aliases || {};
  const out = { _: [] };
  const arr = argv.slice();

  while (arr.length > 0) {
    const t = arr.shift();
    if (t === "--") {
      // Everything after `--` is positional verbatim
      while (arr.length > 0) out._.push(arr.shift());
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      let name, val;
      if (eq >= 0) {
        name = t.slice(2, eq);
        val  = t.slice(eq + 1);
      } else {
        name = t.slice(2);
        if (boolSet.has(name) || boolSet.has(aliases[name] || name)) {
          val = true;
        } else if (arr.length > 0 && !arr[0].startsWith("-")) {
          val = arr.shift();
        } else {
          // Treat as boolean if no value and not declared bool — better
          // than greedily consuming the next subcommand.
          val = true;
        }
      }
      const canonical = aliases[name] || name;
      out[canonical] = val;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      const short = t.slice(1);
      const canonical = aliases[short] || short;
      if (boolSet.has(canonical)) {
        out[canonical] = true;
      } else if (arr.length > 0 && !arr[0].startsWith("-")) {
        out[canonical] = arr.shift();
      } else {
        out[canonical] = true;
      }
      continue;
    }
    out._.push(t);
  }
  return out;
}
