// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { buildSvaChecker, svaCheckerToImmediate, inlineFormalAsserts, formalResetAssume } from "./svaBind.js";
import { runAcceptanceSuite } from "./reviewAcceptance.js";

export function assembleFormalProperties(properties, spec, name, rtl) {
  const diagnostic = {};
  // Functional properties are interface-only. An implementation-internal
  // reference cannot become a source contract merely by compiling in a DUT.
  const checker = buildSvaChecker(properties, spec, name, diagnostic, { formal: true });
  const translated = svaCheckerToImmediate(checker?.text || "");
  const reset = formalResetAssume(spec);
  const source = inlineFormalAsserts(rtl, [...(checker?.auxLines || []), ...(reset ? [reset] : []), ...translated.assertLines]);
  return { checker, translated, source, skipped: [...(checker?.skipped || diagnostic.skipped || []), ...translated.skippedReasons].filter(s => !/^cover statements/.test(s.reason || "")) };
}

// Replay assertions on a witness driven by SOURCE outputs, not by DUT outputs.
// This can refute an incompatible property without declaring the RTL wrong.
// Passing only establishes consistency with these finite, explicit examples.
async function replayFormalExamples(st, contract, assembled) {
  if (contract.status === "NONE" || contract.status === "READY" && !contract.suites.length) {
    return { status: "NOT_AVAILABLE", scope: contract.designHash ? "completed-specification-properties" : "generated-properties-only" };
  }
  if (contract.status !== "READY") return { status: "UNVERIFIED", reason: "source conventions unresolved" };
  const ids = assembled.translated.translatedIds;
  if (!ids.length || new Set(ids).size !== ids.length) return { status: "UNVERIFIED", reason: "missing or duplicate property IDs" };
  const name = st.elicit?.modName || st._modName || "module";
  const runs = [];
  for (const suite of contract.suites) {
    let index = 0;
    const counters = ids.map((_, i) => "integer f_source_seen_" + i + " = 0, f_source_bad_" + i + " = 0;");
    const assertions = assembled.translated.assertLines.map(line => {
      // The translator emits one balanced immediate assertion per line.
      // Capture its expression with a balanced scan, retaining history logic.
      const start = /\b(assert|assume)\s*\(/.exec(line);
      if (!start) return line;
      const begin = start.index + start[0].length;
      let end = begin, depth = 1;
      for (; end < line.length && depth; end++) { if (line[end] === "(") depth++; else if (line[end] === ")") depth--; }
      if (depth || line.slice(end).trim()[0] !== ";") throw new Error("unsupported translated assertion");
      const expr = line.slice(begin, end - 1), i = index++;
      return (line.slice(0, start.index) + "begin f_source_seen_" + i + " = f_source_seen_" + i
        + " + 1; if ((" + expr + ") !== 1'b1) f_source_bad_" + i + " = f_source_bad_" + i + " + 1; end"
        + line.slice(line.indexOf(";", end) + 1)).replace("always @*", "always @(f_source_sample)");
    });
    if (index !== ids.length) return { status: "UNVERIFIED", reason: "unsupported property instrumentation" };
    const witness = suite.witnessModule + "\n" + counters.join("\n") + "\n"
      + (assembled.checker.auxLines || []).join("\n") + "\n" + assertions.join("\n") + "\nendmodule";
    const summary = ids.map((id, i) => 'if (dut.f_source_seen_' + i + ' > 0 && dut.f_source_bad_' + i
      + ' == 0) $display("[PASS] PROPERTY.' + i + '"); else $display("[FAIL] PROPERTY.' + i + '");').join("\n");
    const tb = suite.witnessTestbench.replace("$finish;", "#1;\n" + summary + "\n$finish;");
    const run = await runAcceptanceSuite(st, witness, tb);
    runs.push({ suite: suite.id, ...run });
  }
  const valid = runs.every(r => r.status === "MEASURED" && r.tests.length === ids.length
    && new Set(r.tests.map(t => t.name)).size === ids.length
    && ids.every((_, i) => r.tests.some(t => t.name === "PROPERTY." + i && t.st === "PASS")));
  return { status: valid ? "PASS" : "UNVERIFIED", scope: "source-example-consistency", propertyIds: ids,
    sourceHash: contract.hash, runs, reason: valid ? null : "properties contradict source examples, are unexercised, or could not be replayed" };
}

export async function qualifyFormalExamples(st, contract, assembled) {
  try { return await replayFormalExamples(st, contract, assembled); }
  catch (e) {
    if (e?.name === "AbortError") throw e;
    return { status: "UNVERIFIED", scope: "source-example-consistency", reason: String(e.message || e) };
  }
}
