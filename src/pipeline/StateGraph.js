// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// StateGraph — Minimal node graph engine for RTL Forge pipeline
// Provides addNode/addEdge/compile API. Each node is an async function
// (state) → delta object that gets shallow-merged into state.
// ═══════════════════════════════════════════════════════════════════════════

export class StateGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  addNode(name, fn) {
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from, to) {
    this.edges.push({ from, to });
    return this;
  }

  compile() {
    const nodes = this.nodes;
    const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
    // A stage re-entered by the judge/reflow REPLACES its own slot, which is
    // right for the verdict fields and wrong for `_llms`: that array is an
    // append-only telemetry LEDGER, not a value, and replacing it erases the
    // calls of every earlier pass. Measured on run 37 — asked why RTL Review
    // took 36 minutes, its `_llms` held only the calls of a much later
    // judge-driven re-run, so the original pass had to be reconstructed from a
    // hole in the cross-stage timeline. Prior entries are carried SLIM (the
    // timing and token fields, never the prompts or completions, which is what
    // would balloon a checkpoint) and tagged `_prior` so a reader can tell
    // which pass a call belongs to. Same shape as verify's verifyHistory carry.
    const PRIOR_LLM_CAP = 24;
    const carryLlms = function(prior, next) {
      if (!Array.isArray(prior) || prior.length === 0) return next;
      const slim = prior.map(function(c) {
        if (!c || typeof c !== "object") return c;
        if (c._prior) return c;
        return {
          stage: c.stage, model: c.model, provider: c.provider,
          tokensIn: c.tokensIn, tokensOut: c.tokensOut,
          latencyMs: c.latencyMs, ttft: c.ttft,
          startedAtMs: c.startedAtMs, endedAtMs: c.endedAtMs,
          stopReason: c.stopReason, maxTokensRequested: c.maxTokensRequested,
          _prior: true,
        };
      });
      // Cap the CARRIED tail only — the current pass is never truncated.
      return slim.slice(-PRIOR_LLM_CAP).concat(next);
    };
    return {
      // Merge OWNERSHIP (docs/improvement-roadmap.md #4). A plain top-level
      // Object.assign let any node CLOBBER another node's stage slot with a
      // bare delta — three shipped bugs from one mechanism (judge wiping
      // verify history, lint wiping gen _llms, lint wiping _syntaxRepairs).
      // Rule, keyed on the node name the engine already knows:
      //   - a node writing its OWN slot (key === name) REPLACES it — a fresh
      //     generation must not inherit stale fields from the previous run;
      //   - a node writing ANOTHER node's slot (both sides plain objects)
      //     MERGES one level — exactly the historical clobber cases, now
      //     lossless by construction;
      //   - underscore keys (_llm, _fixContext, …) are telemetry VALUES, not
      //     slots — always replaced, so a stale _llm.text can't bleed through;
      //   - delta[key]._replaceSlot === true forces a replace (escape hatch;
      //     stripped by the engine).
      invokeNode: async (name, state) => {
        const fn = nodes.get(name);
        if (!fn) throw new Error("Node not found: " + name);
        const delta = await fn(state);
        const out = Object.assign({}, state);
        for (const key of Object.keys(delta || {})) {
          const dv = delta[key];
          const sv = out[key];
          const wantsReplace = isPlainObject(dv) && dv._replaceSlot === true;
          if (isPlainObject(dv) && isPlainObject(sv)
              && key !== name && key[0] !== "_" && !wantsReplace) {
            out[key] = Object.assign({}, sv, dv);
          } else if (wantsReplace) {
            out[key] = Object.assign({}, dv);
            delete out[key]._replaceSlot;
          } else if (key === name && isPlainObject(dv) && isPlainObject(sv)
                     && Array.isArray(dv._llms) && Array.isArray(sv._llms)) {
            out[key] = Object.assign({}, dv, { _llms: carryLlms(sv._llms, dv._llms) });
          } else {
            out[key] = dv;
          }
        }
        return out;
      },
      // Exposed for visualization and debugging
      hasNode: (name) => nodes.has(name),
      listNodes: () => Array.from(nodes.keys()),
    };
  }
}
