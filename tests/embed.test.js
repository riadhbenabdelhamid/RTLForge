// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// llm/embed — Ollama /api/embed client + file vector cache (mock fetch/fs).

import { describe, it, expect } from "vitest";
import { buildEmbedReq, createFileVectorCache, createEmbedder } from "../src/llm/embed.js";

function mockFs(store) {
  return {
    existsSync: (p) => p in store,
    readFileSync: (p) => store[p],
    writeFileSync: (p, v) => { store[p] = v; },
  };
}

describe("buildEmbedReq", () => {
  it("defaults to local Ollama and batches input as an array", () => {
    const r = buildEmbedReq({ embedModel: "nomic-embed-text" }, ["a", "b"]);
    expect(r.url).toBe("http://localhost:11434/api/embed");
    expect(r.body).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
  });
  it("embedBaseUrl overrides the host; a lone string becomes a one-item batch", () => {
    const r = buildEmbedReq({ embedModel: "m", embedBaseUrl: "http://box:11434" }, "x");
    expect(r.url).toBe("http://box:11434/api/embed");
    expect(r.body.input).toEqual(["x"]);
  });
});

describe("createFileVectorCache", () => {
  it("persists vectors keyed by (model, text) and survives reload", () => {
    const store = {};
    const c1 = createFileVectorCache("/cache.json", { fs: mockFs(store) });
    c1.set("m", "hello", [1, 2]);
    c1.persist();
    const c2 = createFileVectorCache("/cache.json", { fs: mockFs(store) });
    expect(c2.get("m", "hello")).toEqual([1, 2]);
    expect(c2.get("other-model", "hello")).toBe(null);   // model is part of the key
    expect(c2.get("m", "bye")).toBe(null);
  });
  it("evicts oldest entries past maxEntries and starts fresh on corrupt files", () => {
    const store = { "/cache.json": "{not json" };
    const c = createFileVectorCache("/cache.json", { fs: mockFs(store), maxEntries: 2 });
    expect(c.size()).toBe(0);
    c.set("m", "a", [1]); c.set("m", "b", [2]); c.set("m", "c", [3]);
    expect(c.size()).toBe(2);
    expect(c.get("m", "a")).toBe(null);      // oldest evicted
    expect(c.get("m", "c")).toEqual([3]);
  });
});

describe("createEmbedder", () => {
  function okFetch(calls) {
    return async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      return {
        ok: true,
        json: async () => ({ embeddings: body.input.map((t) => [t.length, 1]) }),
      };
    };
  }

  it("refuses to build without an embedModel", () => {
    expect(() => createEmbedder({}, { fetch: async () => ({}) })).toThrow(/embedModel/);
  });

  it("one batch POST for misses; cache hits skip the network; results stay aligned", async () => {
    const store = {};
    const cache = createFileVectorCache("/c.json", { fs: mockFs(store) });
    cache.set("nomic-embed-text", "bb", [99, 99]);
    const calls = [];
    const e = createEmbedder({ embedModel: "nomic-embed-text" }, { fetch: okFetch(calls), cache });
    const vecs = await e.embed(["a", "bb", "ccc"]);
    expect(calls.length).toBe(1);                          // one batch for the two misses
    expect(calls[0].body.input).toEqual(["a", "ccc"]);
    expect(vecs).toEqual([[1, 1], [99, 99], [3, 1]]);      // cached "bb" kept its stored vector
    expect(store["/c.json"]).toBeTruthy();                 // misses persisted

    const vecs2 = await e.embed(["a", "bb", "ccc"]);       // now fully cached
    expect(calls.length).toBe(1);
    expect(vecs2).toEqual([[1, 1], [99, 99], [3, 1]]);
  });

  it("works cache-less and throws on HTTP or shape errors", async () => {
    const e = createEmbedder({ embedModel: "m" }, { fetch: async () => ({ ok: false, status: 500 }) });
    await expect(e.embed(["x"])).rejects.toThrow(/HTTP 500/);
    const bad = createEmbedder({ embedModel: "m" }, {
      fetch: async () => ({ ok: true, json: async () => ({ embeddings: [[1]] }) }),
    });
    await expect(bad.embed(["x", "y"])).rejects.toThrow(/expected 2 embeddings/);
  });
});
