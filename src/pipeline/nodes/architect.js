// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/architect — Stage 3: Micro-Architecture
//
// Generates block-level architecture strategy and Mermaid diagram.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON, addRetryHint } from "../../llm/index.js";
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

  const r = await callLLM(p);
  const _llm = Object.assign({ stage: "architect" }, r);
  const archData = extractJSON(r.text, r);
  archData._llms = [_llm];
  return {
    architect: archData,
    _llm: _llm,
    _llms: [_llm],
  };
}
