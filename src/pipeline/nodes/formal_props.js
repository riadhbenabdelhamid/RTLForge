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

import { callLLM, extractJSON } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptFormalProps } from "../../prompts/index.js";
import { deriveConstraints } from "../../utils/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";

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

  const r = await callLLM(p);
  const fpResult = extractJSON(r.text, r);
  // Merge auto-assumptions into the result (separate from LLM-generated properties)
  fpResult.autoAssumptions = autoAssumptions;

  const _llm = Object.assign({ stage: "formal_props" }, r);
  fpResult._llms = [_llm];
  return {
    formal_props: fpResult,
    _llm: _llm,
    _llms: [_llm],
  };
}
