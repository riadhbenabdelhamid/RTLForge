// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/formal_props — Stage 5: Formal SVA Property Generation
//
// Generates SVA assertions and cover statements bound to the DUT.
// Also auto-derives constraints from the spec's parameter ranges and passes
// them to the prompt so the LLM doesn't regenerate equivalent assumes.
// The auto-derived constraints are merged into the result under the
// `autoAssumptions` field, separate from LLM-generated properties.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLMJson } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptFormalProps } from "../../prompts/index.js";
import { deriveConstraints } from "../../utils/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { validateAuxModel, uncoveredOutputPorts } from "../svaBind.js";

export async function formalPropsNode(st) {
  const ci = st._childInterfaces || [];

  // Auto-derive constraints from spec parameter ranges
  const autoAssumptions = deriveConstraints(st.spec);

  let p = promptFormalProps(
    st.rtl_generate.code || "",
    st.spec,
    st.elicit,
    ci,
    autoAssumptions,
  );
  p = await applySkillsToPrompt(p, st, "formal_props");
  const _sc = getStageConfig(st._config, "formal_props");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;

  // callLLMJson = callLLM + extractJSON + ONE hinted re-ask on parse failure.
  // SVA code embedded in JSON strings is the most defect-prone output in the
  // pipeline (quotes/parens/braces in code text) — telling the model exactly
  // what broke and asking again converts most residual formatting failures
  // into a slow-but-successful stage instead of a dead one. jr.llms carries
  // every attempt (failed ones included) so the ledger sees real spend.
  let jr = await callLLMJson(p);
  let fpResult = jr.data;
  let allJrLlms = jr.llms;

  // ─── Aux-model validation with ONE corrective re-ask (measured: run 16 —
  // gpt-oss-20b produced a correct occupancy model on the first try but
  // sized it with the RTL-internal localparam CNT_W; the checker can only
  // see spec parameters, so the aux was dropped downstream and every
  // occupancy property silently skipped, taking the whole formal check
  // with it. Telling the model exactly which identifier failed converts
  // that into a working proof.) Still-invalid aux after the re-ask is left
  // for buildSvaChecker's graceful drop — the build never breaks.
  if (fpResult && fpResult.aux) {
    const portNames = new Set(((st.spec && st.spec.iface) || []).map(function(x) { return x.name; }).filter(Boolean));
    const paramNames = new Set(((st.spec && st.spec.params) || []).map(function(x) { return x.name; }).filter(Boolean));
    const v = validateAuxModel(fpResult.aux, portNames, paramNames);
    if (v.error) {
      if (st._onLog) st._onLog("↻ AUX-MODEL RE-ASK (formal_props)\n"
        + "The aux model would be dropped downstream: " + v.error + ". Re-asking with the allowed names.");
      const p2 = Object.assign({}, p, {
        userMessage: (p.userMessage || "") + "\n\n━━ AUX MODEL CORRECTION ━━\n"
          + "The previous \"aux\" block is unusable: " + v.error + ".\n"
          + "The aux block may reference ONLY these names — ports: "
          + Array.from(portNames).join(", ") + "; parameters: "
          + Array.from(paramNames).join(", ")
          + "; plus the f_ names it declares itself. Size widths from the "
          + "parameters (e.g. [$clog2(DEPTH):0]) — RTL-internal localparams "
          + "do not exist in the checker. Return the complete JSON again.",
      });
      jr = await callLLMJson(p2);
      if (jr.data && typeof jr.data === "object") fpResult = jr.data;
      allJrLlms = allJrLlms.concat(jr.llms);
      const v2 = fpResult && fpResult.aux
        ? validateAuxModel(fpResult.aux, portNames, paramNames) : { error: "aux missing after re-ask" };
      if (v2.error && st._onLog) {
        st._onLog("⚠ AUX MODEL STILL INVALID after re-ask (" + v2.error + ") — "
          + "properties referencing it will be skipped at bind time.");
      }
    }
  }

  // ─── Output-port property coverage with ONE corrective re-ask (run 18 —
  // the dout update-gating bug was exactly the class a stability property
  // catches, but nothing guaranteed the property set observed every output
  // at all). Deterministic check: each spec output must appear in at least
  // one property/cover expression. Still-uncovered after the re-ask is a
  // loud log, never a halt — the eval gate keeps final authority.
  if (fpResult && Array.isArray(fpResult.properties)) {
    const uncovered = uncoveredOutputPorts(fpResult, st.spec);
    if (uncovered.length > 0) {
      if (st._onLog) st._onLog("↻ OUTPUT COVERAGE RE-ASK (formal_props)\n"
        + "No property observes output port" + (uncovered.length === 1 ? "" : "s") + ": "
        + uncovered.join(", ") + ". Re-asking with the update-gating template.");
      const p3 = Object.assign({}, p, {
        userMessage: (p.userMessage || "") + "\n\n━━ OUTPUT PROPERTY COVERAGE ━━\n"
          + "The previous property set never references these OUTPUT ports: "
          + uncovered.join(", ") + ". Every output must be observed by at "
          + "least one assert or cover. For registered data outputs, add the "
          + "update-gating form: assert property (@(posedge clk) disable iff "
          + "(<reset>) !(<update_condition>) |=> $stable(<output>)); — for "
          + "status flags, assert their defining value condition. Return the "
          + "complete JSON again with ALL previous properties kept.",
      });
      jr = await callLLMJson(p3);
      if (jr.data && typeof jr.data === "object" && Array.isArray(jr.data.properties)) {
        fpResult = jr.data;
      }
      allJrLlms = allJrLlms.concat(jr.llms);
      const still = uncoveredOutputPorts(fpResult, st.spec);
      if (still.length > 0 && st._onLog) {
        st._onLog("⚠ OUTPUTS STILL UNOBSERVED after re-ask: " + still.join(", ")
          + " — the formal check cannot catch bugs on these ports.");
      }
    }
  }

  // Merge auto-assumptions into the result (separate from LLM-generated properties)
  fpResult.autoAssumptions = autoAssumptions;

  const _llms = allJrLlms.map(function(r) { return Object.assign({ stage: "formal_props" }, r); });
  const _llm = _llms[_llms.length - 1];
  fpResult._llms = _llms;
  return {
    formal_props: fpResult,
    _llm: _llm,
    _llms: _llms,
  };
}
