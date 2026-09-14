// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Prompt for the opt-in standalone fallback candidate.  Keep this deliberately
// independent from the pipeline's spec, architecture, RTL, TB, and findings:
// the candidate is an original-description baseline, not a second view of a
// pipeline artifact.

export function promptStandaloneRTL(description, moduleName) {
  const name = String(moduleName || "module").trim() || "module";
  return {
    systemPrompt:
      "You are a SystemVerilog expert. Respond with ONLY a JSON object of this exact shape: "
      + "{\"code\":\"<complete SystemVerilog source as a single JSON string>\"}. "
      + "No markdown, preamble, explanation, reference design, testbench, or text outside JSON. "
      + "Inside code use \\n for newlines and escape quotes as JSON requires.",
    userMessage:
      "Produce one complete synthesizable IEEE 1800-2017 SystemVerilog module named \""
      + name + "\" from the user's original description below. The description is the only design "
      + "specification available to you. Preserve every explicitly named port, width, reset behavior, "
      + "parameter, and operation; the module declaration must use this exact exported name; do not "
      + "invent a testbench or a reference model.\n\n"
      + "ORIGINAL USER DESCRIPTION:\n" + String(description || "") + "\n\n"
      + "Return the complete module source in the JSON code field, including module and endmodule.",
  };
}
