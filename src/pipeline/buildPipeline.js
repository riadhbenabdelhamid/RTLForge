// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// buildPipeline — Wires the StateGraph with all pipeline nodes and edges
//
// Purely declarative: it imports the node implementations from nodes/*.js,
// registers them with the graph, and declares the edges between them.
//
// The edges follow the canonical pipeline order:
//   elicit → spec → architect → rtl_generate
//   rtl_generate → rtl_review → formal_props
//   rtl_generate → formal_props        (alternate path when rtl_review skipped)
//   formal_props → lint
//   lint → test_generate
//   test_generate → test_review → verify
//   test_generate → verify             (alternate path when test_review skipped)
//   verify → judge
//
// Returns the compiled graph ({ invokeNode, hasNode, listNodes }).
// This file is the orchestration shell only; node bodies live in nodes/*.js.
// ═══════════════════════════════════════════════════════════════════════════

import { StateGraph } from "./StateGraph.js";
import {
  elicitNode,
  specNode,
  architectNode,
  rtlGenerateNode,
  rtlReviewNode,
  formalPropsNode,
  lintNode,
  testGenerateNode,
  testReviewNode,
  lintTestNode,
  verifyNode,
  judgeNode,
} from "./nodes/index.js";

export function buildPipeline() {
  const g = new StateGraph();

  // Register all 12 nodes (lint_test is the optional stage between
  // test_review/test_generate and verify).
  g.addNode("elicit",        elicitNode);
  g.addNode("spec",          specNode);
  g.addNode("architect",     architectNode);
  g.addNode("rtl_generate",  rtlGenerateNode);
  g.addNode("rtl_review",    rtlReviewNode);
  g.addNode("formal_props",  formalPropsNode);
  g.addNode("lint",          lintNode);
  g.addNode("test_generate", testGenerateNode);
  g.addNode("test_review",   testReviewNode);
  g.addNode("lint_test",     lintTestNode);
  g.addNode("verify",        verifyNode);
  g.addNode("judge",         judgeNode);

  // Wire edges
  g.addEdge("elicit", "spec");
  g.addEdge("spec", "architect");
  g.addEdge("architect", "rtl_generate");
  g.addEdge("rtl_generate", "rtl_review");
  g.addEdge("rtl_review", "formal_props");
  g.addEdge("rtl_generate", "formal_props");
  g.addEdge("formal_props", "lint");
  g.addEdge("lint", "test_generate");
  g.addEdge("test_generate", "test_review");
  // After test_review (or test_generate if review skipped), the optional
  // lint_test stage runs before verify.
  g.addEdge("test_review", "lint_test");
  g.addEdge("test_generate", "lint_test");
  // Edges into verify cover all combinations of optional stage skipping.
  g.addEdge("lint_test", "verify");
  g.addEdge("test_review", "verify");
  g.addEdge("test_generate", "verify");
  g.addEdge("verify", "judge");

  return g.compile();
}
