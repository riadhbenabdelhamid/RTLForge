// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// trainingExport — fine-tuning pairs from finished runs (roadmap #11)
//
// Measured conclusion of the knowledge thread: prompt-injected lessons gave
// zero lift on local models, while every run already produces exactly what
// real fine-tuning consumes — and threw it away. Checkpoints retain the spec,
// every fix iteration's before/after code + error lists, and the final judged
// code. This module turns them into:
//   sftPairs    — (spec+architecture → final RTL/TB) supervised pairs, ONLY
//                 from judge-PASSED runs (no learning from unverified code);
//   repairPairs — (before-code + lint findings → after-code) DPO triples, ONLY
//                 from fix iterations that measurably improved (fewer errors
//                 at the next lint).
// Pure; the CLI serializes to JSONL. Input is the checkpoint's id-keyed
// stageData map (2 spec, 3 architect, 4 rtl, 6 lint, 7 tb, 9 judge, 12 lint_test).
// ═══════════════════════════════════════════════════════════════════════════

import { stripMeta, j } from "../prompts/base.js";

function findingsList(errorList) {
  return (errorList || []).slice(0, 20)
    .map((e) => "- [" + (e.code || "ERR") + "] " + (e.msg || "")).join("\n");
}

// Which model produced a stage. _llms holds the full response telemetry and is
// the first thing the checkpoint size guard sheds, so a trimmed checkpoint
// keeps only the distilled `_models` list — read that too, or every row from a
// large run reports model: null, and large runs are the ones worth training on.
function modelOf(stage) {
  const llms = (stage && stage._llms) || [];
  for (const c of llms) if (c && c.model) return c.model;
  const kept = (stage && stage._models) || [];
  return kept.length ? kept[0] : null;
}

/**
 * Supervised pairs from a judge-PASSED module. RTL pair: spec+architecture →
 * final (post-fix) RTL. TB pair: spec+RTL → final testbench.
 */
export function sftPairs(stageData, meta) {
  const sd = stageData || {};
  const judge = sd[9] || {};
  if (judge.overall !== "PASS") return [];
  const out = [];
  const spec = sd[2], arch = sd[3], rtl = sd[4] && sd[4].code, tb = sd[7] && sd[7].code;
  const base = Object.assign({ verdict: "PASS" }, meta || {});
  if (spec && arch && rtl) {
    out.push({
      prompt: "Write synthesizable SystemVerilog implementing this specification and architecture.\n\nSPECIFICATION:\n"
        + j(stripMeta(spec)) + "\n\nARCHITECTURE:\n" + j(stripMeta(arch)),
      completion: rtl,
      meta: Object.assign({ kind: "sft-rtl", model: modelOf(sd[4]) }, base),
    });
  }
  if (spec && rtl && tb) {
    out.push({
      prompt: "Write a self-checking SystemVerilog testbench for this module.\n\nSPECIFICATION:\n"
        + j(stripMeta(spec)) + "\n\nRTL:\n" + rtl,
      completion: tb,
      meta: Object.assign({ kind: "sft-tb", model: modelOf(sd[7]) }, base),
    });
  }
  return out;
}

/**
 * DPO triples from fix iterations that measurably improved: iteration k's
 * patch is kept only when the NEXT lint saw fewer errors. chosen = the code
 * that improved, rejected = the code it replaced.
 */
export function repairPairs(stageData, meta) {
  const sd = stageData || {};
  const out = [];
  for (const [id, kind] of [[6, "repair-rtl"], [12, "repair-tb"]]) {
    const its = (sd[id] && sd[id].iterations) || [];
    for (let k = 0; k + 1 < its.length; k++) {
      const cur = its[k], next = its[k + 1];
      const st = cur && cur._structured;
      if (!st || !st.beforeCode || !st.afterCode || st.afterCode === st.beforeCode) continue;
      if (!(typeof next.errors === "number" && typeof cur.errors === "number" && next.errors < cur.errors)) continue;
      out.push({
        prompt: "Fix these Verilator findings without changing behavior.\n\nFINDINGS:\n"
          + findingsList(cur.errorList) + "\n\nCODE:\n" + st.beforeCode,
        chosen: st.afterCode,
        rejected: st.beforeCode,
        meta: Object.assign({
          kind, errorsBefore: cur.errors, errorsAfter: next.errors, model: modelOf(sd[id]),
        }, meta || {}),
      });
    }
  }
  return out;
}
