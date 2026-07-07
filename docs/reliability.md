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
| E6 | Acceptance run after R1–R5: lint errors escalated **1→2→4 with every step classified ACCEPT_PROGRESS**, so R1 never fired. Root cause was the model **pasting the fix prompt's findings block verbatim into the RTL** — every echoed line a fresh syntax error. | The classifier's "revealed" bucket: any new error whose *code* matches a baseline code family (`SYNTAX`→more `SYNTAX`) is never "introduced", so same-family escalation is invisible to `REJECT_REGRESSION`. (The bucket is legitimate when a fix unblocks the parser and pre-existing errors surface — it just can't tell that apart from damage.) |
| E7 | Same run: the judge stage ran **21.5 min against the 20-min limit with no brake firing**. | The owner stage checks its budget only at its own iteration boundaries; a whole reflow chain sits between two of those, so a chain crossing the limit runs every remaining entry to completion. |

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

### R6. Echo guard + escalation stop (E6)
`stripFindingEchoes` removes findings-format lines (`[CODE#N] ERROR …`,
`source ↳` / `fix ↳` rows) from every fix candidate at the repair chokepoints
(lint, lint_test, rtl_generate) — the format is ours and never legal
SystemVerilog, so the strip is deterministic with no false-positive surface.
Independently, the lint loops stop when the **error count rises for two
consecutive measurements** ("ESCALATION DETECTED"): whatever the classifier
called it, a loop whose target metric is climbing is diverging — stop before
the next fix call; best-known ships. One-step rises (a genuine
parser-unblocking reveal, e.g. 1→4→0) still pass.

### R7. Budget check between chain entries (E7)
`runReflowChain` consults the stage budget before **each entry** — the walk
stops at the first entry past the limit ("budget-halted" in the chain
history), keeping the work completed so far, which the owner validates like
any finished chain. Brake granularity tightens from "whole chain" to "one
entry".

### R8. Judge futility gate — stop the moment progress is impossible
The user's actual complaint, precisely: not that runs are long, but that they
are long **while not converging** — the time is wasted. The brakes above cut
losses; this cuts the waste itself at its measured largest site: a judge
reflow chain that changes **no artifact** (same RTL, same TB, same spec —
every entry no-op'd, was rejected, or skipped) guarantees the next verdict
measures the identical design. Previously the judge would still spend a full
re-verify + re-judge round and only then hit the identical-verdict stagnation
stop (measured: ~10 wasted minutes on lfm2-24b). Now the loop stops
immediately after a no-progress chain (`_noProgressReflow` on the history
entry). The unifying principle across R1/R6/R8: **every expensive re-attempt
must be justified by the previous attempt having changed something** — never
iterate on provably identical inputs.

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
