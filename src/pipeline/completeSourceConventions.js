// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { callLLMJson } from "../llm/index.js";
import { sys, j } from "../prompts/base.js";
import { buildSourceContract } from "./sourceContract.js";
import { sourceConventionLedger } from "./sourceConventions.js";
import { elicitationSnapshot } from "./designContract.js";

// Spec-only, bounded and independent of implementation. Never called from a
// checker/RTL repair: changing these choices requires a new specification.
export async function completeSourceConventions(st, spec, config) {
  if (!st._config?.specReask || st._specImport || spec.sourceConventions != null) return { spec, llms: [] };
  const source = String(st._userDesc || "");
  const contract = buildSourceContract(source, spec, spec.modName);
  if (!contract.tables.length || !contract.issues.some(i => /^SOURCE.T\d+$/.test(i.id)
      && /unknown signal column|ambiguous or unsupported literal|unresolved sampling phase/.test(i.reason))) return { spec, llms: [] };
  const prompt = {
    systemPrompt: sys("Complete source table notation before implementation. Record provisional interpretations, never user facts."),
    userMessage: `ORIGINAL SOURCE:\n${j(source)}
SPECIFICATION:\n${j({ iface: spec.iface, requirements: spec.requirements })}
ELICITATION CHOICES:\n${j(elicitationSnapshot(st.elicit))}
SOURCE TABLES:\n${j(contract.tables)}
UNRESOLVED NOTATION:\n${j(contract.issues)}
Inspect ALL columns and coincident clock/input transitions; the parser may have
stopped at the first problem. Choose only missing signal aliases, numeric bases,
and input/clock ordering. Existing explicit source conventions take precedence.
Use the original source and selected elicitation choices, never RTL behavior.
Do not change requirements, rows, expected outputs, widths, or latency. For an
unanswered timing question, distinguish drive time, sampling edge, and post-NBA
observation; a post-edge result does not require an extra clock edge. Match
selected specification choices; leave incompatible or unsupported choices absent.
Each choice is an unconfirmed LLM interpretation: quote exact triggering source
passages, explain the inference, and list plausible alternatives. A quote need
not explicitly state the interpretation. Do not claim the user confirmed it.
Return only {"sourceConventions":[{"table":"SOURCE.T1",
"kind":"alias | radix | phase","column":"<original column; omit for phase>",
"value":"<actual port for alias, numeric 2/10/16 for radix, inputs-before-clock or clock-before-inputs for phase>",
"reasoning":"<source-based inference>","sources":[{"quote":"<verbatim passage>"}],
"alternatives":["<alternative interpretation>"]}]}.
Include only needed choices. This is not permission to resolve contradictory
explicit requirements or rewrite the specification.`,
    config, maxTokens: config._maxTokens, onChunk: st._onLog, signal: st._signal,
  };
  st._onLog?.("↻ SOURCE TABLE INTERPRETATION\nRecording notation choices before freezing the specification.");
  let result;
  try { result = await callLLMJson(prompt, { parseRetries: 0 }); }
  catch (error) {
    if (st._signal?.aborted) throw error;
    return { spec: { ...spec, _sourceConventionReview: { status: "UNRESOLVED", reason: String(error?.message || error) } }, llms: error?.llms || [] };
  }
  const response = result?.data;
  const validShape = response && Object.keys(response).length === 1 && Array.isArray(response.sourceConventions);
  // Normalize only exact radix spellings at the model-response boundary.
  // Keep the raw response for audit; the validator and frozen contract still
  // require numeric radices. Never coerce other fields or normalize on replay.
  const normalizations = [];
  const sourceConventions = validShape ? response.sourceConventions.map((choice, index) => {
    if (choice?.kind !== "radix" || !["2", "10", "16"].includes(choice.value)) return choice;
    const value = Number(choice.value);
    normalizations.push({ index, table: choice.table, column: choice.column,
      field: "value", from: choice.value, to: value });
    return { ...choice, value };
  }) : [];
  const proposed = { ...spec, sourceConventions };
  const ledger = sourceConventionLedger(source, proposed);
  const accepted = validShape && !ledger.issues.length;
  return { spec: { ...(accepted ? proposed : spec), _sourceConventionReview: {
    status: accepted && ledger.entries.length ? "RECORDED" : "UNRESOLVED",
    issues: ledger.issues, response, normalizations,
  } }, llms: (result?.llms || []).map(r => ({ ...r, purpose: "source_convention_completion" })) };
}
