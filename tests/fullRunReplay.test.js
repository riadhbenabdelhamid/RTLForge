// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Whole-run replay regression.
//
// The suite has stage tests and single-stage replays, but nothing that
// catches a prompt edit three stages upstream quietly changing the judge's
// verdict. Each corpus under tests/fixtures/runs/ is one complete recorded
// run — description, config, the completion for every LLM call keyed by
// prompt hash, and the verdict that run reached — replayed here against the
// CURRENT code with zero model calls.
//
// Two ways this fails, both wanted:
//   • a prompt changed → its hash matches no recorded answer → the bridge
//     parks it and times out, naming the stage (re-record or bless);
//   • the pipeline still runs but reaches a different verdict → the diff
//     names which measure moved.
//
// The deterministic stages run for real (Verilator, SymbiYosys), so this
// covers the actual lint/verify/formal path. Without those tools on PATH the
// suite skips rather than reporting a false failure.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { replayRun, haveEdaTools } from "../tools/replayRun.mjs";

const CORPORA = path.join(process.cwd(), "tests", "fixtures", "runs");
const runs = fs.existsSync(CORPORA)
  ? fs.readdirSync(CORPORA).filter((d) => fs.existsSync(path.join(CORPORA, d, "expected.json")))
  : [];

const canRun = haveEdaTools() && runs.length > 0;

describe.skipIf(!canRun)("whole-run replay", () => {
  for (const name of runs) {
    const dir = path.join(CORPORA, name);
    const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));

    it(name + " replays to its recorded verdict with zero model calls", () => {
      const res = replayRun(dir, { missTimeoutSec: 15, timeoutSec: 600 });
      // A drifted prompt is the headline signal — surface it verbatim.
      expect(res.timedOutOn ? res.reason : "").toBe("");
      expect(res.actual, res.reason).not.toBeNull();
      expect(res.actual.judgeScore).toBe(expected.judgeScore);
      expect(res.actual.judgeOverall).toBe(expected.judgeOverall);
      expect(res.actual.verifyPass).toBe(expected.verifyPass);
      expect(res.actual.verifyTotal).toBe(expected.verifyTotal);
      expect(res.actual.formalProven).toBe(expected.formalProven);
      expect(res.actual.formalSkipped).toBe(expected.formalSkipped);
      expect(res.actual.lintRtl).toBe(expected.lintRtl);
      expect(res.actual.lintTest).toBe(expected.lintTest);
      expect(res.actual.traceCovered).toBe(expected.traceCovered);
      expect(res.ok, res.reason).toBe(true);
    }, 700000);

    it(name + " runs every stage of the pipeline", () => {
      const res = replayRun(dir, { missTimeoutSec: 15, timeoutSec: 600 });
      const ok = res.stages.filter((s) => s.mark === "✓").map((s) => s.stage);
      for (const stage of ["Elicit", "Spec", "Architect", "RTL Gen", "RTL Review",
                           "Lint RTL", "SVA Props", "Formal BMC", "Test Gen",
                           "Test Review", "Lint Test", "Verify", "Judge"]) {
        expect(ok, "stage did not complete: " + stage).toContain(stage);
      }
    }, 700000);
  }
});

describe("whole-run replay corpora", () => {
  it("every corpus is complete enough to replay", () => {
    for (const name of runs) {
      const dir = path.join(CORPORA, name);
      expect(fs.existsSync(path.join(dir, "desc.txt")), name + " desc").toBe(true);
      expect(fs.existsSync(path.join(dir, "config.json")), name + " config").toBe(true);
      const answers = fs.readdirSync(path.join(dir, "answers"));
      expect(answers.length, name + " answers").toBeGreaterThan(5);
      for (const a of answers) expect(a).toMatch(/^[0-9a-f]{8}\.(txt|json)$/);
    }
  });
});
