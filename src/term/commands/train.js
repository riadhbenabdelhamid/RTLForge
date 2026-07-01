// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/train — training mode (docs/training-mode.md)
//
//   rtlforge train rtl                 one truncated RTL training pass (stop at lint)
//   rtlforge train tb                  one truncated TB training pass (stop at lint_test)
//   rtlforge train rtl --auto          automated loop (sources specs, self-stops)
//
// Options:
//   --spec <id|description>   seed spec (BENCH_SPECS id or literal text)
//   --loop single|refine      Q1: one pass, or re-inject + regenerate on one spec
//   --expand table|model      Q2: distil only, or LLM-rewrite the rule worklist
//   --source corpus|corpus+mutation|synth|adaptive
//   --seeds N  --max-runs N  --max-minutes N  --max-llm N  --saturation N
//   --model <id> --provider <p>   model under training (tags all harvested rows)
//   --dry-run                 print the plan + curriculum, harvest nothing
//   --rewrite-only            sharpen the existing catalog's rules with the
//                             model (Q2) — no harvest, no generation
//
// Truncates the run at the harvest stage, flips errorsToAvoid on for the run,
// and reuses the existing harvest (lint/lint_test) + inject (rtl/test gen) paths.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadApiKey, rtlforgeHome } from "../config.js";
import { c, heading, table } from "../format.js";
import { getActiveStages } from "../../constants/stages.js";
import { callLLM } from "../../llm/index.js";
import {
  buildPipeline, runStages, stageKeysFromActive,
  createFileErrorMemory, aggregateErrors, rulesNeedingReview,
  truncateStagesForTraining, trainingBoundaryStage, distinctSignatureCount,
  isSaturated, budgetState, selectCurriculumTarget, buildSynthSpecPrompt,
  parseSynthSpec, buildRuleRewritePrompt, isValidRewrite, applyRuleRewrite,
} from "../../pipeline/index.js";

function catalogPath() { return path.join(rtlforgeHome(), "errors-to-avoid.json"); }

// A tiny built-in seed pool — the bench corpus is the real one (loaded lazily
// below); this is the fallback when bench/specs.mjs isn't shipped alongside.
const SEED_CORPUS = [
  { id: "counter8", title: "8-bit counter", tags: ["sequential"],
    description: "An 8-bit up counter with clk, synchronous active-high rst, and en. Output count[7:0] increments on each rising clk edge when en is high, wrapping at 255. rst clears count to 0." },
  { id: "mux4", title: "4:1 mux", tags: ["combinational"],
    description: "A combinational 4:1 multiplexer. Inputs a,b,c,d each [7:0] and sel[1:0]; output y[7:0] equals the selected input. Purely combinational, no clock." },
];

async function loadCorpus() {
  try {
    const m = await import("../../../bench/specs.mjs");
    if (m && Array.isArray(m.BENCH_SPECS) && m.BENCH_SPECS.length) return m.BENCH_SPECS;
  } catch (_e) { /* not shipped → fall back */ }
  return SEED_CORPUS;
}

async function llmText(config, prompt, maxTokens, counters) {
  if (counters) counters.llmCalls += 1;
  try {
    const r = await callLLM({ userMessage: prompt, maxTokens: maxTokens || 1024, config: config });
    return (r && r.text) || "";
  } catch (_e) { return ""; }
}

// ── spec sourcing ────────────────────────────────────────────────────────────

async function sourceSpec(srcMode, ctx) {
  const { corpus, config, domain, mem, counters, idx, recentTitles } = ctx;
  if (srcMode === "synth" || srcMode === "adaptive") {
    const target = srcMode === "adaptive"
      ? selectCurriculumTarget(mem.all(), domain)
      : null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = buildSynthSpecPrompt(target, { recentTitles: recentTitles });
      const spec = parseSynthSpec(await llmText(config, prompt, 900, counters));
      if (spec) { spec._target = target; return spec; }
    }
    // synth failed → fall back to corpus so the loop still makes progress
  }
  const pick = corpus[idx % corpus.length];
  if (srcMode === "corpus+mutation") {
    const widths = [4, 8, 16, 32];
    const w = widths[idx % widths.length];
    return Object.assign({}, pick, {
      id: pick.id + "_w" + w,
      description: pick.description + " Override any data-width parameter to " + w + " bits.",
    });
  }
  return pick;
}

