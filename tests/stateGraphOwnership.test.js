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
