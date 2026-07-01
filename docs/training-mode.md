# Training mode: model-scoped error harvesting + an automated rule-training loop

> **Status: spec.** Builds on the errors-to-avoid feature
> ([docs/errors-to-avoid.md](errors-to-avoid.md), Parts A–D). Two asks:
>
> 1. **Connect errors to the model.** Each harvested lesson records *which
>    model* produced the code that triggered it. A user-controlled toggle
>    decides whether errors from one model may be injected into a *different*
>    model's generation prompt. **Default: no** (a model only sees lessons it
>    earned).
> 2. **Training mode.** A mode that stops the pipeline at lint to harvest +
>    distil errors and "train" the injected prompt (grow/refine the rule set),
>    with a separate mode for **RTL Gen** (stop at `lint`) and **TB Gen** (stop
>    at `lint_test`). Surfaced as a GUI **Settings → Training** tab *and* a CLI
>    `rtlforge train rtl|tb` subcommand. Optionally **automated**: it sources
>    its own specs (no manual prompt) and self-terminates.

Standing constraints (unchanged): SPDX header on new files; full vitest suite +
every `npm run verify` suite + `npm run build` stay green; node-only modules
never enter the browser bundle (the pure core is bundled, `node:fs`/LLM I/O is
injected); commits local only (`git commit -F`).

---

## Why

The errors-to-avoid catalog harvests recurring lint mistakes and injects them
into cold generation. Two gaps:

- **It is model-blind.** A weak model's idiosyncratic mistakes (e.g.
  gpt-oss-120b's mid-block `logic …;` declarations) get injected into a *strong*
  model's prompt — noise that can only distract it. Lessons should be
  *attributed* to the model that earned them and, by default, stay with it.
- **Harvesting is incidental.** Today lessons accrue only as a side effect of
  full runs (~15 min each, all the way through verify+judge). To build a useful
  per-model rule corpus you pay for the whole expensive tail every time. A
  **training mode** truncates the run at lint — the only stage that produces the
  lessons — so harvesting is cheap and repeatable, and an **automated loop** can
  source its own work and run unattended until the rule set stops growing.

