// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/elicit — Stage 1: Requirements Elicitation
//
// Generates clarifying questions and assumptions from the user's free-text
// module description. Adds empty answers/customAnswers maps so the UI can
// bind directly to the returned object.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLM, extractJSON, addRetryHint } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptElicit } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";

export async function elicitNode(st) {
  const ci = st._childInterfaces || [];
  const childSummary = ci.length > 0
    ? ci.map(function(c) { return { instanceName: c.instanceName, moduleId: c.moduleId, description: c.description }; })
    : null;

  let p = promptElicit(st._userDesc, childSummary);
  p = await applySkillsToPrompt(p, st, "elicit");
  const _sc = getStageConfig(st._config, "elicit");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  addRetryHint(p, st._lastError);

  const r = await callLLM(p);
  const d = extractJSON(r.text, r);
  d.answers = {};
  d.customAnswers = {};

  // _llms (plural) for the Duration/Tokens tabs. Single-call nodes get a
  // singleton array so every stage exposes a uniform shape. Attached to `d`
  // itself so it lands in stageData[id]._llms (a top-level _llms is dropped by
  // runStage's `result = newState[stageKey]` slicing).
  const _llm = Object.assign({ stage: "elicit" }, r);
  d._llms = [_llm];
  return { elicit: d, _llm: _llm, _llms: [_llm] };
}
