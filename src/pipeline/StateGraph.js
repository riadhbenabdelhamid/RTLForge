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