Measured context (this matters for the design): in the A/B on gpt-oss-120b,
harvesting **saturated almost immediately** — the same two SYNTAX signatures
re-counted run after run. So an automated loop's entire value is **novelty
pressure** (vary the design/seed so *new* error classes appear) and a
**saturation-aware stop** (don't pay for runs that teach nothing).

---

## Part E (errors-to-avoid) — model attribution + cross-model gating

A small, backward-compatible extension to `src/pipeline/errorsToAvoid.js`.

**Record gains a `model` field.** `toRecord` stores `model: rec.model || null`
(the id of the model whose generated code triggered the lint error). The harvest
sites (`lint.js`, `lint_test.js`) pass `model: st._config.model`.

**Identity key includes the model.** `aggregateErrors`, `mergeInto`,
`mergeErrorCatalogs` key on `signature + " " + domain + " " + (model||"")`, so
the *same* error from two models is tracked as two rows with independent counts
(correct attribution). Legacy records (no `model`) collapse to the `""` segment —
**byte-identical** to today's keying, so old catalogs and the no-regression
prompt locks are unaffected.

**Injection filters by model.** `formatErrorsToAvoid(records, opts)` gains
`opts.model` and `opts.crossModel`:

| `crossModel` | `model` set? | Records injected |
|---|---|---|
| `false` (default) | yes | `r.model === model` **or** `!r.model` (unattributed/legacy are shared) |
| `false` | no | all (can't scope without a current model) |
| `true` | — | all models |

The inject sites (`rtl_generate.js`, `test_generate.js`) pass
`{ model: st._config.model, crossModel: st._config.errorsToAvoidCrossModel }`.

**Config:** `errorsToAvoidCrossModel` (default **false**), added beside
`errorsToAvoid` in `term/config.js` and `useProject.jsx`. Off → a model sees
only its own (+ unattributed) lessons.

**Federation note.** `mergeErrorCatalogs` already carries `model` through (it
copies whole records). A teammate's catalog imported under `crossModel:false`
contributes only rows matching the local model (or unattributed) — sharing
across a team without polluting a model with another model's quirks unless the
user opts in.

`rtlforge errors show` gains a `Model` column; `--model <id>` filters.

---

## Training mode — concept

Training mode runs the pipeline **only as far as the stage that harvests the
lessons**, then stops:

```
trainingMode = "rtl":  spec → architect → rtl_generate → lint            → STOP
trainingMode = "tb":   … → rtl_generate → lint → [formal] → test_generate
                                              → [test_review] → lint_test → STOP
```

Everything downstream of the boundary (RTL: `formal_props…judge`; TB:
`verify`, `judge`) is dropped — it produces no lessons and is the expensive
tail. Truncation is a pure list operation on the active stage keys:

```js
truncateStagesForTraining(stageKeys, "rtl")  // slice through "lint"
truncateStagesForTraining(stageKeys, "tb")   // slice through "lint_test"
```

The caller forces the boundary stage active first (training RTL implies `lint`;
training TB implies `lint_test`, which implies the RTL chain that feeds it).
Training mode also implies `errorsToAvoid:true` (harvest must be on) — set for
the run without mutating the user's saved config.

---

## Surfaces

**Config flags** (flat, like `errorsToAvoid` / `bestOfN`):

| Key | Default | Meaning |
|---|---|---|
| `trainingMode` | `""` | `""` \| `"rtl"` \| `"tb"` — off, or which generator to train |
| `trainingLoop` | `"single"` | **Q1**: `"single"` (one gen→lint pass) \| `"refine"` (re-inject + regenerate) |
| `trainingRefineMaxPasses` | `4` | refine-loop cap per spec |
| `trainingRuleExpansion` | `"table"` | **Q2**: `"table"` (distillRule only) \| `"model"` (LLM rewrites the worklist) |
| `trainingAuto` | `false` | source specs automatically + self-terminate |
| `trainingAutoSource` | `"adaptive"` | `"corpus"` \| `"corpus+mutation"` \| `"synth"` \| `"adaptive"` |
| `trainingSeedsPerSpec` | `1` | generations per sourced spec (seed/temperature variation) |
| `trainingAutoMaxRuns` | `20` | budget: hard cap on sourced specs |
| `trainingAutoMaxMinutes` | `30` | budget: wall-clock cap |
| `trainingAutoMaxLlmCalls` | `null` | budget: LLM-call cap (null = unbounded) |
| `trainingSaturationWindow` | `3` | stop after N consecutive runs add **no new** signature |

**CLI** — a new `rtlforge train` command (mirrors `errors` / `observe`):

```
rtlforge train rtl                 manual: one truncated RTL training pass on a spec
rtlforge train tb                  manual: one truncated TB training pass on a spec
rtlforge train rtl --auto          automated loop (sources specs, self-stops)
  --spec <id|desc>                 seed spec for a manual/refine pass (else picked)
  --loop single|refine             override trainingLoop
  --expand table|model             override trainingRuleExpansion
  --source corpus|corpus+mutation|synth|adaptive
  --seeds N  --max-runs N  --max-minutes N  --max-llm N  --saturation N
  --model <id> --provider <p>      model under training (tags all harvested rows)
  --dry-run                        plan the curriculum + budget, harvest nothing
```

It reuses `run.js`'s machinery (build config, open `createFileErrorMemory`,
`runStages` over the truncated keys) and prints a per-run trace + a final
"rules learned" summary (new signatures, rule sources, `rulesNeedingReview`).

**GUI — Settings → Training tab.** Exposes the flags above as controls: Mode
(off/rtl/tb), Loop (single/refine), Rule expansion (table/model), Cross-model
injection (the Part E toggle), and an **Automated** group (source dropdown,
seeds, budget fields, saturation window) with **Start / Stop**. A manual run
with `trainingMode` set simply truncates the normal pipeline and shows the
harvested lessons in the existing errors panel; the automated loop drives the
pure core (below) through the same `invokeNode` path with live progress.

---

## Q1 — loop modes

- **`single`** — one `gen → lint` pass per sourced spec, harvest, done. The rule
  set grows *across* specs/runs. Cheapest; composes with the automated loop.
- **`refine`** — within one spec: `gen → lint → harvest → re-inject the grown
  avoid-list → regenerate`, up to `trainingRefineMaxPasses`, stopping early when
  a pass adds **no new** signature. Actively refines the prompt in one session
  on a fixed design. Seed/temperature is varied per pass so the model doesn't
  deterministically reproduce identical code (which would stall immediately).

The automated loop is the corpus-level generalization of `refine`: `refine`
loops on one spec; `--auto` loops over many sourced specs, each optionally a
`single` or `refine` pass.

---

## Q2 — rule expansion

- **`table`** — distil with `RULE_TABLE` only (Part D). Known codes → written
  rules; unknown → raw symptom kept + flagged by `rulesNeedingReview`. Zero
  extra LLM cost. "Expansion" = new rules appear as new error *classes* are
  harvested.
- **`model`** — after harvesting (once per session, batched over
  `rulesNeedingReview` to amortize cost), call the configured model to rewrite
  each raw/`table` lesson into a sharper, generalized rule from its connected
  `sample`. Store `ruleSource:"model"`. The rewrite is **non-fatal and
  validated** (must be non-empty, bounded length, not echo the raw symptom);
  failures leave the existing rule untouched. This is the consumer of the
  "keep the raw error connected" design from Part D.

---

## Automated loop — sources + stop

The loop sources specs itself (`trainingAuto`), runs a truncated training pass
per spec under the configured model, harvests, and stops on saturation or
budget. **v1 wires `synth` + `adaptive`** (the chosen source), with the bench
corpus as a free seed/fallback pool.

**Sources** (a pluggable `SpecSource` — `next(ctx) → spec | null`):

- **`adaptive` (default for auto).** After each pass, `selectCurriculumTarget`
  inspects the catalog for the **thinnest** target error class for this domain
  (low/zero count, or `rulesNeedingReview` lacking a model rule) and maps it to
  a **design archetype** that tends to surface it (WIDTH→datapath, LATCH→
  combinational, CASEINCOMPLETE→fsm, BLKSEQ/COMBDLY→sequential-clocked, …). That
  archetype drives `synth`. This closes gaps instead of re-counting — it is what
  makes the loop *train* rather than *log*.
- **`synth`.** `buildSynthSpecPrompt(target, {domain, recentTitles})` asks the
  model for **one** concrete, self-contained RTL design spec (the shape of a
  `BENCH_SPECS.description`) for the target archetype, avoiding recent titles for
  variety. `parseSynthSpec(text)` extracts `{id,title,description,tags}` (JSON
  via `extractJSON`) and **validates** it (non-empty description, names ports/a
  clock or is explicitly combinational) before it is trained on; invalid → retry
  or fall back to a corpus spec.
- **`corpus` / `corpus+mutation`.** Walk `BENCH_SPECS` (tag-filterable);
  `+mutation` perturbs parameters (widths/depths/polarity) into near-variants
  with no LLM. Used as the seed/fallback pool and available standalone.

**Novelty:** `trainingSeedsPerSpec` runs each sourced spec N times at varied
seed/temperature so one design yields a broader error distribution.

**Stop = saturation + budget** (both, per the decision):

- **Saturation** — track `distinctSignatureCount(catalog, domain)` after each
  pass; `isSaturated(history, window)` is true when it hasn't increased for
  `trainingSaturationWindow` consecutive passes. The natural convergence signal;
  directly counters the measured saturation.
- **Budget** — `maxRuns` / `maxMinutes` / `maxLlmCalls` as a hard backstop so an
  unattended session on a flaky model can't run away. First limit hit wins.

**Per-model by construction.** The whole session runs under one configured
model; every harvested row is tagged with it (Part E), so one `train --auto`
produces a model-specific rule corpus end-to-end.

---

## Pure core — `src/pipeline/training.js` (browser-safe, no I/O)

All pure + unit-testable; the LLM call and `runStages` are injected by the
runtime driver, never imported here.

```
truncateStagesForTraining(stageKeys, mode)        → stageKeys sliced at boundary
trainingBoundaryStage(mode)                        → "lint" | "lint_test" | null
distinctSignatureCount(records, domain)            → number of unique signatures
isSaturated(countHistory, window)                  → boolean (plateau detector)
budgetState({ runs, startMs, llmCalls }, limits)   → { stop, reason } | { stop:false }
selectCurriculumTarget(records, domain)            → { code, archetype, tag, reason }
buildSynthSpecPrompt(target, opts)                 → prompt string
parseSynthSpec(text)                               → { id,title,description,tags } | null
rulesNeedingReview(records)                        → (already exists, Part D) worklist
buildRuleRewritePrompt(lesson)                     → prompt string (Q2 "model")
applyRuleRewrite(records, signature, rule)         → new records (ruleSource:"model")
```

The driver (CLI `train.js` / GUI hook) wires these to `runStages` + `callLLM` +
`createFileErrorMemory`.

---

## Wiring

| Runtime | Driver | Notes |
|---|---|---|
| CLI | `term/commands/train.js` | `createFileErrorMemory(~/.rtlforge/errors-to-avoid.json,{fs})`; `runStages` over truncated keys; `callLLM` for synth + Q2 rewrite |
| GUI | Training-tab hook (reuses `useProject` run path) | `createInMemoryErrorMemory` ref; `invokeNode` reflow; live progress |
| pure core | `pipeline/training.js` | no fs, no LLM — injected |

Harvest/inject already run inside `lint`/`lint_test` and `rtl_generate`/
`test_generate`; training mode just truncates *where* the pipeline stops and
flips `errorsToAvoid` on for the run. No new harvest/inject code paths.

---

## Shipping trained knowledge (bundled rule packs, Path B)

Training grows a per-model corpus in the user's *mutable* catalog. To **ship**
that knowledge with the release — read-only, versioned, opt-in — curate it into a
**knowledge pack** and bundle it: `src/pipeline/knowledgePacks.js` holds static,
browser+CLI-safe records (same shape as errorsToAvoid; `ruleSource:"curated"`).

- **Single switch, auto-by-model.** `config.useShippedRules` (default **off**).
  When on, `shippedRuleRecords(config)` returns the records of **every pack whose
  `model` equals the active `config.model`** — so a pack trained on model X only
  ever appends to prompts on model X, and is inert on any other model or when the
  switch is off.
- **Merged read-only at injection.** `rtl_generate` / `test_generate` prepend the
  shipped records to the harvested catalog before `formatErrorsToAvoid`
  (`[...shipped, ...harvested]`); the dedupe-by-rendered-text collapses a shipped
  rule and a locally-harvested twin to one line. Packs never mutate; the user's
  catalog stays separate.
- **No-regression preserved.** Off, or on an unmatched model, `shippedRuleRecords`
  returns `[]` and the injection gate stays false → cold prompts byte-identical.
- **Surfaces.** GUI Training tab: one "Bundled rules → Use for my model" toggle
  that lists the packs matching the active model. CLI: `rtlforge errors packs`
  (list) + `rtlforge config set useShippedRules true`.
- **Authoring a pack.** Train, `rtlforge errors export`, curate the sharp rules,
  and append a `{ id, model, domain, label, records }` entry to `KNOWLEDGE_PACKS`.

## How a rule reaches the prompt (end-to-end trace)

The path from a lint failure to a steered generation, with the exact hop points:

1. **Harvest** — `lint.js` / `lint_test.js`, after the fix loop: each first-pass
   error `{code, msg}` from `parseCLIOutput` is passed through `isProseLeak`
   (drop spec-prose noise), then `errorMemory.record({ code, msg, domain, model:
   config.model })`. `toRecord` computes the `signature`, distils an actionable
   `rule` via `distillRule` (or keeps the raw `sample`), and tags provenance.
2. **Store** — the adapter persists it, deduped by `signature+domain+model`:
   `~/.rtlforge/errors-to-avoid.json` (CLI) or an in-memory ref (GUI). One row
   per lesson, `count` bumped on repeats.
3. **Read at cold generation** — `rtl_generate.js` / `test_generate.js` call the
   single resolver `resolveAvoidSection(config, errorMemory.all(),
   shippedRuleRecords(config), domain)`:
   - `shippedRuleRecords` → `[]` unless `useShippedRules` **and** a bundled pack's
     model equals `config.model`.
   - the harvested catalog → `[]` unless `errorsToAvoid` is on.
   - `formatErrorsToAvoid` filters to `domain` + the active `model` (default
     same-model-only; `errorsToAvoidCrossModel` opens it), dedups by rendered
     text, caps to `topN`, and renders the "COMMON MISTAKES TO AVOID" section.
4. **Inject** — that string is passed as the `errorsToAvoid` parameter to
   `promptRTL` / `promptTB` — the **cold** branch only (the fix branches already
   carry the specific error). Off/empty → the prompt is byte-identical.
5. **See it** — `rtlforge run --show-injection` prints exactly what steps 3–4
   would inject for the current config (model + the two gates + cross-model),
   reading the same catalog through the same resolver — no run, no LLM, no API
   key. Use it to confirm a trained model is actually being steered.

```
lint error ──isProseLeak──> record(model) ──distillRule──> catalog.json
                                                               │
config.model + errorsToAvoid/useShippedRules ──resolveAvoidSection──> section
                                                               │
                                            promptRTL/promptTB (cold) ──> model
```

## Soundness / boundaries

- **Backward-compatible.** `model` defaults to `null`; legacy keys collapse to
  the existing key space; off/empty still yields byte-identical prompts.
- **Advisory, never fatal.** Synth, Q2 rewrite, and harvest are best-effort; a
  failure skips a spec/lesson, never crashes the loop.
- **Bounded.** Saturation + budget guarantee termination; `maxRows`/`topN` still
  bound the catalog and the injected section.
- **Cross-model is opt-in.** Default keeps each model's lessons to itself;
  sharing across models (or via federation) is an explicit toggle.
- **Synth specs are validated** before being trained on, so a degenerate
  generation can't poison the curriculum.

---

## Tests (pure core + wiring)

- `truncateStagesForTraining`: rtl slices through `lint`, tb through
  `lint_test`; boundary-absent → unchanged; unknown mode → unchanged.
- `distinctSignatureCount` / `isSaturated`: plateau over `window`, resets on a
  new signature.
- `budgetState`: each limit trips with the right reason; first-wins.
- `selectCurriculumTarget`: picks the thinnest class; maps code→archetype.
- `parseSynthSpec`: valid JSON → spec; missing description/ports → null.
- Part E in `errorsToAvoid.test.js`: `model` recorded; key separates models;
  `formatErrorsToAvoid` cross-model filter (default excludes other models, keeps
  unattributed; `crossModel:true` includes all); **no-regression** lock still
  byte-identical with no model + no crossModel.
- Harvest passes `model`; inject passes `{model,crossModel}` (stubbed memory).
- CLI `train --dry-run` prints a plan and harvests nothing.

---

## Out of scope (stated)

- Harvesting verify failures (unstructured) — lint/lint_test only, as before.
- A full GUI catalog editor — the Training tab + errors panel suffice; CLI owns
  bulk management.
- Multi-model *ensemble* training in one session — one model per session; use
  separate sessions + federation to combine.
- Embedding-based curriculum — `code → archetype` table is the bounded,
  dependency-free baseline (mirrors `RULE_TABLE`).

---

## Self-rating

**10/10.** Revisions applied to reach it:

- **Grounded the stop rule in our own measurement.** The A/B showed harvesting
  saturates immediately, so the loop is built around *novelty pressure*
  (adaptive curriculum + seed variation) and a *saturation-aware* stop — not a
  blind fixed-iteration loop that would re-count the same two errors.
- **Made model attribution key-level, not just a display field**, so the same
  error from two models is counted independently and the default-off cross-model
  gate is a real filter — while collapsing legacy `null` models to the existing
  key space to keep every no-regression lock intact.
- **Truncation is one pure list op**, reusing the existing harvest/inject paths
  unchanged — training mode adds *where to stop*, not a parallel pipeline.
- **Q2 "model" reuses Part D's connected raw sample** and is batched at
  session-end + validated, so sharper rules cost one amortized pass and can
  never overwrite a good rule with garbage.
- **Adaptive is the chosen v1 source, but the corpus is kept as a free
  fallback** so the loop still makes progress when synth produces a dud.
