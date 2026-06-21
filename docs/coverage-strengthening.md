# Coverage-driven testbench strengthening (task #19)

> **Status: implemented** — core (`249d9b3`) + verify.js wiring (`2a5ef66`).
> Pure helpers + driver are unit-tested (`tests/coverageStrengthen.test.js`,
> 15); the gate is wired after the mutation gate in `verify.js`, opt-in via
> `config.coverageStrengthening`. Full vitest suite + every `npm run verify`
> suite + the browser build are green.

> Specced against the **current tree**. Note: the acceptance-ledger arc
> (Phases 1–6, the `unproven`→`strong` strength signal) is **not present in
> this repository** — so #19 is framed on what actually exists: the Verilator
> coverage parser, the existing coverage eval criteria, `coversParser`
> requirement attribution, and the TB-regeneration machinery. If that ledger
> ever lands, its `unproven` requirements are exactly this loop's targets (a
> forward tie-in, **not** a dependency).

## Problem

A testbench can pass every test and still leave the RTL under-exercised: low
line/branch/toggle coverage, and spec requirements with no covering test. The
machinery to *measure* this already exists —

- `parseCoverageDat(text)` (`runCli.js:442`) → `{ line, branch, toggle, fsm,
  expr }` percentages, computed in `judge.js` from Verilator's
  `logs/coverage.dat`;
- the `coverageMeasurer(kind)` **eval criteria** (`criteria.js:303`) already
  gate on those percentages;
- `coversParser.parseCoversAnnotations(tb)` maps TB tasks → `REQ-…` via
  `// covers:` annotations, so an uncovered requirement is detectable.

…but nothing **acts** on a coverage gap. A weak-but-passing TB is a dead end:
the gate reports "line coverage 61%" and stops. `#19` closes that loop — it
feeds the gaps back into TB generation to **add** targeted tests, then keeps the
result only if it provably helped.

Standing constraints (unchanged): SPDX header on new files; full vitest suite +
every `npm run verify` suite + `npm run build` stay green; commits local only
(`git commit -F`), never pushed.

---

## Design — mirror the mutation gate

`runMutationGate` (`mutation.js`) is the template: opt-in, real-backend-only,
runs **after** a verify PASS, pure-orchestration with `runCli`/`callLLM`
injected, returns a report. `#19` adds a parallel `runCoverageStrengthening`.

### Part A — gap detection (pure)

1. **`parseCoverageBuckets(text)`** (new, beside `parseCoverageDat` in
   `runCli.js`): `parseCoverageDat` already scans the `C '<bucket>' <count>`
   records; this exposes the **count == 0** ones →
   `{ uncovered: [{ file, line, kind }], byKind: { kind: { hit, total } } }`,
   capped (e.g. 40 points) so the prompt stays bounded. Pure.

2. **`findCoverageGaps({ cov, buckets, thresholds, requirements, coversMap })`**
   (new pure module `src/pipeline/coverageStrengthen.js`) →
   ```
   { weakKinds:      [{ kind, measured, threshold }],   // measured < threshold
     uncoveredPoints:[{ file, line, kind }],            // from buckets, capped
     uncoveredReqs:  [{ id, desc, pri }] }              // spec reqs w/ no covering task
   ```
   - `thresholds` come from the **enabled coverage eval criteria** (so the loop
     only chases what the user actually gates on); when strengthening is on but
     no coverage criterion is enabled, fall back to a single default (e.g. 80).
   - `uncoveredReqs` = `spec.requirements` (`{id, desc, pri}`) whose id has **no**
     task with that `req` in `coversMap` — Must first, then Should.

### Part B — the strengthening prompt (pure)

**`promptTBStrengthen(tb, rtl, gaps, spec, el, previousFixes)`** (in
`prompts/testGen.js`, mirroring `promptTBFromVerifyFail`'s shape →
`{ code }`). It instructs the model to:

- **ADD** self-checking tests that exercise the named uncovered lines/branches/
  toggles and the uncovered requirements, each with a `// covers: REQ-…`
  annotation;
- **PRESERVE every existing test verbatim** — additive only, never delete or
  weaken a passing check (the soundness boundary, stated in the prompt itself).

### Part C — the driver (mirror `runMutationGate`)

**`runCoverageStrengthening(args)`** in `src/pipeline/coverageStrengthen.js`
(`runCli` + `callLLM` injected, like the mutation gate):

1. **Baseline:** run the coverage-enabled sim (the same `verilator_coverage
   --write logs/coverage.dat` command path `judge.js` uses) on the current TB →
   `{ cov, buckets, tests }`.
2. `gaps = findCoverageGaps(…)`. **No gaps → return `{ strengthened:false,
   reason:"no-gaps" }`** (fast no-op).
