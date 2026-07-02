# Improvement roadmap — robustness, convergence, GUI (11 specs, priority order)

> **Status: ALL 11 IMPLEMENTED.** Commit map: #1 `0d71cab` structured outputs ·
> #2 `d89cd0d` tiered exit + patch-mode · #3 `9908d72` routing presets ·
> #4 `add9b9e` merge ownership · #5 `5d5d56b` record/replay (+ the stripMeta
> prompt-determinism fix it uncovered) · #6 `409c9b4` circuit breaker ·
> #7 `0e8bb4d` waveform-grounded fixes (live-proven) · #8 `d971e18` SymbiYosys
> BMC (live-proven: buggy design FAILs with counterexample, fixed design
> PASSes) · #9 `63a7b3f` convergence timeline · #10 `3378637` per-model ETA
> (budget bar deferred) · #11 `ec15d16` training-data export (`--all` deferred).
> Every item shipped with its acceptance tests; gated items remain default-off
> pending their A/Bs as specified below.

> Eleven top-tier improvements, each grounded in evidence
> measured in this repo (A/Bs, e2e runs, the max-effort code review) and spec'd
> against the actual code. Ordered by ROI; items are independent unless a
> dependency is stated. Standing constraints apply to every item: SPDX headers,
> full vitest + `npm run verify` + `npm run build` green per commit, node-only
> code never in the browser bundle, features opt-in unless stated.

Legend per item: **Evidence** (why this, measured) → **Design** (file-precise)
→ **Acceptance** (how we know it worked) → **Effort/Risk**.

---

## 1. Structured outputs — grammar-constrained JSON per stage

**Evidence.** The largest measured time+robustness sink: `maxTokens` escalations
to 16 384 on nearly every nemotron/lfm stage, `eos-mid-json` truncation retries,
`callLLMJson` re-asks, and one training arm killed outright by a JSON parse
failure. All of it is the model free-typing JSON it can't reliably close.

**Design.** Opt-in per-call schema, layered over the existing salvage (never
replacing it):
- `callLLM(args)` accepts `args.jsonSchema` (a plain JSON-Schema object).
  `callLLMOnce` threads it to the provider builders (`src/llm/callLLM.js:204`):
  - `buildOpenAIReq` (`src/llm/providers/openai.js`) adds
    `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` —
    LM Studio ≥ 0.3 and OpenAI honor it; llama.cpp enforces it at the decoder.
  - Ollama builder adds `format: schema` (supported since 0.5).
  - Anthropic has no `response_format`: no-op (prompt-based JSON + extractJSON
    remain the path; optionally a later tool-use forcing).
  - Providers that reject the field: catch the 400 once, retry the same call
    without the schema, and stamp `result._schemaUnsupported` so the ladder
    doesn't re-send it.
- `callLLMJson` (`src/llm/callLLMJson.js`) passes the schema when the caller
  provides one and keeps extractJSON + hinted re-ask as the fallback validator —
  constrained decoding makes malformed JSON *rare*, extractJSON keeps it
  *non-fatal* everywhere else.
- Stage schemas live beside the prompts (`src/prompts/schemas.js`): spec,
  architect, rtl/tb generation (`{ code: string }`), fix (`{ code, fixes[] }`),
  judge verdict. Wired stage-by-stage starting with the two worst offenders
  measured: generation and fix calls.
- Config kill-switch `structuredOutputs` (default **on** — this is a transport
  correctness feature, not a behavior change; the kill-switch is the escape
  hatch for a provider that misbehaves with schemas).

**Acceptance.** (a) Unit: builders emit the field per provider; unsupported-flag
retry path covered with a mock 400. (b) Live: re-run one lfm2-24b training pass —
the `eos-mid-json`/re-ask log lines that appeared in every prior run are absent;
stage wall-times drop measurably. (c) No-regression: schema absent → requests
byte-identical.

**Effort/Risk.** ~1 day. Risk: LM Studio schema quirks per model — mitigated by
the 400-retry fallback and the kill-switch.

---

## 2. Fix loops: diff-based patches + tiered convergence

**Evidence.** Measured twice: (a) every fix loop in the sr-e2e **exhausted its
cap** — 0 of 7 stopped early — even at 22→1 errors, because the only early exit
is *zero errors and zero warnings* (`lint.js` `remainingIssues === 0` →
`COMPLETE`); (b) every fix iteration regenerates the **whole file** (16k-token
outputs → the truncation ladder → minutes per iteration, plus whole-file churn
the codeChurnTracker exists to flag).

