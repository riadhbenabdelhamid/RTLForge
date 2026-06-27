<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Riadh Ben Abdelhamid -->

# Best-of-N generation with deterministic selection (#17)

> Status: **implemented** — `src/pipeline/bestOfN.js` (pure core), wired into
> `rtl_generate` and `test_generate`, durable cost keys read by `bench/scorer.mjs`.

## Problem

Cold RTL/TB generation is a single dice-roll. The pipeline already has a strong
*objective* signal available before any LLM fix loop runs — does the candidate
**compile under Verilator?** — but it throws away the obvious lever: draw a few
candidates and keep the one that compiles cleanest. A bad first draft costs a
full lint→fix→verify→judge convergence cycle to recover from (or never
recovers); a one-shot selection in front of it is cheap by comparison.

This was built once before and lost to an env-reset that orphaned its commits
(see memory `env-reset-orphans-commits`). This doc specs the rebuild from the
current tree, not the lost version. The earlier measurement findings
(memory `best-of-n-findings`) are folded into the design below.

## Two failure modes the first build hit (and this design fixes by construction)

1. **No diversity under greedy decoding.** N draws of the same prompt at
   `temperature 0` are byte-identical on every backend — best-of-N silently
   collapses to best-of-1. **Fix:** candidates 1..N−1 are drawn at an
   *exploration temperature* (`bestOfNTemp`, default `0.7`) with a per-candidate
   seed offset on seeded backends. Candidate 0 keeps the stage's normal
   (greedy/low-temp) config so the deterministic baseline is **always in the
   pool** — selection can therefore never do worse than best-of-1.

2. **Generation cost went uncounted.** Six downstream stages (`lint`,
   `lint_test`, `verify`, `judge`, `rtl_review`, `test_review`) return a fresh
   `rtl_generate`/`test_generate` delta carrying only `{ code }`. The StateGraph
   merges deltas with `Object.assign`, so `finalState.rtl_generate._llms` is
   **clobbered** — the generation calls vanish from any consumer that reads the
   merged final state (the bench scorer does). Chasing every rewrite site was
   whack-a-mole. **Fix:** the generate nodes also publish their full ledger to
   durable top-level keys `_genLlmsRtl` / `_genLlmsTb` that **nothing else
   writes**, so they survive every merge. The scorer reads generation cost from
   there, falling back to the per-stage `_llms` for back-compat.

## The selector — deterministic, objective, never confounded

A candidate is summarised from its Verilator lint as
`{ compiles, errors, warnings }` and ranked by an **ordered** criteria list,
first discriminating criterion wins, ties broken by **lower candidate index**
(i.e. the greedy baseline / earliest draw):

```
RANK_CRITERIA = ["compiles", "errors", "warnings"]
```

- **RTL** lints the module **alone** (`verilator --lint-only -Wall {RTL}`):
  `compiles` means *elaborates*.
- **TB** lints the testbench **together with the RTL** (`tbLintCmd`, both files
  provided): `compiles` means *integrates* with the DUT.

Deliberately **not** ranked on simulation pass/fail. A good testbench *should*
fail against buggy RTL, so sim outcome is a confounded signal for picking the
best TB; and ranking RTL on a TB that may itself be wrong is circular. Compile
cleanliness is the one signal that is monotonically "more correct = better" for
both artifacts independently.

## Gating — best-of-N requires the CLI selector

There is no way to rank candidates without Verilator, so best-of-N is **active
only when a backend is configured** (`config.backendUrl`, including the embedded
executor `#23`) **and** `bestOfN >= 2`. Otherwise the node takes the existing
single-shot path, byte-for-byte unchanged. Drawing N candidates we cannot rank
would be pure waste, so we don't.

Scope: **cold generation only.** Informed-fix / reflow branches
(`_fixContext`) stay single-shot — they already carry targeted failure context,
and N-sampling a point fix is wasteful and muddies the trace.

## Config knobs

Added to `DEFAULT_CONFIG` (`src/term/config.js`) and the GUI defaults
(`src/react/useProject.jsx`):

| key           | default | meaning                                                    |
|---------------|---------|------------------------------------------------------------|
| `bestOfN`     | `1`     | candidates per cold generation; `1` = feature off. Clamped to `[1, 8]`. |
| `bestOfNTemp` | `0.7`   | exploration temperature for candidates 1..N−1. Clamped to `[0, 2]`.     |

Env override: `RTLFORGE_BEST_OF_N`. These are **global pipeline knobs** read off
`st._config` directly (like `maxLintIters`), not per-stage sampling settings.

## Pure core: `src/pipeline/bestOfN.js`

- `resolveBestOfN(config)` → integer in `[1, 8]` (default 1).
- `resolveBestOfNTemp(config)` → number in `[0, 2]` (default 0.7).
- `diversityConfig(baseCfg, i, temp)` → candidate config. `i === 0` returns
  `baseCfg` unchanged (greedy baseline); `i >= 1` overrides `temperature = temp`
  and, when `baseCfg.seed != null`, sets `seed = baseCfg.seed + i`.
- `summarizeLint({ exitCode, errors, warnings })` → `{ compiles, errors, warnings }`
  (counts), pure — the node pre-parses CLI output into arrays.
