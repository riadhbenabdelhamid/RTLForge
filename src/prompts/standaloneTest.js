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
      + "stimulus, explicit PASS/FAIL markers for each check, and a nonzero exit on failure. "
      + "When randomness is needed, seed it explicitly with $urandom(32'hC0FFEE).\n\n"
      + "ORIGINAL USER DESCRIPTION:\n" + String(description || "") + "\n\n"
      + "DUT MODULE HEADER (interface only):\n" + String(moduleInterface || "") + "\n\n"
      + "Return the complete testbench source in the JSON code field.",
  };
}
