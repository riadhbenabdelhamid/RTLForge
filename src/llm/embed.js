// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// llm/embed — Ollama /api/embed client + persistent vector cache
//
// The ADAPTER half of semantic lesson dedup (pure math: pipeline/embeddings.js).
// Talks to Ollama's embedding endpoint (e.g. nomic-embed-text — ~270 MB, loads
// alongside a resident chat model). Deliberately decoupled from the CHAT
// provider config: the chat model may run anywhere (LM Studio, cloud), while
// embeddings come from `embedBaseUrl` (default local Ollama), selected by
// `embedModel`. `embedModel: null` (the default) means every semantic feature
// is off and nothing here is ever called.
//
// Browser-safety rules of this repo apply: no top-level node imports —
// the cache takes `opts.fs` injected (mirrors createFileErrorMemory) and the
// client takes `opts.fetch` injected for tests (global fetch otherwise).
// ═══════════════════════════════════════════════════════════════════════════

/** Request shape for Ollama's /api/embed (batch: input is an array of texts). */
export function buildEmbedReq(cfg, texts) {
  const c = cfg || {};
  return {
    url: (c.embedBaseUrl || "http://localhost:11434") + "/api/embed",
    body: { model: c.embedModel || "", input: Array.isArray(texts) ? texts : [texts] },
  };
}

// Cache key: JSON-tuple of (model, text) — collision-proof AND plain text
// (the catalog learned the hard way that exotic separators corrupt files).
function cacheKey(model, text) {
  return JSON.stringify([String(model || ""), String(text || "")]);
}

/**
 * JSON-file vector cache. Texts are short (lesson rules/samples, ≤ ~240 chars)
 * and the catalog is capped at 500 rows, so a flat { key → vector } object is
 * plenty; `maxEntries` (default 4000) evicts oldest-inserted first (JS objects
 * preserve insertion order). Best-effort persistence — a broken cache only
 * costs re-embedding, never correctness.
 */
export function createFileVectorCache(path, opts) {
  const o = opts || {};
  const fs = o.fs;
  if (!fs) throw new Error("createFileVectorCache: opts.fs (node:fs) is required");
  const maxEntries = o.maxEntries || 4000;
  let map = {};
  try {
    if (fs.existsSync(path)) {
      const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
    }
  } catch (_e) { map = {}; /* corrupt/missing → start fresh */ }
  return {
    get(model, text) {
      const v = map[cacheKey(model, text)];
      return Array.isArray(v) ? v : null;
    },
    set(model, text, vec) {
      if (!Array.isArray(vec)) return;
      map[cacheKey(model, text)] = vec;
      const keys = Object.keys(map);
      if (keys.length > maxEntries) {
        for (const k of keys.slice(0, keys.length - maxEntries)) delete map[k];
      }
    },
    persist() {
      try { fs.writeFileSync(path, JSON.stringify(map)); }
      catch (_e) { /* best-effort; advisory, never fatal */ }
    },
    size() { return Object.keys(map).length; },
  };
}

/**
 * Embedding client: embed(texts) → vectors, positionally aligned with the
 * input. Cache hits skip the network entirely; all misses go out as ONE batch
 * request. Throws on transport/shape errors — the CALLER decides the fallback
 * (train --auto falls back to the exact-signature count with a warning).
 *
 * @param {object} config  needs embedModel (+ optional embedBaseUrl)
 * @param {object} [opts]  { cache?: vector cache, fetch?: fetch impl }
 */
export function createEmbedder(config, opts) {
  const cfg = config || {};
  const o = opts || {};
  const doFetch = o.fetch || (typeof fetch === "function" ? fetch : null);
  const cache = o.cache || null;
  if (!cfg.embedModel) throw new Error("createEmbedder: config.embedModel is not set");
  if (!doFetch) throw new Error("createEmbedder: no fetch available");
  return {
    model: cfg.embedModel,
    async embed(texts) {
      const list = Array.isArray(texts) ? texts.map(String) : [String(texts)];
      const out = new Array(list.length);
      const missIdx = [];
      for (let i = 0; i < list.length; i++) {
        const hit = cache ? cache.get(cfg.embedModel, list[i]) : null;
        if (hit) out[i] = hit;
        else missIdx.push(i);
      }
      if (missIdx.length > 0) {
        const missTexts = missIdx.map(function(i) { return list[i]; });
        const req = buildEmbedReq(cfg, missTexts);
        const resp = await doFetch(req.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req.body),
        });
        if (!resp.ok) throw new Error("embed: HTTP " + resp.status + " from " + req.url);
        const data = await resp.json();
        const embs = data && data.embeddings;
        if (!Array.isArray(embs) || embs.length !== missTexts.length) {
          throw new Error("embed: expected " + missTexts.length + " embeddings, got " + (Array.isArray(embs) ? embs.length : typeof embs));
        }
        for (let j = 0; j < missIdx.length; j++) {
          out[missIdx[j]] = embs[j];
          if (cache) cache.set(cfg.embedModel, missTexts[j], embs[j]);
        }
        if (cache) cache.persist();
      }
      return out;
    },
  };
}
