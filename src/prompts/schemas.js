// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// prompts/schemas — JSON schemas for structured outputs (roadmap #1)
//
// Passed as `jsonSchema` on the prompt args; callLLM threads them to the
// provider builders (OpenAI-compat response_format json_schema, Ollama format;
// Anthropic no-op). Grammar-constrained decoding makes malformed/truncated
// JSON impossible at the decoder — the measured top time sink (escalation
// ladders + extractJSON re-asks) on local models.
//
// Design choices:
// - `strict: false` for maximum server compatibility — llama.cpp constrains
//   from the schema regardless; OpenAI strict-mode has extra requirements
//   (all-required + additionalProperties:false) that would 400 on optional
//   fields, and the callLLM 400-fallback would then waste a round-trip.
// - `additionalProperties: true` explicitly — some grammar implementations
//   treat absence as `false`, which would forbid harmless extra keys the
//   prompts invite (explanations, notes). Balanced-JSON + required `code`
//   is the guarantee we need; extra keys are noise extractJSON already skips.
// ═══════════════════════════════════════════════════════════════════════════

/** Cold RTL/TB generation: { code } (+ free extras). */
export const CODE_SCHEMA = {
  name: "sv_code",
  strict: false,
  schema: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
    additionalProperties: true,
  },
};

/** Fix-loop responses: { code, fixes[] } (+ free extras). */
export const FIX_SCHEMA = {
  name: "sv_fix",
  strict: false,
  schema: {
    type: "object",
    properties: {
      code:  { type: "string" },
      fixes: { type: "array", items: { type: "string" } },
    },
    required: ["code"],
    additionalProperties: true,
  },
};
