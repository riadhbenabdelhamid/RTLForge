// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/elicit — Stage 1: Requirements Elicitation
//
// Generates clarifying questions and assumptions from the user's free-text
// module description. Adds empty answers/customAnswers maps so the UI can
// bind directly to the returned object.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLMJson, addRetryHint } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptElicit } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";
import { extractUserInterfaceContract, validateRequiredModuleName } from "../../utils/interfaceContract.js";

export async function elicitNode(st) {
  const ci = st._childInterfaces || [];
  const childSummary = ci.length > 0
    ? ci.map(function(c) { return { instanceName: c.instanceName, moduleId: c.moduleId, description: c.description }; })
    : null;

  const interfaceContract = extractUserInterfaceContract(st._userDesc);
  const requiredModuleName = validateRequiredModuleName(
    st._config && st._config.requiredModuleName, interfaceContract);
  let p = promptElicit(st._userDesc, childSummary, interfaceContract, requiredModuleName);
  p = await applySkillsToPrompt(p, st, "elicit");
  const _sc = getStageConfig(st._config, "elicit");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  addRetryHint(p, st._lastError);

  // callLLMJson = callLLM + extractJSON + one hinted re-ask on parse failure.
  const jr = await callLLMJson(p);
  const d = jr.data;
  // An explicitly named module is a source fact, not a model preference.
  // Keep the model's spelling verbatim so every later stage addresses the
  // same external contract.
  if (interfaceContract.explicit.moduleName) d.modName = interfaceContract.moduleName;
  if (requiredModuleName && d.modName !== requiredModuleName) {
    throw new Error("elicitation returned module name \"" + String(d.modName || "")
      + " but requiredModuleName is \"" + requiredModuleName + "\"");
  }
  if (requiredModuleName) d.modName = requiredModuleName;
  d._interfaceContract = interfaceContract;
  d.answers = {};
  d.customAnswers = {};
  d.assumptions = (d.assumptions || []).map(a => ({ ...a, confirmationOrigin: "automatic" }));

  // _llms (plural) for the Duration/Tokens tabs. Every attempt (incl. a
  // failed-parse one that triggered the re-ask) is ledgered; _llm stays the
  // last attempt. Attached to `d` so it lands in stageData[id]._llms (a
  // top-level _llms is dropped by runStage's `result = newState[stageKey]`).
  const _llms = jr.llms.map(function(r) { return Object.assign({ stage: "elicit" }, r); });
  const _llm = _llms[_llms.length - 1];
  d._llms = _llms;
  return { elicit: d, _llm: _llm, _llms: _llms };
}