// ── one truncated pass (gen → harvest boundary) ──────────────────────────────

async function runPass(ctx, spec, seedOffset) {
  const { pipeline, baseConfig, mem, mode, counters, log } = ctx;
  const domain = mode;
  const config = Object.assign({}, baseConfig);
  if (config.seed != null) config.seed = config.seed + seedOffset;     // seed variation
  const before = distinctSignatureCount(mem.all(), { domain: domain });

  const allKeys = stageKeysFromActive(getActiveStages(config)).filter(function(k) { return k !== "elicit"; });
  const stageKeys = truncateStagesForTraining(allKeys, mode);
  const initialState = { _userDesc: spec.description, _config: config, _services: { errorMemory: mem } };

  let llms = 0;
  await runStages(pipeline, stageKeys, initialState, {
    onStageStart: function(k) { log("    ▶ " + k); },
    onStageComplete: function(k, s) {
      const n = (s[k] && Array.isArray(s[k]._llms)) ? s[k]._llms.length : 0;
      llms += n;
    },
  });
  counters.llmCalls += llms;
  const after = distinctSignatureCount(mem.all(), { domain: domain });
  return { before: before, after: after, gained: after - before, llms: llms };
}

// Per-spec failure isolation: an unattended loop must survive a flaky call
// (e.g. LM Studio's transient "fetch failed"). A thrown stage skips THIS spec —
// it still counts toward the run budget but never aborts the session. Returns
// the gained count, or null when the spec failed.
async function safeRunSpec(ctx, spec) {
  try { return await runSpec(ctx, spec); }
  catch (e) {
    ctx.log(c.yellow("    ⚠ ") + "spec failed (" + ((e && e.message) || e) + ") — skipping");
    return null;
  }
}

// Q1 refine: re-inject the grown avoid-list and regenerate on the SAME spec,
// stopping when a pass adds no new signature or the cap is hit.
async function runSpec(ctx, spec) {
  const { config, mode, log } = ctx;
  const domain = mode;
  if (ctx.loop === "refine") {
    const maxPasses = config.trainingRefineMaxPasses || 4;
    let total = 0;
    for (let p = 0; p < maxPasses; p++) {
      log("  · refine pass " + (p + 1) + "/" + maxPasses + " on " + spec.id);
      const r = await runPass(ctx, spec, p);
      total += r.gained;
      if (r.gained === 0) { log("    (no new lessons — converged)"); break; }
    }
    return total;
  }
  // single (optionally repeated seedsPerSpec times)
  const seeds = Math.max(1, ctx.seedsPerSpec || 1);
  let total = 0;
  for (let s = 0; s < seeds; s++) {
    if (seeds > 1) log("  · seed " + (s + 1) + "/" + seeds + " on " + spec.id);
    total += (await runPass(ctx, spec, s)).gained;
  }
  return total;
}

// ── Q2: LLM-rewrite the rule worklist (once per session, batched) ────────────