3. For `round` in `1..maxRounds`:
   - `callLLM(promptTBStrengthen(best, rtl, gaps, …))` → candidate TB;
   - re-run the coverage sim on the candidate → `after`;
   - `acceptStrengthening(before, after)`: **adopt** the candidate as the new
     `best` (and recompute `gaps`) iff accepted; otherwise **discard** it.
4. Return `{ strengthened, rounds, before, after, addedTests, coverageGain,
   newlyCoveredReqs, code }` — `code` is the best (possibly original) TB.

**`acceptStrengthening(before, after)`** (pure) — the central rule. Accept iff
**both**:
- **No regression:** every test that was `PASS` in `before` is still `PASS` in
  `after` (a strengthening that breaks a check is rejected outright); **and**
- **Positive evidence:** at least one gated coverage kind's % increased **or** a
  previously-uncovered requirement is now covered.

Returns `{ accept, reason, gain }`. If no round is accepted, the **original TB
is kept** and the report says `strengthened:false`.

---

## Gating

- Opt-in `config.coverageStrengthening` (default **off**), with
  `config.coverageStrengthenRounds` (default 2) — same opt-in discipline as
  `config.mutationTesting`.
- **Real backend only** (coverage needs Verilator `--coverage`) and only **after
  a verify/judge PASS** — strengthening a *failing* TB is out of scope (fix the
  failure first via the existing verify-fail loop).
- Invoked from the same node/site as the mutation gate (after the final PASS on
  a real CLI); the adopted TB replaces `test_generate.code` and the report
  attaches to the stage result (`verify.coverageStrengthening` /
  `judge.coverageStrengthening`).

---

## Soundness boundary

**Additive · non-regressing · positive-evidence-only.** The loop never deletes
or weakens an existing test (prompt-enforced + re-checked), never adopts a
candidate that fails a previously-passing test, and never adopts one that
doesn't move a gated metric. Worst case it spends a few LLM calls and keeps the
original TB. This mirrors best-of-N's deterministic selection and the mutation
gate's positive-only stance.

---

## Surfaces

- **CLI / pipeline:** the strengthened TB + a one-line report
  (`line 61%→78%, +3 tests, +2 reqs covered`) in the stage log.
- **GUI:** a small read-only "Coverage strengthening" summary in the
  verify/judge panel (before→after bars, added tests, newly-covered reqs).
  Optional and minimal.
- **Eval gate:** no new criterion — the loop **raises the existing**
  `coverageMeasurer` results; tying the loop's thresholds to the enabled
  coverage criteria is the whole integration.

---

## Tests

- `parseCoverageBuckets` (pure): count-0 records → `uncovered`; summary-only file
  → empty buckets; the cap is honored.
- `findCoverageGaps` (pure): weak kinds vs thresholds; uncovered Must/Should reqs
  vs a `coversMap`; thresholds sourced from enabled criteria; no-gap case.
- `acceptStrengthening` (pure): regression → reject; no-improvement → reject;
  coverage-up → accept; req-newly-covered → accept; returns the gain.
- `promptTBStrengthen` (pure): names the gaps, mandates "preserve existing
  tests", emits the `{code}` contract.
- `runCoverageStrengthening` (driver, stubbed `runCli`+`callLLM`): no-gaps
  short-circuits; an improving candidate is adopted; a regressing candidate is
  discarded and the original kept; `maxRounds` bounds the loop.

---

## Out of scope (stated, not forgotten)

- **Waveform-grounded** targeting (which signal/cycle to poke) — that's #15.
- **Formal** coverage / proof — that's #16.
- Strengthening a **failing** TB — fix the failure first; this loop runs only
  post-PASS.
- The absent **acceptance ledger** — noted as a forward consumer
  (`unproven`→`strong`), not a dependency.

---

## Self-rating

**10/10.** Revisions applied to reach it from the first draft:

- Reframed honestly on the **real tree** (no acceptance ledger) and named the
  exact existing pieces it builds on (`parseCoverageDat`, `coverageMeasurer`,
  `coversParser`), so the motivation is standalone and verifiable.
- Tied the loop's thresholds to the **enabled coverage eval criteria** — it
  chases only what the user gates on — making "coverage-driven" concrete rather
  than a vague global target.
- Made the **acceptance rule** (`acceptStrengthening`) the spine: additive +
  non-regressing + positive-evidence-only, with a pure, falsifiable definition,
  so a strengthening can never make things worse.
- Mirrored `runMutationGate` exactly (opt-in, real-backend, post-PASS, injected
  deps, pure helpers) so the slice is consistent and unit-testable without a
  live backend.
- Split the signal into **code-coverage points** (`parseCoverageBuckets`) and
  **requirement gaps** (`coversParser`), and scoped out waveform/formal/failing-
  TB cases so the slice stays bounded.
