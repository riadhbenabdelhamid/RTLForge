# Evals — Deterministic Judge Gate

The judge stage decides whether a generation is good enough to ship. Pre-V22
that decision was an LLM rubric ("score: 87 because lint clean, verify
100%…"). Post-V22 it's a **deterministic gate** driven by user-configurable
criteria.

## Why deterministic

Three reasons:

1. **Reproducibility.** Same project state + same config = same verdict,
   byte-identical. No "the LLM was in a mood today."
2. **Auditability.** Every PASS/FAIL traces to one measurement against
   one threshold. No black-box rubric.
3. **User control.** Threshold tuning is a slider, not a prompt edit.
   Want to require 95% verify pass rate? Set `verify_pass_rate.threshold = 95`.

The LLM still has a role in the judge stage — but only for **triage**
("given that the gate FAILed, which upstream stage should we fix?") and
only when 2+ candidate stages tie. The verdict itself is rules.

## Criterion catalog

20 criteria across 6 categories. Each has an `id`, `category`, `label`,
`defaultEnabled`, `defaultThreshold`, and a measurer function.

| Category | Criteria | What each measures |
|---|---|---|
| **requirements** | 8 entries: `req_<cat>_<pri>` where `<cat>` ∈ {`func`, `verif`, `timing`, `intf`} and `<pri>` ∈ {`must`, `should`} | % of in-scope requirements traced as passing |
| **verify** | `verify_pass_rate` | passing tests ÷ total tests |
| **coverage** | `coverage_line`, `coverage_branch`, `coverage_toggle`, `coverage_fsm`, `coverage_func` | each reads from `verify.cov.*` |
| **formal** | `formal_assertions_present`, `formal_covers_present` | non-empty arrays in `formal_props` |
| **lint** | `lint_rtl_clean`, `lint_tb_clean` | binary on errors=0 |
| **review** | `review_rtl_score`, `review_tb_score` | the LLM-review score directly |

## Conservative defaults

Out of the box, three criteria are enabled at 100%:

- `req_func_must` — every Must-priority Functionality requirement must be traced
- `verify_pass_rate` — every test must pass
- `lint_rtl_clean` — zero RTL lint errors

Everything else defaults to disabled. Users opt in to additional rigor
explicitly via the Evals tab or CLI.

## The verdict shape

```js
runEvalGate(state, evalConfig) → {
  overall:        "PASS" | "FAIL",
  score:          number,                 // 0..100, % of enabled criteria passing
  passed:         number,
  failed:         number,
  totalEnabled:   number,
  failingIds:     [<criterionId>],
  results: [
    {
      id:          string,
      category:    string,
      label:       string,
      enabled:     boolean,
      threshold:   number,
      measured:    number,                // what the measurer reported (0..100)
      margin:      number,                // measured - threshold (negative when FAIL)
      detail:      string,                // human-readable explanation
      status:      "PASS" | "FAIL" | "SKIP",
      denominator: number,                // sample size; 0 means vacuous PASS
    },
    // …one entry per criterion
  ],
  categories: {
    requirements: { pass, fail, skipped },
    verify:       { pass, fail, skipped },
    coverage:     { pass, fail, skipped },
    formal:       { pass, fail, skipped },
    lint:         { pass, fail, skipped },
    review:       { pass, fail, skipped },
  },
}
```

The verdict is what the GUI's Evals tab and JudgeStage's Judge Loop tab
both render.

## Triage

When `overall === "FAIL"`, the judge node calls `triageTargetsFor(verdict)`
to get an ordered list of candidate stages to regenerate. The mapping:

| Failing category | Candidate stages (in order) |
|---|---|
| `requirements` | `rtl_generate`, `spec` |
| `verify` | `test_generate`, `rtl_generate` |
| `coverage` | `test_generate` |
| `lint` | `rtl_generate` |
| `formal` | `formal_props` |
| `review` | `rtl_generate` |

If exactly one candidate, the judge picks it deterministically. If 2+,
the LLM triage prompt runs but its choice is constrained to that
candidate set — it can't go off-script.

## CLI

```bash
# Show the effective configuration (per-category table)
rtlforge evals show

# Read or write one criterion
rtlforge evals get verify_pass_rate
rtlforge evals set verify_pass_rate threshold=95
rtlforge evals set req_func_should enabled=true

# Reset to defaults
rtlforge evals reset                  # all
rtlforge evals reset coverage_line    # one criterion

# Debug-run the gate against a saved project (exit 0 on PASS, 1 on FAIL)
rtlforge evals run --project sync_fifo

# Catalog views
rtlforge evals categories
rtlforge evals criteria
```

## GUI

**Settings → Evals tab.** Per-category sections; per-criterion row with
enable checkbox + threshold input. The Requirements category gets a
specialized layout: each requirement category (Functional / Verification
/ Timing / Interface) has a parent "All priorities" checkbox that
toggles its Must + Should children together. Indeterminate state when
children are mixed.

Threshold input is clamped to 0..100. Reset-to-defaults button at the top.

## Adding a new criterion

1. Append one entry to `src/eval/criteria.js`'s `CATALOG`:
   ```js
   {
     id: "my_new_criterion",
     category: "lint",
     label: "Custom lint thing",
     defaultEnabled: false,
     defaultThreshold: 100,
     measure: function(state) {
       return { measured: 0..100, denominator: number, detail: string };
     },
   }
   ```
2. (Optional) add a triage target mapping in `src/eval/gate.js`'s
   `TRIAGE_BY_CAT` if failures of this criterion should drive regen.

That's it — the GUI's Evals tab picks up the new entry automatically (it
reads `listCriteria()`), the CLI commands surface it, the gate measures it.
No switch statement to update across N files.

## Pipeline integration

`judge.js` reads its `evalCriteria` from `st._config.evalCriteria`,
normalizes it (clamps thresholds, drops unknown ids with a warning),
runs `runEvalGate` for each iteration, and returns `{judge.eval}` on the
node result. The GUI reads `eval.results` for per-criterion drill-down
in the iteration tab.