async function rewriteRules(ctx) {
  const { config, mem, mode, counters, model, log } = ctx;
  if (!mem.replaceAll) { log(c.yellow("  ⚠ ") + "rule rewrite needs a writable catalog — skipped"); return 0; }
  const worklist = rulesNeedingReview(mem.all()).filter(function(r) {
    return r.domain === mode && (r.model || "") === (model || "");
  });
  let rewritten = 0;
  let rows = mem.all();
  for (const lesson of worklist) {
    // Budget headroom: reasoning models spend tokens on hidden chain-of-thought
    // before the rule, so a tight cap yields empty content. callLLM escalates further.
    const out = (await llmText(config, buildRuleRewritePrompt(lesson), 1024, counters)).trim().replace(/^["']|["']$/g, "");
    if (isValidRewrite(out, lesson)) {
      rows = applyRuleRewrite(rows, { signature: lesson.signature, domain: lesson.domain, model: lesson.model }, out);
      rewritten++;
    }
  }
  if (rewritten > 0) mem.replaceAll(rows);
  log(c.green("  ✓ ") + "rewrote " + rewritten + "/" + worklist.length + " rule(s) with the model");
  return rewritten;
}

// ── learned-rules summary ────────────────────────────────────────────────────

function printSummary(mem, mode, model) {
  let agg = aggregateErrors(mem.all()).filter(function(r) {
    return r.domain === mode && (r.model || "") === (model || "");
  });
  process.stdout.write("\n" + heading("Rules learned — " + mode + " / " + (model || "(unattributed)")) + "\n");
  if (agg.length === 0) { process.stdout.write(c.dim("(none harvested)") + "\n"); return; }
  const rows = agg.slice(0, 20).map(function(r) {
    return {
      count: String(r.count),
      src: r.ruleSource || "-",
      code: r.code || "-",
      rule: (r.rule || r.sample || r.signature || "").slice(0, 72),
    };
  });
  process.stdout.write(table([
    { key: "count", label: "Seen", align: "right" },
    { key: "src",   label: "Src" },
    { key: "code",  label: "Code" },
    { key: "rule",  label: "Rule / sample" },
  ], rows) + "\n");
  const review = rulesNeedingReview(agg).length;
  process.stdout.write(c.dim(agg.length + " distinct lesson(s); " + review + " still on a raw/table rule (run --expand model to sharpen).") + "\n");
}

// ── command ──────────────────────────────────────────────────────────────────

export async function cmdTrain(args) {
  const mode = args._[0];
  if (mode !== "rtl" && mode !== "tb") {
    process.stderr.write(c.red("error:") + " usage: rtlforge train rtl|tb [--auto] [options]\n");
    return 2;
  }

  // Config + auth (training is run-scoped — never persisted to the user config).
  const config = loadConfig({ flags: {} });
  if (args.model) config.model = args.model;
  if (args.provider) config.provider = args.provider;
  config.errorsToAvoid = true;                          // harvest must be on
  config.optionalStages = Object.assign({}, config.optionalStages, { lint: true });
  if (mode === "tb") config.optionalStages.lint_test = true;
  // Run-scoped training knobs from flags.
  if (args.loop) config.trainingLoop = args.loop;
  if (args.expand) config.trainingRuleExpansion = args.expand;
  if (args.source) config.trainingAutoSource = args.source;
  if (args.seeds != null) config.trainingSeedsPerSpec = parseInt(args.seeds, 10) || 1;
  if (args["max-runs"] != null) config.trainingAutoMaxRuns = parseInt(args["max-runs"], 10);
  if (args["max-minutes"] != null) config.trainingAutoMaxMinutes = parseInt(args["max-minutes"], 10);
  if (args["max-llm"] != null) config.trainingAutoMaxLlmCalls = parseInt(args["max-llm"], 10);
  if (args.saturation != null) config.trainingSaturationWindow = parseInt(args.saturation, 10) || 3;

  const apiKey = loadApiKey(config.provider);
  if (!apiKey && config.provider !== "ollama") {
    process.stderr.write(c.red("error:") + " no API key for provider " + c.bold(config.provider) + "\n");
    process.stderr.write("       set with: rtlforge config login --provider " + config.provider + "\n");
    return 2;
  }
  const runtimeConfig = Object.assign({}, config, { apiKey: apiKey });
  const model = runtimeConfig.model || null;

  let mem;
  try { mem = createFileErrorMemory(catalogPath(), { fs: fs }); }
  catch (e) { process.stderr.write(c.red("error:") + " could not open catalog: " + e.message + "\n"); return 1; }

  const corpus = await loadCorpus();
  const source = args.source || runtimeConfig.trainingAutoSource || "adaptive";
  const auto = !!args.auto;
  const limits = {
    maxRuns: runtimeConfig.trainingAutoMaxRuns,
    maxMinutes: runtimeConfig.trainingAutoMaxMinutes,
    maxLlmCalls: runtimeConfig.trainingAutoMaxLlmCalls,
  };

  process.stdout.write(heading("RTL Forge — train " + mode + (auto ? " (auto)" : "")) + "\n");
  process.stdout.write(c.dim("model:    ") + runtimeConfig.provider + " / " + (model || "?") + "\n");
  process.stdout.write(c.dim("boundary: ") + "stop after " + trainingBoundaryStage(mode) + "\n");
  process.stdout.write(c.dim("loop:     ") + runtimeConfig.trainingLoop + "   expand: " + runtimeConfig.trainingRuleExpansion + "   source: " + source + "\n");
  if (auto) process.stdout.write(c.dim("budget:   ") + "≤" + limits.maxRuns + " runs, ≤" + limits.maxMinutes + " min, saturation window " + runtimeConfig.trainingSaturationWindow + "\n");

  // ── dry-run: print the plan, harvest nothing ───────────────────────────────
  if (args["dry-run"]) {
    const target = selectCurriculumTarget(mem.all(), mode);
    const allKeys = stageKeysFromActive(getActiveStages(runtimeConfig)).filter(function(k) { return k !== "elicit"; });
    process.stdout.write("\n" + c.bold("DRY RUN") + " — no generation, no harvest.\n");
    process.stdout.write(c.dim("stages:   ") + truncateStagesForTraining(allKeys, mode).join(" → ") + "\n");
    process.stdout.write(c.dim("catalog:  ") + distinctSignatureCount(mem.all(), { domain: mode, model: model }) + " distinct " + mode + " lesson(s) for this model\n");
    process.stdout.write(c.dim("target:   ") + target.code + " — " + target.reason + "\n");
    process.stdout.write(c.dim("          ") + "→ " + target.archetype + "\n");
    return 0;
  }

  const log = function(s) { process.stdout.write(s + "\n"); };
  const counters = { llmCalls: 0 };
  const ctx = {
    pipeline: buildPipeline(), baseConfig: runtimeConfig, config: runtimeConfig,
    mem: mem, mode: mode, corpus: corpus, counters: counters, model: model, log: log,
    loop: runtimeConfig.trainingLoop, seedsPerSpec: runtimeConfig.trainingSeedsPerSpec,
  };

  // ── rewrite-only: sharpen the EXISTING catalog's rules with the model, no
  //    harvest (the Q2 path on its own — useful when you already have a corpus).
  if (args["rewrite-only"]) {
    log("\n" + c.bold("rewrite-only") + " — sharpening existing " + mode + " rules with the model (no harvest).");
    await rewriteRules(ctx);
    printSummary(mem, mode, model);
    return 0;
  }

  // ── manual: one sourced spec (or --spec) ───────────────────────────────────
  if (!auto) {
    let spec;
    if (args.spec) {
      const hit = corpus.find(function(s) { return s.id === args.spec; });
      spec = hit || { id: "custom", title: "custom", description: String(args.spec) };
    } else {
      spec = await sourceSpec(source, { corpus: corpus, config: runtimeConfig, domain: mode, mem: mem, counters: counters, idx: 0, recentTitles: [] });
    }
    log("\n" + c.bold("spec: ") + spec.id + (spec._target ? c.dim("  (target " + spec._target.code + ")") : ""));
    const gained = await safeRunSpec(ctx, spec);
    if (gained != null) log(c.green("✓ ") + "harvested " + gained + " new lesson(s) this run");
    if (runtimeConfig.trainingRuleExpansion === "model") await rewriteRules(ctx);
    printSummary(mem, mode, model);
    return 0;
  }

  // ── auto: source specs until saturation or budget ──────────────────────────
  const startMs = Date.now();
  const history = [];
  const recentTitles = [];
  let runs = 0;
  for (;;) {
    const b = budgetState({ runs: runs, startMs: startMs, llmCalls: counters.llmCalls }, limits);
    if (b.stop) { log("\n" + c.yellow("◼ ") + "budget reached: " + b.reason); break; }
    if (isSaturated(history, runtimeConfig.trainingSaturationWindow)) {
      log("\n" + c.green("◼ ") + "saturated: no new lessons in " + runtimeConfig.trainingSaturationWindow + " runs"); break;
    }
    const spec = await sourceSpec(source, { corpus: corpus, config: runtimeConfig, domain: mode, mem: mem, counters: counters, idx: runs, recentTitles: recentTitles });
    recentTitles.push(spec.title || spec.id);
    log("\n" + c.bold("run " + (runs + 1) + ": ") + spec.id + (spec._target ? c.dim("  (target " + spec._target.code + ")") : ""));
    const gained = await safeRunSpec(ctx, spec);
    runs++;
    if (gained != null) {
      log(c.dim("    +" + gained + " new, " + counters.llmCalls + " llm calls so far"));
      // Only successful passes feed saturation — a failed spec must not look
      // like "no new lessons" and falsely trip the plateau detector.
      history.push(distinctSignatureCount(mem.all(), { domain: mode }));
    }
  }
  if (runtimeConfig.trainingRuleExpansion === "model") await rewriteRules(ctx);
  log("\n" + c.green("✓ ") + "training complete — " + runs + " run(s), " + counters.llmCalls + " llm call(s)");
  printSummary(mem, mode, model);
  return 0;
}
