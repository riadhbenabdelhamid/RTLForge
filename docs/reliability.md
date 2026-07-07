# Reliability: bounded runs, non-regressing fix loops

**Problem statement (user report):** runs take a very long time looping; fixes
sometimes introduce more issues instead of resolving them, which feeds more
looping. The intent of the tool — verified RTL from local LLMs, easily — is
defeated by unbounded time and regressing iterations.

## Measured evidence

Every item below was observed in this repository's own runs (see also the
session memories `nested-reflow-multiplication`, `bench-local-llm-reality`):

| # | Observation | Mechanism |
|---|-------------|-----------|
| E1 | One `judge` stage produced **140 rtl_generate re-runs, 18 verify re-runs over 3+ hours** without completing (two-module system, lfm2-24b). | `maxJudgeIters` (3) × chain entries that each reset to FULL base per-stage caps (`nestedLintIters`/`nestedVerifyIters` default null → base). Per-level caps bound loops, **not the tree** — the product is hundreds of minutes-long LLM calls. |
| E2 | Lint Test convergence chain `3→43→1`: a fix round **introduced ~40 errors**, and the next round worked on the damaged code. | The classifier detects `REJECT_REGRESSION` but every loop **adopts the candidate anyway** ("forward so the next fix sees fresh diagnostics"). On weak models the next iteration digs out of a self-made hole instead of retrying from good code. |
| E3 | Fix loops ran to their caps on mechanical errors (missing backtick on directives, `[W-1]` ranges, decimal `'b` literals) that a text transform fixes for free. | `syntaxRepair` — measured to fix the dominant local-model error classes at zero LLM cost, conservative by construction — defaults **off**. |
| E4 | The run-budget guard (the designed brake for E1) never fires. | `maxRunTokens`/`maxRunCostUsd` default null = disabled, and neither maps to the real cost of local models: **wall-clock time**. |
| E5 | Fix prompts ask the model to resolve **all findings at once** (errors + warnings + the full raw log). Big asks → big rewrites → regressions (E2). | Warnings aren't even the convergence target (the tiered exit stops at 0 errors), yet they inflate every fix ask. |

## Changes

### R1. Reject means reject: never adopt a regressing fix
`lint`, `lint_test`: on `REJECT_REGRESSION` the candidate is **not adopted** —
the next iteration re-asks against the current (good) code, with the
patch-outcome section telling the model exactly what the rejected attempt
introduced. `verify`: on `REJECT_REGRESSION` / `REJECT_COMPILE_FAIL`,
`currentRTL/currentTB` revert to the best-known pair and the fix evidence
comes from the best-known measurement (fix prompts must describe the code
they're fixing, not the discarded one).

History note: an earlier design reverted and was changed to "forward" because
the model often re-produced the same fix, delaying convergence. Two guards
added since make revert strictly better on regression: the **churn tracker**
turns a re-produced candidate into a fast stagnation stop (best-known ships),
and the **patch-outcome section** gives the model the rejected diff's
consequences so a different attempt is likely. `ACCEPT_*` and
`REJECT_NO_IMPROVEMENT` keep forwarding (no damage to propagate).

### R2. Errors-first fix scope
While errors exist (and warnings are not opted into the target via
`lintWarningsAsErrors`), the RTL/TB fixer sees **errors only**. Smaller ask →
smaller diff → fewer regressions; warnings get fixed only when they are the
convergence target. Applies to the inline fix prompts and the `fixContext`
handed to reflow chains.

### R3. Wall-clock brake on by default: `maxStageMinutes`
`createBudgetGuard` gains a time dimension: elapsed wall-clock since the stage
started, checked at the same iteration boundaries as the token/cost limits
(all loop nodes + best-of-N already call `overWith`; reflow chains inherit the
guard, so the whole nested tree shares one clock). Default **20 minutes per
stage** (GUI + CLI). Tripping is graceful: the loop stops, best-known state is
kept, the stage completes with an honest status — never an error. Token/cost
limits stay opt-in; time is the default because it is the resource local runs
actually spend. Set `maxStageMinutes: 0`/null to disable.

### R4. Nested reflow iterations default to 1
`nestedLintIters: 1`, `nestedVerifyIters: 1` (was null = full base caps).
A chain entry inside a judge/verify/review reflow gets ONE fix iteration —
the tree collapses from `3×3×3…` to roughly linear in chain length. E1's 140
regens under these defaults become ~a dozen. Raise the two knobs to buy the
old depth back.

### R5. Deterministic syntax repair on by default
`syntaxRepair: true`. Its own contract makes this safe: each transform fires
only on constructs invalid where they stand (a wrong guess still fails lint
and enters the loop exactly as before), and it is idempotent. For local
models it removes whole LLM fix iterations (E3).

## The reliability contract (what a user can now assume)

1. **Bounded:** no stage runs longer than `maxStageMinutes` of looping;
   stopping is graceful and keeps the best-known result.
2. **Non-regressing:** a fix iteration never replaces working code with a
   candidate that measured worse; the shipped artifact is the best-known
   state of the run.
3. **Cheap first:** mechanical errors are repaired deterministically before
   any LLM fix call.
4. **Honest:** when convergence isn't reached, the stage reports
   INCOMPLETE/func-fail and the judge scores the truth — an early stop is
   never dressed up as success.

## Rollback / tuning

Every change is a config knob: `maxStageMinutes` (0 = old unbounded),
`nestedLintIters`/`nestedVerifyIters` (null = old full-cap resets),
`syntaxRepair` (false = old), and R1/R2 are behavioral defaults of the loops
themselves (no knob — reverting them means reverting the commit; they are the
core of the fix).
