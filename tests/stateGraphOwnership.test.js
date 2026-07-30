// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// StateGraph merge ownership (docs/improvement-roadmap.md #4) — retires the
// clobber bug class (judge→verify, lint→rtl_generate._llms/_syntaxRepairs).

import { describe, it, expect } from "vitest";
import { StateGraph } from "../src/pipeline/StateGraph.js";

function graphWith(name, fn) {
  return new StateGraph().addNode(name, fn).compile();
}

describe("StateGraph merge ownership", () => {
  it("a node writing ANOTHER node's slot merges — rich fields survive (the clobber class)", async () => {
    const g = graphWith("lint", async () => ({ rtl_generate: { code: "fixed" } }));
    const st = await g.invokeNode("lint", {
      rtl_generate: { code: "orig", _syntaxRepairs: [{ rule: "x", count: 1 }], _bestOfN: { n: 3 } },
    });
    expect(st.rtl_generate.code).toBe("fixed");
    expect(st.rtl_generate._syntaxRepairs).toEqual([{ rule: "x", count: 1 }]);   // survived
    expect(st.rtl_generate._bestOfN).toEqual({ n: 3 });                          // survived
  });

  it("a node writing its OWN slot replaces — no stale fields inherited", async () => {
    const g = graphWith("rtl_generate", async () => ({ rtl_generate: { code: "fresh" } }));
    const st = await g.invokeNode("rtl_generate", {
      rtl_generate: { code: "old", _syntaxRepairs: [{ rule: "stale" }] },
    });
    expect(st.rtl_generate).toEqual({ code: "fresh" });   // stale _syntaxRepairs gone
  });

  it("underscore keys are telemetry values — always replaced, never merged", async () => {
    const g = graphWith("lint", async () => ({ _llm: { stage: "lint", tokensIn: 5 } }));
    const st = await g.invokeNode("lint", { _llm: { stage: "spec", tokensIn: 9, text: "stale" } });
    expect(st._llm).toEqual({ stage: "lint", tokensIn: 5 });   // no stale text bleed
  });

  it("arrays and scalars replace as before", async () => {
    const g = graphWith("n", async () => ({ _llms: [3], count: 2, verify: null }));
    const st = await g.invokeNode("n", { _llms: [1, 2], count: 1, verify: { pass: 1 } });
    expect(st._llms).toEqual([3]);
    expect(st.count).toBe(2);
    expect(st.verify).toBe(null);
  });

  it("_replaceSlot forces a non-owner replace and is stripped", async () => {
    const g = graphWith("judge", async () => ({ verify: { pass: 0, _replaceSlot: true } }));
    const st = await g.invokeNode("judge", { verify: { pass: 7, verifyHistory: [1, 2] } });
    expect(st.verify).toEqual({ pass: 0 });               // replaced, history gone by request
    expect("_replaceSlot" in st.verify).toBe(false);      // hatch stripped
  });

  it("a new slot (nothing to merge with) is set as-is", async () => {
    const g = graphWith("spec", async () => ({ spec: { requirements: [] } }));
    const st = await g.invokeNode("spec", { _userDesc: "d" });
    expect(st.spec).toEqual({ requirements: [] });
    expect(st._userDesc).toBe("d");
  });

  it("the historical judge→verify shape: history + cost survive a bare re-verify delta", async () => {
    const g = graphWith("judge", async () => ({ verify: { pass: 4, fail: 0 } }));
    const st = await g.invokeNode("judge", {
      verify: { pass: 3, fail: 1, verifyHistory: [{ iter: 1 }], _llms: [{ tokensIn: 10 }] },
    });
    expect(st.verify.pass).toBe(4);
    expect(st.verify.verifyHistory).toEqual([{ iter: 1 }]);
    expect(st.verify._llms).toEqual([{ tokensIn: 10 }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// _llms is a LEDGER, not a value (run 37). A stage re-entered by the judge or
// a reflow replaces its own slot — correct for verdict fields, wrong for the
// LLM call list. Asked why run 37's RTL Review took 36 minutes, its _llms held
// only a much later judge-driven re-run's calls; the original pass had to be
// reconstructed from a hole in the cross-stage timeline.
// ═══════════════════════════════════════════════════════════════════════════
describe("_llms survives a stage re-entering its own slot (run 37)", () => {
  const call = (stage, ms) => ({
    stage: stage, model: "devstral:24b", provider: "ollama",
    tokensIn: 100, tokensOut: 200, latencyMs: ms, ttft: 9,
    startedAtMs: 1000, endedAtMs: 1000 + ms, stopReason: "stop",
    systemPrompt: "S".repeat(5000), userMessage: "U".repeat(5000), text: "T".repeat(5000),
  });

  async function reenter(priorLlms, nextLlms) {
    const g = new StateGraph();
    g.addNode("rtl_review", async () => ({ rtl_review: { score: 60, _llms: nextLlms } }));
    const compiled = g.compile();
    return compiled.invokeNode("rtl_review", { rtl_review: { score: 68, _llms: priorLlms } });
  }

  it("prior calls are kept ahead of the new ones and tagged _prior", async () => {
    const out = await reenter([call("rtl_review", 189000)], [call("rtl_review", 500)]);
    expect(out.rtl_review._llms).toHaveLength(2);
    expect(out.rtl_review._llms[0]._prior).toBe(true);
    expect(out.rtl_review._llms[0].latencyMs).toBe(189000);   // the evidence run 37 lost
    expect(out.rtl_review._llms[1]._prior).toBeUndefined();
    expect(out.rtl_review.score).toBe(60);                     // slot still replaced
  });

  it("carried entries drop the bulky fields so checkpoints stay small", async () => {
    const out = await reenter([call("rtl_review", 189000)], []);
    const p = out.rtl_review._llms[0];
    expect(p.systemPrompt).toBeUndefined();
    expect(p.userMessage).toBeUndefined();
    expect(p.text).toBeUndefined();
    expect(p.startedAtMs).toBe(1000);                          // timing survives
    expect(p.tokensOut).toBe(200);
  });

  it("re-tagging is idempotent across several re-entries", async () => {
    const first = await reenter([call("a", 1)], [call("b", 2)]);
    const second = await reenter(first.rtl_review._llms, [call("c", 3)]);
    expect(second.rtl_review._llms.map((c) => c.stage)).toEqual(["a", "b", "c"]);
    expect(second.rtl_review._llms.filter((c) => c._prior)).toHaveLength(2);
  });

  it("the CURRENT pass is never truncated by the carry cap", async () => {
    const prior = Array.from({ length: 40 }, (_, i) => call("old" + i, i));
    const next = Array.from({ length: 30 }, (_, i) => call("new" + i, i));
    const out = await reenter(prior, next);
    expect(out.rtl_review._llms.filter((c) => !c._prior)).toHaveLength(30);
    expect(out.rtl_review._llms.filter((c) => c._prior)).toHaveLength(24);   // capped tail
  });

  it("a stage writing ANOTHER slot is unaffected (merge path, not replace)", async () => {
    const g = new StateGraph();
    g.addNode("judge", async () => ({ verify: { pass: 5 } }));
    const out = await g.compile().invokeNode("judge", { verify: { pass: 1, _llms: [call("v", 1)] } });
    expect(out.verify._llms).toHaveLength(1);
    expect(out.verify.pass).toBe(5);
  });
});
