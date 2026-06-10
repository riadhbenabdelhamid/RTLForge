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
    return {
      invokeNode: async (name, state) => {
        const fn = nodes.get(name);
        if (!fn) throw new Error("Node not found: " + name);
        const delta = await fn(state);
        return Object.assign({}, state, delta);
      },
      // Exposed for visualization and debugging
      hasNode: (name) => nodes.has(name),
      listNodes: () => Array.from(nodes.keys()),
    };
  }
}
