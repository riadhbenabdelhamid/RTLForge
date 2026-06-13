// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/architect — Stage 3: Micro-Architecture
//
// Generates block-level architecture strategy and Mermaid diagram.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLMJson, addRetryHint } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptArch } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";

export async function architectNode(st) {
  const ci = st._childInterfaces || [];
  let p = promptArch(st.spec, st.elicit, ci);
  p = await applySkillsToPrompt(p, st, "architect");
  const _sc = getStageConfig(st._config, "architect");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  addRetryHint(p, st._lastError);

  // callLLMJson = callLLM + extractJSON + one hinted re-ask on parse failure.
  const jr = await callLLMJson(p);
  const archData = jr.data;
  const _llms = jr.llms.map(function(r) { return Object.assign({ stage: "architect" }, r); });
  const _llm = _llms[_llms.length - 1];
  archData._llms = _llms;
  return {
    architect: archData,
    _llm: _llm,
    _llms: _llms,
  };
}
