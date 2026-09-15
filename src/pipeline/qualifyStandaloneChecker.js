// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { callLLMJson } from "../llm/index.js";
import { promptStandaloneTBReview, promptStandaloneTB } from "../prompts/standaloneTest.js";
import { CODE_SCHEMA } from "../prompts/schemas.js";
import { djb2 } from "../utils/hash.js";
import { maybeRepair } from "./syntaxRepair.js";
import { detectImplausibleArtifact } from "./fixLoopHelpers.js";

// Shared by both checker creation paths. Correction happens before comparison
// and sees only source/header/checker/review; neither RTL nor candidate scores.
// A semantic PASS remains a review, not proof of an oracle's correctness.
export async function qualifyStandaloneChecker(candidate, header, modName, st, config, llms) {
  if (!candidate?.code) return candidate;
  const inputHash = djb2(String(st._userDesc || "") + "\n" + String(header || ""));
  const cfg = st._config || {};
  const maxRepairs = cfg.standaloneCheckerRepairIters === 0 ? 0 : 1;
  const attempts = [];
  const calls = [];
  let current = candidate;
  let data = {}, reason = "standaloneCheckerReview is disabled; checker evidence is not trusted";
  let passed = false, status = "UNREVIEWED";
  const invoke = async (prompt, stage) => {
    prompt.config = config;
    prompt.onChunk = st._onLog;
    try {
      const result = await callLLMJson(prompt);
      const records = (result.llms || []).map(r => ({ stage, ...r }));
      llms.push(...records); calls.push(...records);
      return result.data || {};
    } catch (e) {
      const records = (e.llms || []).map(r => ({ stage, ...r }));
      llms.push(...records); calls.push(...records);
      throw e;
    }
  };
  if (cfg.standaloneCheckerReview !== false) {
    try {
      for (let attempt = 0; attempt <= maxRepairs; attempt++) {
        const prompt = promptStandaloneTBReview(st._userDesc, header, current.code, modName);
        prompt.maxTokens = Math.min(config._maxTokens || 1200, 1200);
        data = await invoke(prompt, "test_generate@standalone-review");
        const shape = Array.isArray(data.findings) && data.findings.every(f => f
          && /^(critical|major|minor)$/i.test(f.severity || "") && String(f.text || "").trim());
        status = String(data.status || "").toUpperCase();
        passed = status === "PASS" && shape && !data.findings.some(f => /^(critical|major)$/i.test(f.severity));
        if (!shape || !/^(PASS|FAIL)$/.test(status)) status = "INVALID";
        if (status === "PASS" && !passed) status = "INVALID";
        attempts.push({ sourceHash: djb2(current.code), status: passed ? "PASS" : status,
          findings: Array.isArray(data.findings) ? data.findings.slice(0, 12) : [] });
        reason = passed ? null : "checker review did not return an unambiguous PASS";
        if (passed || status !== "FAIL" || attempt === maxRepairs) break;
        const repair = promptStandaloneTB(st._userDesc, header, modName);
        repair.userMessage += "\n\nCorrect this checker using the review below. Resolve timing from the original source; "
          + "a review opinion is not a new requirement. Preserve all source-defined checks.\nCHECKER:\n" + current.code
          + "\nREVIEW:\n" + JSON.stringify(data);
        repair.maxTokens = config._maxTokens;
        repair.jsonSchema = CODE_SCHEMA;
        const fixed = await invoke(repair, "test_generate@standalone-repair");
        if (!fixed.code || detectImplausibleArtifact(fixed.code)) {
          reason = "checker correction was empty or incomplete"; break;
        }
        const repaired = maybeRepair(cfg, fixed.code);
        current = { ...current, code: repaired.code, syntaxRepairs: repaired.fixes || [] };
      }
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      status = "UNREVIEWED"; passed = false; reason = String(e.message || e);
    }
  }
  return { ...current, status: passed ? "READY" : "UNREVIEWED", qualification: {
    status: passed ? "PASS" : status, method: "bounded-independent-review", scope: "semantic-review-only",
    summary: String(data.summary || ""), findings: Array.isArray(data.findings) ? data.findings.slice(0, 12) : [],
    reason, maxRepairs, attempts, sourceHash: djb2(current.code), inputHash,
    calls: calls.map(({ stage, model, provider, tokensIn, tokensOut, latencyMs, stopReason }) =>
      ({ stage, model, provider, tokensIn, tokensOut, latencyMs, stopReason })),
  } };
}