- `rankCandidates(candidates, criteria = RANK_CRITERIA)` → `{ winner, ranked }`.
  Candidates are `{ index, lint: { compiles, errors, warnings } | null }`; a
  `null` lint (candidate couldn't be evaluated) ranks worst on every axis.
- `runBestOfN({ n, makeConfig, generate, lintCode, criteria, onCandidate, shouldContinue })`
  — injected-adapter orchestrator (mirrors `triageMemory`/`errorsToAvoid`):
  loops `generate(cfg, i)` → `lintCode(code)`, builds candidate records, returns
  `{ winner, ranked, candidates }`. The node supplies `generate` (wraps
  `callLLMJson`), `lintCode` (wraps `runCli` + `parseCLIOutput`), optional
  `onCandidate(record)` for logging, and optional `shouldContinue(i)` (the budget
  gate; `false` stops drawing further candidates). Candidate-0 generation errors
  propagate; later candidates' errors are swallowed (that draw is skipped). If
  every candidate fails to generate, the last error is rethrown. Pure of LLM and
  CLI, so it is fully unit-testable with mocks.

## Node integration

In the cold-gen branch of `rtl_generate` / `test_generate`, after the prompt +
skills + stage config are assembled:

```
N = cold-gen ? resolveBestOfN(config) : 1
if (N >= 2 && config.backendUrl) → best-of-N path
else                             → existing single callLLMJson (unchanged)
```

Best-of-N path:
- Reuse the assembled prompt `p` (so `errorsToAvoid`, skills and architect
  context are identical across candidates); per candidate set `p.config =
  diversityConfig(_sc, i, temp)`.
- Lint each candidate via `runCli` (RTL: `lintCmd`, module file; TB: `tbLintCmd`,
  RTL+TB files). A backend **`_error`** under strict CLI throws `CliBackendError`
  exactly as the lint nodes do (a truly unreachable backend fails loudly); a
  candidate that merely fails to elaborate is a normal `exitCode != 0` result and
  ranks low, not an error.
- **Per-candidate generation resilience.** If `generate` throws for a candidate
  `i >= 1` (parse failure after retries, transient transport), that candidate is
  logged and skipped rather than failing the whole stage. Candidate 0 is the
  baseline — if it throws, the error propagates (the stage genuinely could not
  produce RTL). If every candidate is skipped, the last error is rethrown.
- **Run-budget guard.** When `st._budget.enabled`, the loop checks the budget
  before each *additional* candidate (`i >= 1`) and stops early, ranking the
  candidates drawn so far. Best-of-N can therefore never run a stage past its
  cost ceiling — at worst it spends one candidate (the baseline).
- `rankCandidates` → winner. When **no** candidate could be linted (all `null`,
  e.g. strict CLI off and the backend flaked on every draw), the winner is
  candidate 0 by the index tiebreak — identical to single-shot.
- Set `{rtl,test}_generate.code` to the winner.
- Ledger **all** candidates' `_llms` into the stage result `_llms` (so per-stage
  cost is right) **and** the durable `_genLlmsRtl`/`_genLlmsTb` (so merged-state
  cost is right).
- Attach `_bestOfN = { n, winner, ranking: [{ index, compiles, errors, warnings }] }`
  to the stage result for the trace/UI.

**Durable key is cold-generation cost, by design.** Both cold paths (single-shot
and best-of-N) publish `_genLlmsRtl`/`_genLlmsTb`; the **informed-fix branches do
not**. `rtl_generate` re-runs as the triage entry of reflow chains, so if fix
calls also wrote the key they would overwrite the cold-gen ledger and undercount
generation in the merged state. Scoping the key to cold gen keeps it a stable
"what did first-draft generation cost" measure; per-run fix cost is still on each
stage's own `stageData._llms`.

## Bench

`bench/scorer.mjs` reads generation cost for `rtl_generate`/`test_generate` from
`finalState._genLlmsRtl` / `_genLlmsTb` when present, else the per-stage
`_llms` (back-compat). Under best-of-4 the rtl_generate/test_generate `calls`
should show 4 each.

## Honest limits

- The selector only discriminates when candidates **differ on compile
  cleanliness**. On a weak local model where every draft elaborates (or every
  draft fails identically), all candidates tie and the greedy baseline wins by
  the index tiebreak — best-of-N is then a no-op that still cost N draws.
  Definitive lift needs a stronger model (memory `bench-local-llm-reality`);
  the bench plan to run is `bench/plans/best-of-n.json` on such a model.
- Cost scales linearly with N (N generations + N lints per cold stage). Off by
  default for that reason.

## Tests

- `bestOfN.js` pure: `rankCandidates` ordering (compiles dominates errors
  dominates warnings, index tiebreak, null-lint ranks worst); `diversityConfig`
  (candidate 0 untouched, i≥1 gets temp + seed offset, no seed → no seed
  injected); `resolveBestOfN`/`resolveBestOfNTemp` clamping; `summarizeLint`;
  `runBestOfN` with mocked generate/lint picks the cleanest.
- Node: with mocked `callLLMJson` + `runCli`, best-of-3 selects the candidate
  that compiles cleanest and ledgers all 3 calls into `_genLlmsRtl`; `N=1` and
  "no backend" take the single-shot path (one call, unchanged code).
