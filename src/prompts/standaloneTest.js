// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Independent checker prompt for standaloneFallback. It receives the raw
// description and a module header only; implementation bodies and derived
// pipeline findings are intentionally excluded.

export function promptStandaloneTB(description, moduleInterface, moduleName) {
  const name = String(moduleName || "module").trim() || "module";
  return {
    systemPrompt:
      "You are an independent SystemVerilog verification expert. Respond with ONLY a JSON object of this exact shape: "
      + "{\"code\":\"<complete self-checking testbench source>\"}. No markdown, preamble, explanation, "
      + "reference RTL, or text outside JSON. Use \\n for newlines inside code.",
    userMessage:
      "Generate one complete self-checking Verilator testbench named \"" + name + "_tb\". "
      + "Derive expected behavior only from the original user description. The DUT implementation "
      + "body is withheld; use only this module header to instantiate it. Include deterministic "
      + "stimulus and emit exactly one parser-compatible marker for every check: "
      + "`[PASS] <stable-unique-check-id>` or `[FAIL] <stable-unique-check-id>`. "
      + "The marker must start at the beginning of its line; do not emit `PASS [label]`, "
      + "`TEST PASS`, or any other success/failure format. Check IDs must be stable, "
      + "non-empty, single-token values using only letters, digits, `.`, `_`, or `-`, "
      + "and unique across all repeated cycles and output lines (include a deterministic "
      + "case/cycle suffix when a logical check repeats). Execute the full predetermined "
      + "check sequence even after a mismatch: print exactly one marker for every check, "
      + "accumulate failures, and emit the nonzero exit only after the final marker "
      + "(for example, call $fatal after the final check when failures are nonzero). "
      + "When randomness is needed, seed it explicitly with $urandom(32'hC0FFEE).\n\n"
      + "ORIGINAL USER DESCRIPTION:\n" + String(description || "") + "\n\n"
      + "DUT MODULE HEADER (interface only):\n" + String(moduleInterface || "") + "\n\n"
      + "Return the complete testbench source in the JSON code field.",
  };
}