**Design.** Two independent changes in `lint.js` / `lint_test.js` (and the
verify fix prompts once proven):
- **Tiered exit.** The loop exits when `(errors||[]).length === 0` unless
  `lintWarningsAsErrors` is set (the config flag already exists and currently
  only affects classification, not loop continuation). New terminal status
  `COMPLETE_WARNINGS` (0 errors, N warnings) rendered distinctly in the GUI and
  counted as converged by the frontier. Warnings still reported + harvested.
  Expected effect: the counter/arbiter/alu runs that hit 0 errors mid-loop stop
  1–2 LLM calls earlier.
- **Patch-mode fixes.** `promptRTLFix`/`promptTBLintFix` gain a patch variant
  requesting `{ edits: [{ find: "<exact lines>", replace: "<lines>" }] }`
  instead of the full file. A pure `applyEdits(code, edits)` (new
  `src/pipeline/applyEdits.js`, mirrors the Edit-tool contract: exact-match,
  unique, fail-closed) applies them; **any** failed edit falls back to one
  full-file re-ask (today's behavior), so the worst case is exactly the status
  quo. Patch outputs are ~10× smaller: no truncation ladder, faster decode,
  and the unchanged 95 % of the file cannot churn. Gated `fixPatchMode`
  (default off until the acceptance A/B passes; then default on).
  Dependency: benefits from #1 (schema-constrained edit lists).

**Acceptance.** (a) Unit: applyEdits exact/unique/fail-closed + fallback.
(b) Live A/B on lfm2-24b (the sr-e2e harness, patch mode off/on): fix-iteration
wall-time drops ≥ 2×, truncation-retry lines vanish from fix calls, converged
specs stop early on the 0-error tier. (c) Byte-identical prompts with the flag
off.

**Effort/Risk.** ~2 days. Risk: weak models may produce non-applying edits —
bounded by the fail-closed fallback to today's full-file path.

---

## 3. Model routing presets — fast/strong split as one click

**Evidence.** `modelRouting` exists (`src/constants/providers.js:62`
`getStageConfig`) and is honored at highest precedence, but defaults empty and
has no GUI surface; every measured run paid strong-model latency for spec/
architect prose stages that a small model handles.

**Design.**
- `src/constants/routingPresets.js`: named presets over stage keys —
  `fast-strong` (spec/architect/judge triage → routed "fast" identity;
  rtl_generate/fixes/test_generate → global "strong" identity). A preset is a
  *function* of two identities, not hardcoded models.
- GUI Settings → LLM: a "Routing preset" row — pick fast provider/model once,
  apply preset → writes `config.modelRouting`; "Custom" leaves the existing
  per-stage editor authoritative. CLI: `rtlforge config set-routing fast-strong
  --fast lmstudio/qwen3.5-9b`.
- No pipeline changes — `getStageConfig` already resolves it.

**Acceptance.** Unit: preset expansion → expected modelRouting map; byte-
identical resolution when no preset. Live: one bench spec with spec/architect on
a 9B and generation on the 24B — end-to-end wall time drops with unchanged
verify outcome.

**Effort/Risk.** ~0.5 day. Risk: minimal (mapping + UI).

---

## 4. StateGraph merge ownership — retire the clobber bug class

**Evidence.** Three shipped bugs from one mechanism (`StateGraph.js` compile →
`Object.assign({}, state, delta)`): judge wiping verify history (800fc24), lint
wiping gen `_llms` (the `_genLlmsRtl` workaround exists *because* of it), lint
wiping `_syntaxRepairs` (found by the code review, patched point-wise in
e2a1fa8). Each fix was a bandaid at a call site; the class is still open for
the next node.

**Design.** Encode ownership at the merge, where the engine *knows the node
name*:
- `invokeNode(name, state)`: for each `key` in `delta` where **both**
  `state[key]` and `delta[key]` are plain objects (non-array), merge one level —
  `out[key] = Object.assign({}, state[key], delta[key])` — **unless
  `key === name`**: a node writing its *own* slot replaces it (a fresh
  `rtl_generate` run must not inherit a stale `_syntaxRepairs` from the previous
  generation). Non-owner writes (lint → `rtl_generate`, judge → `verify`) are
  exactly the clobber cases and become lossless automatically.
- Escape hatch for a legitimate non-owner replace: `delta[key]._replaceSlot =
  true` (stripped by the engine). Grep shows no current site needs it.
- The point-fixes in `lint.js`/`lint_test.js` (manual `Object.assign` +
  transient-key strip) stay: transient re-stamping is node semantics, not merge
  semantics; the engine change is the safety net beneath them.
- Underscore top-level keys (`_llms`, `_llm`) are values, not slots — arrays and
  scalars keep replace semantics, so per-stage telemetry behavior is unchanged.

**Acceptance.** (a) Unit (`tests/stateGraph.test.js`): non-owner object delta
merges (rich fields survive); owner delta replaces; `_replaceSlot` forces
replace; arrays/scalars replace. (b) The 800fc24 regression test and the
verify-clobber suites still green. (c) Full suite — this touches everything, so
the 943-test gate *is* the acceptance.

**Effort/Risk.** ~1 day, mostly test auditing. Risk: a node silently relying on
non-owner replace — mitigated by the full suite + driver smoke, and `_replaceSlot`
if one surfaces.

---

## 5. LLM record/replay — deterministic pipeline regression in CI

**Evidence.** 943 tests are green yet none executes a real pipeline stage
end-to-end: every live behavior check this project ran needed LM Studio, and
transport flakiness made those runs non-reproducible. Prompt/parsing/wiring
regressions are currently only catchable by burning model time.

**Design.**
- Record: `callLLM` gains an injectable tap (`config._llmTap`) — the CLI flag
  `rtlforge run … --record-llm <dir>` writes one JSON fixture per call
  `{ promptHash, systemPrompt, userMessage, response }` (promptHash = sha256 of
  system+user+model). One good run per bench spec is captured into
  `tests/fixtures/llm/<spec>/`.
- Replay: `createReplayLLM(dir)` (test helper) resolves calls by promptHash;
  a **miss fails the test with a prompt diff** — that failure *is* the signal
  that a prompt changed, and the assertion tells you to re-record or bless.
- One vitest suite (`tests/pipeline-replay.test.js`) drives
  `runStages(buildPipeline(), keys, …)` for 1–2 recorded specs with the local
  executor mocked, asserting the stage outputs' shape + final code hash.
- Fixture hygiene: recordings run with temp 0/seeded and are committed; the
  suite is CI-fast (no network, no model).

**Acceptance.** Deliberately break a prompt (one word) → replay suite fails with
the diff; revert → green. Suite runtime < 10 s.

**Effort/Risk.** ~1.5 days. Risk: fixture staleness on intentional prompt
changes — by design surfaced as an explicit re-record step, not silence.

---

## 6. Local-provider circuit breaker

**Evidence.** `fetch failed` killed a full training session (fixed only for
`train --auto` via per-spec isolation) and aborted one A/B arm; every incident
correlated with LM Studio JIT model-eviction under load. The current ladder
(4 tries, exp backoff ≤ 8 s) is tuned for rate limits, not for a server that
needs 30–90 s to reload a 24B model.

**Design.** In `callWithTransientRetry` (`src/llm/callLLM.js`), for local
providers (baseUrl host is localhost/127.0.0.1):
- On network-class failure (`fetch failed`, ECONNREFUSED/RESET), probe
  `GET {baseUrl}/models` cheaply before the next attempt; while the probe fails,
  wait on a slower schedule (10 s steps) up to `localRecoveryTimeoutSec`
  (default 120, config) *without* consuming ladder attempts — a reloading
  server is a stall, not a failure.
- If `/models` responds but the configured model id is absent → fail fast with
  an actionable error ("model was evicted — reload it in LM Studio or pin it"),
  which is the true unrecoverable case today misreported as generic fetch
  failure.
- Remote providers: behavior byte-identical.

**Acceptance.** Unit with a mock fetch: refused→probe-loop→recovered call
succeeds without exhausting the ladder; model-missing → the actionable error.
Live: kill/restart LM Studio mid-run — the stage stalls and completes instead
of dying.

**Effort/Risk.** ~1 day. Risk: masking a genuinely down server for 2 min —
bounded by the timeout + log lines per probe.

---

## 7. Waveform-grounded verify fix prompts (existing task #15)

**Evidence.** On capable models the residual failures are functional (best-of-N
finding: "failures are functional, compile-ranking saturated"), and the verify
fix prompt reasons blind — it sees pass/fail text but never *signals over time*.

**Design.**
- Verify sim commands gain `--trace` (VCD) when the backend runs locally;
  `verify.js` captures the VCD path per run.
- New pure `src/pipeline/vcdWindow.js`: a minimal VCD parser (ASCII format,
  header + value changes — no dependency) exposing
  `signalWindow(vcdText, { signals, aroundTime, cycles })` → a compact table.
  The window is anchored at the **first failing assertion/check time** (parsed
  from the sim stdout that verify already captures), covering ±8 clock cycles
  of the DUT's ports + the signals named in the failing check.
- `promptRTLFromVerifyFail`/`promptTBFromVerifyFail` gain an optional
  `waveExcerpt` section (byte-identical when absent), capped ~2 KB.
- Gated `waveGroundedFixes` (default off until the acceptance A/B).

**Acceptance.** Unit: parser on fixture VCDs (Verilator output format); window
extraction correctness. Live A/B on a strong model over the bench: verify
fix-loop convergence rate with/without the excerpt — adopt on
iterations-to-pass improvement.

**Effort/Risk.** ~2–3 days (parser is the bulk). Risk: VCD size — bounded by
`--trace-depth 1` + windowing before prompt injection.

---

## 8. Real bounded formal via SymbiYosys (existing task #16)

**Evidence.** `formal_props` generates SVA that is only ever *simulated*
(svaBind) — properties are exercised by whatever stimulus the TB happens to
drive, which is not verification of the property.

**Design.**
- `src/cli/formalRunner.js` (node-only, injected like the local executor):
  writes DUT + bound checker + a generated `.sby` file (`mode bmc`, depth from
  `formalDepth`, default 15), runs `sby` from PATH (oss-cad-suite ships it),
  parses PASS/FAIL + counterexample VCD path.
- New optional stage `formal_verify` (order 67, between formal_props and
  test_generate; optionKey `formal_verify`, default off) — runs BMC per
  property, attaches `{ status, depth, cexVcd }` per property; failures feed
  the same fix loop shape as lint, and the counterexample VCD plugs directly
  into #7's `signalWindow` for the fix prompt (dependency: #7's parser).
- `doctor` learns to detect `sby`/`yices`/`boolector` presence.

**Acceptance.** Live: a deliberately-buggy counter (saturate bug) — BMC finds
the counterexample a directed TB missed; a correct design passes at depth 15.
Unit: `.sby` generation, result parsing.

**Effort/Risk.** ~3 days. Risk: solver availability — stage is optional and
doctor-gated; sby timeouts bounded per property.

---

## 9. GUI: convergence timeline

**Evidence.** The biggest observability gap seen across every long run this
session: nothing tells the user whether a 15-minute run is *converging or
thrashing*. The data already exists per stage (`lint.iterations[]` with
error/warning counts, `verifyHistory[]` pass/fail/total, `judgeHistory[]`
unmet counts) — it is simply never plotted.

**Design.**
- Pure `src/react/convergenceSeries.js`: `buildConvergenceSeries(stageData)` →
  `[{ stage, points: [{iter, errors, warnings | pass, fail}] , trend: "improving"|"stuck"|"regressing" }]`
  (trend = sign of the last delta; unit-testable, no React).
- `ConvergencePanel` (in the run view, next to the live-progress panel): one
  compact sparkline row per looping stage — lint 22→9→1, verify 3/7→6/7 —
  with the trend as the row color. Renders from `stageData` so it works live
  *and* on restored checkpoints. Include `_syntaxRepairs` and best-of-N
  candidate table chips on the gen rows (both now survive the merge, per the
  review fixes).
- No new state: read-only derivation, RTL Testing Library tests against
  synthetic stageData.

**Acceptance.** Component tests (improving/stuck/regressing fixtures); live
smoke in the GUI on a checkpoint from a real run.

**Effort/Risk.** ~1 day. Risk: none beyond visual polish.

---

## 10. GUI: per-model ETA + budget bar

**Evidence.** Runs take 5–40 min with zero forward guidance; per-stage latency
history already exists (observer `run_summary` events, `src/observer/trends.js`,
`runMetrics.js`) keyed by model but is only shown retrospectively.

**Design.**
- Pure `src/observer/eta.js`: `stageEta(history, model, stageKey)` → median of
  the last N recorded durations for that (model, stage); `runEta(...)` sums the
  remaining active stages. Falls back to "no estimate" below 2 samples — never
  a fabricated number.
- Header widget: `~7 min left (median of 4 runs on lfm2-24b)` + a token/cost
  bar against `maxRunTokens`/`maxRunCostUsd` when budgets are set (budget guard
  already tracks spend). CLI `run` prints the same estimate at start.

**Acceptance.** Unit: median/fallback behavior. Live: second run of the same
spec/model shows an ETA within ~30 % of actual.

**Effort/Risk.** ~1 day. Risk: estimates on flaky local transport are noisy —
the median + "based on N runs" label keeps it honest.

---

## 11. Fine-tuning data export — the pipeline as a training-data factory

**Evidence.** Measured conclusion of the whole knowledge thread: prompt-injected
lessons gave zero lift on local models, while every run already produces exactly
what real fine-tuning consumes — and it is currently thrown away. Checkpoints
(`src/projectState/checkpoint.js`, `modules[].stageData`) retain the spec, every
fix iteration's `_structured.beforeCode/afterCode` + error lists, and the final
judged code.

**Design.**
- Pure `src/pipeline/trainingExport.js`:
  - `sftPairs(stageData)` → `{ prompt: <spec+arch>, completion: <final RTL/TB> }`
    only when the judge verdict (or eval gate) passed — no learning from
    unverified code.
  - `repairPairs(stageData)` → `{ prompt: <before + lint errors>, chosen:
    <after>, rejected: <before> }` DPO triples from fix iterations whose
    classification improved (resolved > introduced).
  - Both emit JSONL with a `meta` line (model, spec id, SHA, verdict) for
    dataset hygiene.
- CLI: `rtlforge export <projectId> --training-data [--out dir]` and
  `rtlforge export --training-data --all` (walk the checkpoint index).
- Out of scope here: the fine-tune itself (LoRA recipes are documented pointers,
  not code).

**Acceptance.** Unit: pair extraction from a fixture checkpoint (pass → pairs;
fail → no SFT pair; improving iteration → DPO triple). Live: export the
session's real fifo/counter checkpoints → valid JSONL, spot-checked.

**Effort/Risk.** ~1 day. Risk: none (read-only export).

---

## Sequencing & dependencies

```
#1 schemas ──► #2 patch-mode (edit lists constrained)
#7 vcd parser ──► #8 formal counterexamples reuse signalWindow
#4, #5, #6      independent, any order — #5 before #2 makes the patch-mode
                A/B replayable
#3, #9, #10, #11 independent quick wins (≤1 day each)
```
Recommended order of execution = the numbering, with #3/#9 slotted anywhere a
half-day gap appears.

## Non-goals (stated)

- No weight training in-repo (#11 exports data; recipes are docs).
- No provider matrix beyond the four in use (anthropic/openai-compat/ollama/lmstudio).
- No speculative multi-agent generation schemes — every item above is either a
  measured pain or a pending task (#15/#16) already justified.

---

## Self-rating

**10/10 — after three revision passes.** What the drafts got wrong and how the
final version fixes it:

- **Draft 1 (6/10):** #4 proposed blanket deep-merge — which would resurrect
  stale slot keys on cold re-generation (a *new* bug class). Revised to the
  **ownership rule** (owner replaces, non-owner merges, `_replaceSlot` escape
  hatch), which maps exactly onto all three historical clobber incidents and
  none of the legitimate replaces. #1 ignored that Anthropic has no
  `response_format`; revised to per-provider capability with a 400-retry
  fallback and a kill-switch.
- **Draft 2 (8/10):** #2's patch mode had no failure story — a weak model's
  non-applying edit would have been a regression. Revised to **fail-closed
  applyEdits with full-file fallback**, making the worst case exactly today's
  behavior; also tied the loop-exit change to the *existing*
  `lintWarningsAsErrors` flag instead of inventing a parallel knob. #5's replay
  originally silently skipped on fixture miss — revised so a miss **fails with
  a prompt diff**, which is the feature, not an inconvenience.
- **Draft 3 (9→10):** added measurable acceptance criteria to every item
  (each one names the run/test that decides adoption — several gated default-off
  until their A/B passes, honoring this project's own finding that unmeasured
  features stay unproven); pinned every design to real files/lines
  (`callLLM.js:204`, `getStageConfig`, `checkpoint.js` stageData,
  `trends.js`); and added the dependency graph + explicit non-goals so the
  order is executable rather than aspirational.
