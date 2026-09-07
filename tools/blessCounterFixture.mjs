// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
//
// Bless the spec prompt in tests/fixtures/llm/counter_updown.
//
// These fixtures are keyed by the `hash` field inside each file (see
// createReplayLLM), and they store the full call, so blessing an intentional
// prompt edit is exact: run the same stage the test runs, capture the hash the
// new prompt produces, and rekey the recorded spec answer to it. The recorded
// model output is untouched — only the prompt it is filed under changes.
//
// Sound here because the edit adds an OPTIONAL field: the recorded answer has no
// "src", and the traceability check treats a missing src as unknown rather than
// uncited, so replaying it must reach the same result as before. The suite is
// what confirms that.
//
// Usage: node tools/blessCounterFixture.mjs [--apply]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptHash } from "../src/llm/recordReplay.js";
import { runStages } from "../src/pipeline/runStages.js";
import { buildPipeline } from "../src/pipeline/buildPipeline.js";
import { selectSpecs } from "../bench/specs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(REPO, "tests", "fixtures", "llm", "counter_updown");
const APPLY = process.argv.includes("--apply");

// Byte-identical to the config the replay test uses; the prompts are rendered
// live, so any difference here would compute a hash the test never asks for.
const config = {
  provider: "lmstudio", model: "liquid/lfm2-24b-a2b",
  baseUrl: "http://localhost:1234/v1", apiKey: "local",
  useGlobalLLM: true, backendUrl: null,
  optionalStages: { rtl_review: false, formal_props: false, lint: true, test_review: false, lint_test: false },
  maxLintIters: 2, temperature: 0, seed: 7,
  errorsToAvoid: false, useShippedRules: false, syntaxRepair: false, fixPatchMode: false,
  structuredOutputs: true, truncationRetries: 2, maxTokensCeiling: 16384,
};

// Replay POSITIONALLY: hand back the recorded answers in the order they were
// recorded, so the run takes exactly the path it took when captured (the spec
// stage re-asks once, and that second prompt only exists if the first is
// answered). Each call's hash is captured on the way through.
const files = fs.readdirSync(FIXTURES).filter(function(f) { return f.endsWith(".json"); }).sort();
const records = files.map(function(f) {
  return { file: f, rec: JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8")) };
});
const seen = [];
let idx = 0;
config._llmReplay = function(call) {
  const h = promptHash(call);
  const r = records[idx];
  seen.push({ hash: h, file: r ? r.file : null, head: String(call.userMessage || "").slice(0, 50) });
  idx++;
  return r ? r.rec.response : null;
};

const spec = selectSpecs("counter_updown")[0];
try {
  await runStages(buildPipeline(), ["spec", "architect", "rtl_generate", "lint"],
    { _userDesc: spec.description, _config: config });
} catch (e) {
  console.log("(run ended early: " + String(e && e.message).slice(0, 80) + ")");
}
if (seen.length === 0) { console.error("no LLM call captured"); process.exit(1); }
console.log(seen.length + " call(s) captured, " + records.length + " fixture(s) on disk");
for (const c of seen) {
  console.log("   " + (c.file || "(no fixture)") + " → " + c.hash.slice(0, 8)
    + "   " + c.head.replace(/\s+/g, " ") + "…");
}
const pairs = seen.filter(function(c) { return c.file; })
  .map(function(c) { return { file: c.file, hash: c.hash }; });
const stale = pairs.filter(function(p2) {
  const rec = records.find(function(r) { return r.file === p2.file; }).rec;
  return rec.hash !== p2.hash;
});
console.log(stale.length + " fixture(s) need rekeying");
for (const p2 of stale) console.log("   " + (APPLY ? "rekeying " : "would rekey ") + p2.file + " → " + p2.hash.slice(0, 8));
if (stale.length === 0) process.exit(0);
if (APPLY) {
  for (const p2 of stale) {
    const file = path.join(FIXTURES, p2.file);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.hash = p2.hash;
    rec._blessed = "spec prompt gained an optional src field; recorded answer unchanged";
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  }
  console.log("done — run the suite to confirm the replay still produces the recorded shapes");
}
