# TB correctness on weak models: sampling + expectations

**Measured problem (nemotron e2e trilogy, docs/reliability.md era):** the
model produced a functionally correct 4-bit counter in three consecutive
runs (independent golden simulations pass), yet its own testbench failed to
verify it every time. After the mechanical classes were eliminated by the
deterministic repairs, the residue was *semantic*: hand-computed expected
values wrong by a cycle, and checks that sample DUT outputs in the same
instant the clock edge updates them. Root cause: inline expectations force
the model to simulate the design cycle-by-cycle in its head — the exact
sequential reasoning weak models can't do.

Four measures (user-approved design, including the Q&A choices below):

## 1. Reference-model TB architecture (`tbArchitecture`, default `"reference-model"`)
`promptTB` (and the review criteria in `promptTestReview`) require:
- a behavioral **shadow model** — `ref_`-prefixed variables updated by ONE
  `always_ff` that re-states the requirements' rules, clocked/reset like the
  DUT;
- a canonical **`step(n)` task** (`@(posedge clk); #1;` per cycle) as the only
  way tests advance time; inputs change only in the settled region;
- every `check(...)` compares a DUT output to its `ref_` counterpart —
  literals only where the requirement itself states a constant.

This converts *trace prediction* (hard) into *rule translation* (easy).
Residual risk, stated honestly: the shadow comes from the same LLM, so a
genuine spec misreading can pass both sides — that's what formal properties,
the judge, and human review remain for. `tbArchitecture: "directed"` restores
the classic style (user-selectable in Settings → Workflow).

## 2. Sampling-race repair (`sampling-race-settle` transform)
User-selected policy: **insert a `#1;` settle** between `@(posedge clk);` and
an immediately following `check(...)` (same cycle, post-update value, minimal
diff). **Checks only** — drive-side timing is never rewritten (changing
stimulus timing changes what a test exercises). **Always active** at the
repair chokepoints, like the other transforms; already-settled code and
`step()`-based tests pass through (idempotent).

## 3. Wave-grounded fixes ON (`waveGroundedFixes: true`)
Internally gated to the LOCAL backend (`backendUrl === "local"`); a no-op
elsewhere. Failing-test fix prompts lead with the measured VCD signal window
around the first failure — the model corrects expectations from ground truth
instead of re-guessing.

## 4. Formal arbiter (`formalArbiter`, opt-in `false`)
When BMC **proved** the bound properties (real sby run, non-empty property
set, and the sim result is not a compile failure), verify's triage routes the
failure to the testbench on measured evidence — no LLM triage call. The
routing reason states the limits explicitly: bounded depth, and only the
bound properties are covered. Opt-in because its trustworthiness scales with
property quality; pair with formal stages enabled and a sensible
`formalDepth` (a 4-bit counter's wrap needs depth ≥ 17, not the default 15).
