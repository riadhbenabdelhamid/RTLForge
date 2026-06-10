// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// observer/extractor — LLM-driven signal extraction from stage results
//
// Per the design conversation (Q: signal extraction = LLM-driven on
// every observation), this module runs one focused LLM call per stage
// completion. The prompt is intentionally TIGHT:
//   - small input (only the fields that contain signal)
//   - JSON-only output with a fixed shape
//   - low temperature for determinism
//   - low maxTokens cap to bound cost
//
// If the extractor returns kind = "nothing", ingest.js skips the DB
// write. That's the path most successful stages take.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_SYSTEM_PROMPT =
  "You are an observer agent extracting insights from a hardware-design pipeline run. " +
  "Your job is to spot noteworthy patterns: recurring errors, fixes that worked, " +
  "skills that helped or hurt, prompt drift, unusual costs. " +
  "Respond with ONLY a JSON object matching the requested schema. No prose, no markdown.";

const DEFAULT_SCHEMA = `{
  "kind":       "error" | "fix" | "skill_effect" | "drift" | "cost" | "nothing",
  "summary":    "<one line, ≤120 chars, plain text>",
  "severity":   "info" | "warn" | "high",
  "tags":       ["<short keyword>", ...],
  "actionable": true | false
}`;

const DEFAULT_RULES = [
  "Rules:",
  "- Return {\"kind\":\"nothing\"} if the stage was uneventful (e.g. clean pass with no fixes, no warnings, normal cost).",
  "- Use kind=\"error\" for unrecovered failures or recurring lint/verify errors.",
  "- Use kind=\"fix\" when a fix was successfully applied that was noteworthy.",
  "- Use kind=\"skill_effect\" when a skill overlay helped or hurt this stage.",
  "- Use kind=\"drift\" when output quality seems off from typical (regression).",
  "- Use kind=\"cost\" when token usage or latency is unusually high.",
  "- severity=high if user should be alerted; warn if useful to know; info otherwise.",
  "- Tags are 1-4 short keywords for clustering (e.g. \"width-mismatch\", \"reset-polarity\").",
  "- actionable=true if the user could change something based on this observation.",
].join("\n");

// Back-compat exports (existing call sites use SYSTEM_PROMPT + SCHEMA)
export const SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
export const SCHEMA = DEFAULT_SCHEMA;

/**
 * Resolve the active extraction-prompt sections, honoring any user
 * override in config.promptOverrides._observer (sections 0-2 are the
 * extraction prompt; section 3 is the surfacing template, not used by
 * the extractor).
 *
 * The user can edit the extraction prompt from Workflow Settings → Observer
 * Agent block → double-click.
 */
function resolveExtractionPrompt(config) {
  const overrides = config && config.promptOverrides && config.promptOverrides._observer;
  if (Array.isArray(overrides) && overrides.length > 0) {
    // Sections 0-2 → system identity + schema + rules. We concatenate
    // them with double-newline separators and let the LLM see them as
    // one system message. Section 3 (surfacing) is intentionally NOT
    // included here.
    const extractionSections = overrides.slice(0, 3);
    if (extractionSections.length > 0) {
      const systemPrompt = (extractionSections[0] && extractionSections[0].content) || DEFAULT_SYSTEM_PROMPT;
      const schemaSection = (extractionSections[1] && extractionSections[1].content) || DEFAULT_SCHEMA;
      const rulesSection  = (extractionSections[2] && extractionSections[2].content) || DEFAULT_RULES;
      return { systemPrompt: systemPrompt, schema: schemaSection, rules: rulesSection };
    }
  }
  return { systemPrompt: DEFAULT_SYSTEM_PROMPT, schema: DEFAULT_SCHEMA, rules: DEFAULT_RULES };
}

/**
 * Build the user-facing prompt for one stage's input.
 *
 * @param {object} raw     - the small object built by ingest.js
 * @param {object} parts   - { schema, rules } from resolveExtractionPrompt
 */
function buildPrompt(raw, parts) {
  return [
    "Extract one observation from this stage result.",
    "Schema (JSON only): " + parts.schema,
    "",
    parts.rules,
    "",
    "Stage input:",
    JSON.stringify(raw, null, 2),
  ].join("\n");
}

/**
 * Run the extractor on a built `raw` object.
 *
 * @param {object} raw       - context summary built by ingest.js
 * @param {object} services  - { callLLM, extractJSON, config }
 * @returns {Promise<{kind, summary, severity, tags, actionable}>}
 *
 * Falls back gracefully: any error (LLM timeout, malformed JSON, network
 * down) produces `{kind: "nothing"}` rather than throwing. The observer
 * must NEVER affect the pipeline run.
 */
export async function extractObservation(raw, services) {
  if (!services || typeof services.callLLM !== "function") {
    return { kind: "nothing", summary: "no LLM available", severity: "info", tags: [], actionable: false };
  }
  // Honor a user-overridden extraction prompt (sections 0-2 of
  // config.promptOverrides._observer).
  const parts = resolveExtractionPrompt(services.config || {});
  const prompt = {
    systemPrompt: parts.systemPrompt,
    userMessage:  buildPrompt(raw, parts),
    maxTokens:    200,    // observation responses are tiny
    config: Object.assign({}, services.config || {}, {
      temperature: 0.1,    // low — we want deterministic extraction
    }),
  };
  try {
    const r = await services.callLLM(prompt);
    const parsed = services.extractJSON
      ? services.extractJSON(r.text)
      : safeParse(r.text);
    if (!parsed || typeof parsed !== "object") {
      return { kind: "nothing", summary: "parse failed", severity: "info", tags: [], actionable: false };
    }
    // Normalize fields the LLM might omit
    return {
      kind:       String(parsed.kind || "nothing"),
      summary:    String(parsed.summary || "").slice(0, 200),
      severity:   ["info", "warn", "high"].includes(parsed.severity) ? parsed.severity : "info",
      tags:       Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 4) : [],
      actionable: !!parsed.actionable,
    };
  } catch (_e) {
    return { kind: "nothing", summary: "extractor error", severity: "info", tags: [], actionable: false };
  }
}

function safeParse(text) {
  try {
    // Strip markdown fences if present
    const m = /\{[\s\S]*\}/.exec(text);
    return m ? JSON.parse(m[0]) : null;
  } catch (_e) { return null; }
}
