# Research & investigation topics — errors-to-avoid / training

> A living research agenda for the model-knowledge thread (errors-to-avoid,
> training mode, knowledge packs). Grounded in what has actually been *measured*
> so far, with the open questions each finding points to. See
> [errors-to-avoid.md](errors-to-avoid.md) and [training-mode.md](training-mode.md)
> for the shipped mechanisms.

---

## Findings to date (measured, not assumed)

**F1 — The injection mechanism works; lift is capability-bound.**
A/B on `liquid/lfm2-24b-a2b`, 5 bench specs, cold RTL gen + Verilator lint, arm A
= no knowledge vs arm B = the model's own 8-rule pack injected: **37 vs 36 lint
errors, 0/5 clean in both arms.** No aggregate lift. The rules *are* in the prompt
(verified via `run --show-injection`); the ceiling is that the model makes 3–15
errors/module, so a handful of hints are lost in the noise. Consistent with the
earlier best-of-N result on `gpt-oss-120b` ("mechanism proven, ZERO lift").

**F2 — Per-rule effect is mixed and *phrasing-sensitive* (the real finding).**
The aggregate wash hides opposing per-class effects:
| class | A | B | |
|---|---|---|---|
| sized literal | 2/5 | 0/5 | positive rule **helped** |
| parameter header | 3/5 | 1/5 | positive rule **helped** |
| vector `[:0]` | 1/5 | 1/5 | no change |
| always_* placement | 3/5 | 3/5 | no change |
| **complex ports** | 0/5 | 3/5 | anti-pattern rule **backfired** |
The rules that helped are phrased *positively* ("give every vector a full range").
The one that backfired is the only rule that *names the anti-pattern* ("…avoid the
complex/expression port forms") — a "don't think of a pink elephant" effect:
naming the wrong form primes the model to produce it. The backfire cancelled the
gains → net wash.

**F3 — Harvest quality tracks model capability.**
`lfm2.5-1.2b` (below floor) dumps *spec prose* into the RTL (11/17 harvested
"lessons" were prose noise). `lfm2-24b-a2b` (capable) produces genuine SV mistakes
(0 prose leaks). The `isProseLeak` guard filters the prose at harvest.

**F4 — Raw-symptom cardinality inflates the catalog and defeats saturation.**
Verilator embeds the source line in each error, so the same mistake on different
lines became distinct signatures — 82 raw records ≈ 8 real lessons, and the
distinct-count never plateaus (saturation can't fire). Stripping the source gutter
in `normalizeMessage` collapsed 82 → 19; `RULE_TABLE` distillation → 8 unique
rules.

**F5 — Reasoning models are impractical for training volume.**
`nvidia/nemotron-3-nano-omni` spends whole stages (~16k tokens) on hidden
reasoning (~7 min/stage), so a single gen→lint pass can exceed the time budget.
Non-reasoning, capable models (`lfm2-24b-a2b`) are the sweet spot for harvesting.

---

## Open investigation topics (prioritized)

**T1 — Positive-only phrasing (direct follow-up to F2).**
Rewrite every pack + `RULE_TABLE` rule as a pure *positive* instruction; drop all
"avoid X / never do X" clauses (start with the complex-ports rule). Re-run the F1
A/B. *Hypothesis:* the backfire disappears and the two-classes-helped signal
survives as net positive lift. Cheapest, highest-information next experiment.

**T2 — Lift on a strong model.**
Errors-to-avoid has leverage only where the model is already *close* — few
recurring mistakes, where avoiding one can flip fail→pass. Run the F1 A/B on a
strong model and measure compile-pass and functional-pass rate, not just error
count. This is the experiment that decides whether the feature earns its keep.

**T3 — Deterministic syntax-repair pass (the weak-model lever).**
The top `lfm2-24b-a2b` mistakes are *mechanically* fixable — `[W-1]`→`[W-1:0]`,
`'b2`→`'d`/`'h`, VHDL `name : type` ports → `type name`, misplaced `assign`.
A post-generation deterministic transform would clean these regardless of model
capability, where prompt hints don't. Likely the highest-ROI lever for weak
models; complements (doesn't replace) the LLM fix loop.

**T4 — Per-rule fitness (measure, then keep only what helps).**
F2 shows rules aren't uniformly good. Track each rule's *marginal* effect
(did its target error class go down when injected?) and inject only rules with
demonstrated positive lift; auto-flag rules that backfire or don't move their
class. Turns the catalog from "everything harvested" into "everything *proven*".

**T5 — Injection budget & the prompt-length confound.**
Arm B's prompt is longer than arm A's regardless of rule content — a confound in
F1. Investigate: does injecting fewer, higher-value rules beat injecting all?
Does the added prompt length itself degrade generation? Control for length by
padding arm A with neutral text.

**T6 — Signature-granularity tuning (from F4).**
Gutter-stripping dedups line-variants but risks over-merging genuinely distinct
"unexpected IDENTIFIER" causes. Measure the false-merge rate and tune how much
context the signature keeps (e.g. keep the "expecting X" clause, drop only the
source line — current behavior — vs finer/coarser).

**T7 — Cross-model transfer.**
Default injection is same-model-only. Do rules harvested on model X ever help
model Y net-positive (shared SV pitfalls) — or does cross-model injection mostly
add noise/backfire? Decides whether `errorsToAvoidCrossModel` and federation are
ever worth enabling.

**T8 — Convergence / saturation on clean signal.**
Now that the guard (F3) + gutter-strip (F4) restore saturation, does training
actually *converge* — do a capable model's distinct real-error classes plateau
within a modest run budget? Characterize the curve (classes vs runs) per model.

**T9 — Model-rewritten rule quality (`--expand model`).**
Do LLM-rewritten rules (`ruleSource: "model"`) outperform table-distilled ones?
Guard against hallucinated specifics (observed: nemotron's rewrite added a bogus
"end with a semicolon" to the `timescale` rule). Compare table vs model rules in
the F1/T1 A/B; require the rewrite to be validated against the connected sample.

**T10 — Metric rigor.**
F1 used lint-error count at N=5, single seed — very noisy. Design a proper
benchmark: more specs, multiple seeds per cell, report compile-pass + functional
pass-rate with confidence intervals, and separate "syntactic" from "functional"
mistakes (errors-to-avoid targets the former).

---

## Methodology / reproduce

- **A/B harness:** generate `spec → architect → rtl_generate`, then lint the RTL
  directly with `verilator --lint-only`, counting `%Error` and classifying against
  the pack's rule classes. Two arms differ only in `config.useShippedRules`
  (pack inject) — see the driver pattern in this session's scratchpad `ab.mjs`.
- **See the injection:** `rtlforge run --show-injection --model <id>` prints
  exactly what would be injected for a config, via the same `resolveAvoidSection`
  the nodes use.
- **Build a catalog:** `rtlforge train rtl --auto` (stops at lint; harvests +
  distils, model-scoped). Inspect with `rtlforge errors show --model <id>`.

## Standing hypotheses

1. Errors-to-avoid is a *precision* tool (helps a near-correct model avoid its few
   recurring slips), not a *capability* tool (won't rescue a model that can't
   write clean RTL). → T2 decides this.
2. Rule **phrasing** dominates rule **content** for effect sign — positive
   instructions help, anti-pattern mentions backfire. → T1 decides this.
3. For below-floor models, deterministic repair > prompt hints. → T3 decides this.
