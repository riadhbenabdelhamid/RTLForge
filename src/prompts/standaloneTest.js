// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Independent checker prompt for standaloneFallback. It receives the raw
// description and a module header only; implementation bodies and derived
// pipeline findings are intentionally excluded.
import { behaviorFidelity } from "./behaviorContract.js";

export function promptStandaloneTB(description, moduleInterface, moduleName) {
  const name = String(moduleName || "module").trim() || "module";
  return {
    systemPrompt:
      "You are an independent SystemVerilog verification expert. Respond with ONLY a JSON object of this exact shape: "
      + "{\"code\":\"<complete self-checking testbench source>\"}. No markdown, preamble, explanation, "
      + "reference RTL, or text outside JSON. Use \\n for newlines inside code.",
    userMessage:
      "Generate one complete self-checking Verilator testbench named \"" + name + "_tb\". "
      + "Derive expected behavior only from the original user description and, when supplied, its frozen completed specification. The DUT implementation "
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
      + "When a completed specification is supplied, test selected interpretations and open choices as binding obligations regardless of Must/Should priority. "
      + "Exercise boundaries where independently scoped rules interact: reset assertion and release, state updates that continue during reset, simultaneous events, and recovery into the next transaction when applicable. "
      + "Do not invent reset effects on storage whose update rule is independent. Cite covered requirement IDs in comments.\n\n"
      + behaviorFidelity + "\n\n"
      + "ORIGINAL USER DESCRIPTION:\n" + String(description || "") + "\n\n"
      + "DUT MODULE HEADER (interface only):\n" + String(moduleInterface || "") + "\n\n"
      + "Return the complete testbench source in the JSON code field.",
  };
}

/**
 * A bounded second pass over the independent checker.  The reviewer receives
 * exactly the same independence boundary as the generator: original prose,
 * the DUT header, and checker source.  In particular, it never receives RTL,
 * pipeline findings, or a reference result that could anchor its judgment.
 */
export function promptStandaloneTBReview(description, moduleInterface, checkerCode, moduleName) {
  const name = String(moduleName || "module").trim() || "module";
  return {
    systemPrompt:
      "You are an independent SystemVerilog checker reviewer. Respond with ONLY a JSON object of this exact shape: "
      + "{\"status\":\"PASS\"|\"FAIL\",\"findings\":[{\"severity\":\"critical\"|\"major\"|\"minor\",\"text\":\"...\"}],\"summary\":\"...\"}. "
      + "Do not emit markdown, code, a replacement checker, or text outside JSON. "
      + "This is a bounded semantic review, not a proof: FAIL conservatively when the checker has no observable assertion, "
      + "does not exercise the stated behavior, can skip checks, or has an expectation that is unsupported by the description and any supplied frozen completed specification. "
      + "PASS only when every critical or major concern is absent. Never infer behavior from an implementation body.",
    userMessage:
      "Review the independent self-checking testbench for module \"" + name + "\". "
      + "Use only the original user description, any supplied frozen completed specification, the DUT module header, and the checker source below. "
      + "Check that stimulus is deterministic or explicitly seeded, outputs are sampled after the stated timing, "
      + "expected values come from the description or its recorded contract choices, every check emits one exact [PASS]/[FAIL] marker, and the full "
      + "planned sequence runs even after a mismatch. Do not assume anything about hidden RTL implementation details.\n\n"
      + "For a completed specification, check coverage of recorded interpretations and choices, including Should requirements. "
      + "Flag omitted observable boundary cases where reset scope, simultaneous updates, or recovery affect those obligations. "
      + "A passing ordinary-operation test alone does not check reset assertion/release behavior.\n\n"
      + behaviorFidelity + "\n\n"
      + "ORIGINAL USER DESCRIPTION:\n" + String(description || "") + "\n\n"
      + "DUT MODULE HEADER (interface only):\n" + String(moduleInterface || "") + "\n\n"
      + "INDEPENDENT CHECKER SOURCE:\n" + String(checkerCode || "") + "\n\n"
      + "Return PASS only for a checker that is suitable for a conservative candidate comparison. "
      + "Return FAIL with concise findings otherwise.",
  };
}
