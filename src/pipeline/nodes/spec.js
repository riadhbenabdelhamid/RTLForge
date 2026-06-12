// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// nodes/spec — Stage 2: Formal Specification
//
// Two modes:
// 1. Elicit-driven (normal): uses promptSpec with answered elicit questions.
// 2. Full-auto (no elicit): uses promptSpecFromDescription to derive a spec
//    directly from the user description, then synthesises a minimal elicit
//    object with modName/domain so downstream stages have el.modName to
//    reference.
// ═══════════════════════════════════════════════════════════════════════════

import { callLLMJson, addRetryHint } from "../../llm/index.js";
import { getStageConfig } from "../../constants/index.js";
import { promptSpec, promptSpecFromDescription } from "../../prompts/index.js";
import { applySkillsToPrompt } from "../applySkillsToPrompt.js";

export async function specNode(st) {
  const ci = st._childInterfaces || [];
  const hasElicit = st.elicit && st.elicit.modName && st.elicit.questions && st.elicit.questions.length > 0;

  let p;
  const extraReturn = {};

  if (hasElicit) {
    p = promptSpec(st.elicit, ci);
  } else {
    // Full-auto mode: generate spec directly from the user description
    p = promptSpecFromDescription(st._userDesc, ci);
  }

  // Skill overlay applies to both modes — same stageKey "spec".
  p = await applySkillsToPrompt(p, st, "spec");

  const _sc = getStageConfig(st._config, "spec");
  p.config = _sc;
  p.maxTokens = _sc._maxTokens;
  p.onChunk = st._onLog;
  // Cross-RUN hint: when the user manually re-runs the stage after a
  // failure, st._lastError carries the previous run's message.
  addRetryHint(p, st._lastError);

  // callLLMJson adds the IN-CALL recovery: callLLM + extractJSON + one
  // hinted re-ask when the reply fails to parse (the spec's long
  // requirement lists are a frequent JSON-defect source). jr.llms carries
  // every attempt so the ledger sees real spend.
  const jr = await callLLMJson(p);
  const specData = jr.data;

  // ─── Align requirement cat with id-prefix ─────────────────────────────
  // The LLM sometimes returns mismatched (id, cat) pairs — e.g.
  // id="REQ-FUNC-003" with cat="Interface". The ID prefix is more
  // reliably tied to intent than the free-text cat field, so when there's
  // a mismatch we override the cat to match the prefix. This keeps the
  // eval gate (which uses cat to bucket requirements) accurate.
  //
  // Mapping: REQ-INTF-* → "Interface", REQ-FUNC-* → "Functionality",
  // REQ-TIME-* → "Timing", REQ-ERR-* → "Error", REQ-VERIF-* → "Verification".
  // Unknown prefixes are left alone (no override).
  if (specData && Array.isArray(specData.requirements)) {
    const PREFIX_TO_CAT = {
      INTF:  "Interface",
      FUNC:  "Functionality",
      TIME:  "Timing",
      ERR:   "Error",
      VERIF: "Verification",
    };
    let aligned = 0;
    specData.requirements = specData.requirements.map(function(req) {
      if (!req || typeof req.id !== "string") return req;
      const m = /^REQ-([A-Z]+)-\d+$/.exec(req.id);
      if (!m) return req;
      const expectedCat = PREFIX_TO_CAT[m[1]];
      if (!expectedCat) return req;
      if (req.cat !== expectedCat) {
        aligned++;
        return Object.assign({}, req, { cat: expectedCat });
      }
      return req;
    });
    if (aligned > 0 && st._onLog) {
      st._onLog("ℹ spec node: auto-corrected " + aligned +
        " requirement(s) whose cat field didn't match the id-prefix.");
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  // When generated from description, the result also contains modName and domain
  // — synthesise a minimal elicit object so downstream stages have el.modName
  if (!hasElicit && specData.modName) {
    extraReturn.elicit = {
      modName: specData.modName,
      domain: specData.domain || "",
      questions: [],
      assumptions: [],
      answers: {},
      customAnswers: {},
      _fromDescription: true,
    };
  }

  extraReturn.spec = specData;
  // Every attempt (incl. any failed-parse one that triggered the hinted
  // re-ask) is ledgered; _llm stays the LAST attempt for back-compat.
  const _llms = jr.llms.map(function(r) { return Object.assign({ stage: "spec" }, r); });
  extraReturn._llm = _llms[_llms.length - 1];
  // _llms mirror for the Duration/Tokens tabs; attached to specData so it lands
  // in stageData[2]._llms.
  specData._llms = _llms;
  extraReturn._llms = _llms;
  return extraReturn;
}
