<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Riadh Ben Abdelhamid
-->

# E2E convergence fixes — compile-failure handling

## The evidence

A headless e2e (fifo_sync, gpt-oss-120b, in-process verilator, ~13 min) failed
to converge: **verify hit its 3/3 iteration cap AND judge hit its 3/3 cap**,
final `pass:0 / fail:1 / total:1`. Root cause was a single illegal SystemVerilog
construct in the generated testbench — a variable declared mid-block, after
statements, inside a task:

```
%Error: fifo_sync_tb.sv:135:15: syntax error, unexpected IDENTIFIER, expecting "'{"
  135 |         logic prev_full;
```

That **hard compile error** survived up to 9 fix iterations (lint_test 3 + verify
3 + judge 3, ~7 of 13 min, ~10 LLM calls). The pipeline treated a
*does-not-compile* candidate as an ordinary test failure and ran it through the
same probabilistic fix loop. Three code-level defects let that happen:

## Bug 1 — the patch classifier `ACCEPT_EQUIVALENT`s a non-compiling candidate

`classifyTestResults` (used by verify via `classifyTestResultsByReq`) reasons
purely on resolved/introduced/persisting test-marker deltas. A non-compiling run
surfaces as a *single synthetic* `{name:"compilation", st:"FAIL"}` test
(`verify.js:241`). When the previous and current candidates both fail to
compile, that's `resolved=0, introduced=0` → **`ACCEPT_EQUIVALENT`** ("no
improvement, no regression — keep candidate"). So the loop *keeps* a broken TB
and burns its whole budget.

**Fix:** add a distinct `REJECT_COMPILE_FAIL` tier. A candidate that does not
compile has no trustworthy test signal, so the resolved/introduced math is
meaningless — force a reject. The score-based best-known restore (score =
pass − 2·fail; compile-fail scores −2) already prefers any compiling candidate,
and the reject changes the stagnation signature so repeats break sooner and the
fix prompt (Bug 3) gets a clear "syntax-first" signal.

## Bug 2 — no compile gate after lint_test

lint_test detected the exact error, exhausted its 3-iter cap with the TB *still
not compiling* (iter 2 even hit `REJECT_INVALID_PATCH` — "LLM returned identical
TB"), then the pipeline proceeded to verify with a guaranteed-failing TB. There
is no gate: "TB still doesn't compile after lint_test → flag it and carry the
exact verilator error forward" so verify/judge target it deterministically
instead of re-discovering it via an LLM triage call.

## Bug 3 — fix prompts don't prioritize hard compile errors over warnings

verify's iter-3 "fix" suppressed `PROCASSINIT`/`UNUSEDSIGNAL` *warnings* and
added delays while the `prev_full` *syntax error* sat untouched. When a
candidate fails to compile, the verbatim compiler error must be injected into
the fix prompt and flagged MUST-FIX-FIRST, ahead of any warning cleanup.

## Order

Implemented in order: Bug 1 (classifier) → Bug 2 (gate) → Bug 3 (prompt), each a
separate commit with tests, suite kept green.
