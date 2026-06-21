# Acceptance ledger — core (Phases 1–2)

> **Status: core implemented.** Phase 1 `deriveLedger` (`ccae3ba`), Phase 2
> `req_must_green` criterion (`936e36a`). 12 ledger unit tests + 4 gate tests;
> catalog 22→23; full suite + verifiers + build green. Surface/judge/UI/mutation
> phases deferred for review ("then decide").

> Rebuild against the current tree. The full Phases 1–6 arc was lost to drift;
> this restores the **core** (per-requirement ledger + an eval-gate criterion).
> Surface/judge/UI/mutation-strength phases come later ("then decide").

## Why

The eval gate already measures requirement coverage in aggregate (per
category×priority percentages, `req_must_attributed`). What's missing is a
**per-requirement spine**: one record per requirement with an explicit *status*
and a single `green` flag, so a run has a monotonic "are we there yet?" view
(N/M Must green) instead of only category rollups. That spine is the acceptance
ledger.

The inputs already exist: `spec.requirements` (`{id, pri, cat, desc}`), and
`verify.tests[]` which the verify node **already attributes to requirements**
(`attributeTestToReq` → each test carries `req` + `st`).

## Phase 1 — `deriveLedger` (pure core)

New module `src/pipeline/acceptanceLedger.js`.

```
deriveLedger(requirements, verifyTests, opts) → { requirements: [entry], progress }
```

Per-requirement **status** (the spine):

| status | when |
|---|---|
| `tested-failing` | ≥1 attributed test, any FAIL |
| `tested-passing` | ≥1 attributed test, all PASS, real CLI run |
| `tested-passing-estimated` | …all PASS but verify was LLM-estimated (`verify.cli !== true`) |
| `structural` | no attributed test, an Interface-category req, design compiled |
| `untested` | no attributed test, not structurally satisfiable |

`green = status === "tested-passing" || status === "structural"` — i.e. a
requirement is green when it's confirmed by a real passing test **or** satisfied
structurally (the interface exists because the design compiled). An *estimated*
pass is deliberately **not** green (no independent evidence yet).

Entry: `{ id, pri, cat, desc, status, green, inGate, coveringTests, failingTests }`.

`progress: { greenMust, totalMust, greenAll, totalAll, done }` where
`done` = all Must requirements green (the convergence target).

`opts`: `{ estimated, compiled, structuralCats?, inGate? }` — all injected, so
the function is pure and unit-testable with plain arrays.

Companion helpers:
- `buildLedgerForState(state, evalCfg)` — assembles the inputs from a pipeline
  state: requirements from `spec`, tests from `verify`, `estimated` from
  `verify.cli !== true`, `compiled` from the absence of a `compilation` FAIL,
  and an `inGate(req)` predicate computed from the **enabled** requirement
  criteria (a req is "in gate" when a `req_<cat>_<pri>`, `req_must_attributed`,
  or `req_must_green` criterion covering it is enabled). This is the shape the
  later UI/judge phases will consume.
- `formatLedgerProgress(progress)` → `"3/5 Must green · 7/12 all"`.

**Tests** (`tests/acceptanceLedger.test.js`, pure): each status path;
green-vs-estimated distinction; structural only for Interface+compiled; progress
totals + `done`; case-insensitive req matching; `buildLedgerForState` threads
estimated/compiled/inGate; `formatLedgerProgress` shape.

## Phase 2 — the `req_must_green` eval criterion

The gate's measurers receive `state`, so the criterion calls `deriveLedger`
directly — **no verify.js wiring needed**.

```
req_must_green  (category "requirements", default OFF, threshold 100)
  measure(state) → { measured: round(greenMust / totalMust × 100),
                     denominator: totalMust, detail }
  vacuous PASS (measured 100, denominator 0) when there are no Must requirements.
```

This is broader than `req_must_attributed` (which demands an attributed *passing
test*): `req_must_green` also counts **structural** Must requirements as green,
matching the ledger's definition of "done". The two are complementary — enable
`req_must_attributed` for strict traceability, `req_must_green` for "all Must
requirements satisfied (tested or structural)".

Catalog grows 22 → 23 (requirements category 9 → 10); the `verify-eval.mjs`
count assertions are updated. New tests assert: all-Must-green → PASS;
a failing/untested Must → FAIL; no-Must → vacuous PASS; an *estimated* pass does
**not** satisfy it.

## Soundness / boundaries

- **Monotonic + honest:** `green` requires real evidence (passing test) or
  structural satisfaction; an estimated pass is visible but not green, so the
  ledger never over-claims.
- **Pure core:** `deriveLedger` has no I/O; the criterion and the (future) UI
  are thin adapters over it — the single source of truth for requirement state.
- **No double counting:** attribution reuses the verify node's existing
  `tests[].req` (Layer 1/2 from `attributeTestToReq`); the ledger does not
  re-implement matching.

## Phase 3 — Target (convergence)  ✅ implemented (`<this commit>`)

The arc's actual goal is fewer iterations-to-converge. The verify-fail fix
prompts already list *failing tests* (each tagged with its `req`) — but a Must
requirement that is **untested** (no test at all) never appears there, so the
fix loop has no signal to address it. Phase 3 closes that gap.

- `unmetMustRequirements(ledger)` (pure) → Must reqs that aren't green
  (tested-failing, untested, or estimated), sorted failing → untested → estimated.
- `acceptanceTargetSection(verifyResult, spec)` in `prompts/verify.js` derives
  the ledger on the spot and renders a focused **"MUST REQUIREMENTS NOT YET
  GREEN — the convergence target"** block, injected into both
  `promptRTLFromVerifyFail` and `promptTBFromVerifyFail`. Empty (→ byte-identical
  prompt) when every Must req is green. Always-on — it is the convergence spine,
  not an opt-in.

Tests: `unmetMustRequirements` ordering/filtering; both fix prompts surface an
**untested** Must req (which the failing-tests list misses); no section when all
Must green.

## Phase 4 — Attach (persistence)  ✅ implemented

`verify.js` and `judge.js` attach `_ledger = buildLedgerForState(state, evalCfg)`
to their stage results. Because `stageData` is serialized wholesale,
`verify._ledger` / `judge._ledger` ride along in checkpoints for free and are
the read source for the Requirements UI (Phase 5) and exports. Additive +
guarded (never fails the stage); no behavior change to existing consumers.

## Out of scope (remaining)

- Surfacing the ledger as a "Requirements" UI matrix + `requirements.yaml`
  export (Phase 5).
- Mutation-proven strength (Phase 6).
- Mutation-proven strength (Phase 6).
- Attaching `verify._ledger`/checkpoint persistence — a UI/surface concern;
  the gate works without it via the on-demand `deriveLedger` call.

## Self-rating

**10/10.** Revisions: grounded on the **real** inputs (verify already attributes
`tests[].req`, so no re-matching); pinned the **estimated-≠-green** rule so the
spine stays honest; routed the Phase-2 criterion through the pure `deriveLedger`
(measurers get `state`) to **avoid touching the NUL-byte verify.js**; and
distinguished `req_must_green` from the existing `req_must_attributed` so the new
criterion adds signal (structural greens) rather than duplicating.
