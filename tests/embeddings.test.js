// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Semantic lesson dedup — pure vector math (pipeline/embeddings.js) and the
// embedding-clustered saturation count (training.js semanticLessonCount).

import { describe, it, expect } from "vitest";
import {
  cosineSim, clusterByThreshold, semanticDistinctCount,
  indicesAboveSim, rankBySimilarity,
} from "../src/pipeline/embeddings.js";
import { semanticLessonCount, lessonTextOf } from "../src/pipeline/training.js";

describe("cosineSim", () => {
  it("identical direction → 1, orthogonal → 0, opposite → -1", () => {
    expect(cosineSim([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 3])).toBeCloseTo(0);
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
  it("degenerate inputs are 'not similar', never a crash", () => {
    expect(cosineSim(null, [1, 0])).toBe(0);
    expect(cosineSim([1, 0], [1, 0, 0])).toBe(0);   // length mismatch
    expect(cosineSim([], [])).toBe(0);
    expect(cosineSim([0, 0], [1, 0])).toBe(0);      // zero norm
  });
});

describe("clusterByThreshold + semanticDistinctCount", () => {
  // Three paraphrases along one axis, one distinct lesson on another.
  const V = [[1, 0], [0.99, 0.05], [1, 0.01], [0, 1]];
  it("collapses paraphrases to one cluster", () => {
    expect(semanticDistinctCount(V, 0.9)).toBe(2);
    const assign = clusterByThreshold(V, 0.9);
    expect(assign[0]).toBe(0);
    expect(assign[1]).toBe(0);   // joins the first leader
    expect(assign[2]).toBe(0);
    expect(assign[3]).toBe(3);   // new leader
  });
  it("threshold 1-ish keeps near-duplicates apart, low threshold merges all", () => {
    expect(semanticDistinctCount(V, 0.99999)).toBe(4);
    expect(semanticDistinctCount(V, -1)).toBe(1);
  });
  it("append-only growth is monotonic: existing assignments never change", () => {
    const before = clusterByThreshold(V, 0.9);
    const after = clusterByThreshold(V.concat([[0.98, 0.02], [-1, 0.5]]), 0.9);
    expect(after.slice(0, V.length)).toEqual(before);
    expect(semanticDistinctCount(V.concat([[0.98, 0.02]]), 0.9)).toBe(2);   // joins cluster 0
  });
  it("a degenerate vector becomes its own singleton cluster", () => {
    expect(semanticDistinctCount([[1, 0], null, [1, 0]], 0.9)).toBe(2);
    expect(semanticDistinctCount([], 0.9)).toBe(0);
  });
});

describe("indicesAboveSim + rankBySimilarity", () => {
  const ref = [1, 0];
  const vecs = [[0, 1], [1, 0.1], [0.7, 0.7], [1, 0]];
  it("flags only vectors at/above the threshold", () => {
    expect(indicesAboveSim(ref, vecs, 0.95)).toEqual([1, 3]);
    expect(indicesAboveSim(ref, vecs, 1.1)).toEqual([]);
  });
  it("ranks most-similar first, ties stable by input order", () => {
    expect(rankBySimilarity(ref, vecs)).toEqual([3, 1, 2, 0]);
    expect(rankBySimilarity(ref, [[2, 0], [1, 0]])).toEqual([0, 1]);   // sim 1 tie → input order
  });
});

describe("semanticLessonCount (training saturation metric)", () => {
  const recs = [
    { signature: "A", domain: "rtl", rule: "size every literal" },
    { signature: "B", domain: "rtl", rule: "size each literal explicitly" },   // paraphrase of A
    { signature: "C", domain: "rtl", sample: "cover all case items" },
    { signature: "D", domain: "tb", rule: "unrelated tb lesson" },
    { signature: "A", domain: "rtl", rule: "size every literal" },             // duplicate signature
  ];
  // Fake embedder: paraphrases land on one axis, the case lesson on another.
  const AXES = {
    "size every literal": [1, 0],
    "size each literal explicitly": [0.99, 0.05],
    "cover all case items": [0, 1],
  };
  const embedFn = async (texts) => texts.map((t) => AXES[t] || [0.5, 0.5]);

  it("clusters paraphrases and scopes by domain (dupes never reach the embedder)", async () => {
    const seen = [];
    const spy = async (texts) => { seen.push(...texts); return embedFn(texts); };
    expect(await semanticLessonCount(recs, { domain: "rtl", threshold: 0.9 }, spy)).toBe(2);
    expect(seen).toEqual(["size every literal", "size each literal explicitly", "cover all case items"]);
  });
  it("empty scope short-circuits without calling the embedder", async () => {
    let called = false;
    const n = await semanticLessonCount(recs, { domain: "formal" }, async () => { called = true; return []; });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });
  it("propagates embedder failures — the caller owns the fallback", async () => {
    await expect(semanticLessonCount(recs, { domain: "rtl" }, async () => { throw new Error("down"); }))
      .rejects.toThrow("down");
  });
  it("lessonTextOf follows the injection precedence rule > sample > signature", () => {
    expect(lessonTextOf({ rule: "r", sample: "s", signature: "g" })).toBe("r");
    expect(lessonTextOf({ sample: "s", signature: "g" })).toBe("s");
    expect(lessonTextOf({ signature: "g" })).toBe("g");
    expect(lessonTextOf(null)).toBe("");
  });
});
