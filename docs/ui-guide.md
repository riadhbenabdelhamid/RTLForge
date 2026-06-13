# RTL Forge — UI Guide

A tour of the web UI: what each surface does and, in particular, how to read
the **stage badges** during loopbacks and reflows — the part of the UI that
packs the most meaning into the fewest pixels.

> Source of truth for the badge logic: `src/react/components/stageBadgeStyle.js`
> (a pure helper, unit-tested in isolation). The tab strip that consumes it
> lives in `src/react/components/RTLForge.jsx`.

---

## Layout overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Header: brand · workflow subtitle · MODE selector · model tag        │
│         · CLI ✓/✗/? badge · 💾 checkpoint · ⚙ settings               │
├──────────┬───────────────────────────────────────────────────────────┤
│ Module   │ Stage tab strip: ① ② ③ … (one badge per active stage)    │
│ sidebar  ├───────────────────────────────────────────────────────────┤
│ (system  │ Stage header: number · name · COMPLETE/ERROR/RUNNING tags │
│ mode)    │              · Re-run / Retry / Run / Proceed buttons     │
│          ├───────────────────────────────────────────────────────────┤
│          │ Stage content (per-stage panel, see below)                │
│          │ · run-selector dropdown (when a stage ran more than once) │
│          │ · live-activity pill (while/after a stage runs)           │
└──────────┴───────────────────────────────────────────────────────────┘
```

- **MODE** — `Semi-Auto` runs one stage per click ("Proceed"); `Full-Auto`
  runs every remaining stage (and every module, in system mode).
- **CLI badge** — `CLI ✓` means the Verilator backend answered the health
  check; `CLI ✗` unreachable; `CLI ?` not yet verified. Real simulation
  (and therefore a real judge **PASS** — see below) requires ✓.
- **Module sidebar** (system mode) — modules grouped By-Level or
  By-Instance, with completion rings and stale markers.

---

## Stage tab badges

Each active stage gets a 20×20 badge in the tab strip. Shape, glyph, color,
and animation each carry one bit of meaning:

### Glyphs

| Glyph | Meaning |
|---|---|
| `✓` | stage completed |
| *number* | not yet run, or **stale** (orange — a downstream re-run invalidated it) |
| `!` | hard error (tab stays clickable so you can read the error and Retry) |
| `↻` | stage is part of an active **reflow chain** (it is being / will be re-run) |

### Colors

| Color | Meaning |
|---|---|
| green | completed |
| red | error, or completed-but-failing (failed tests, FAIL verdict) |
| orange | stale — needs a re-run |
| yellow (slow pulse) | currently executing |
| bright yellow (fast blink) | involved in a loopback/reflow right now |

### Shape + animation — reading loopbacks and reflows

This is the part people ask about. When a previously-completed step starts
blinking while a later stage runs, the **shape** tells you *how* it is being
re-worked:

| Badge | Meaning |
|---|---|
| **△ triangle, fast blink, `↻`** | The stage is **queued** in a K-to-X reflow chain. Verify/judge triaged a failure and is re-walking the pipeline tail (e.g. `test_generate → lint_test → verify`); this stage's full re-run is coming, but a sibling chain stage is executing right now. |
| **○ circle, slow pulse, `↻`** | The chain member **executing right now**. Same chain membership (hence `↻` — it *is* a re-run); the slow pulse singles it out as the active one among the fast-blinking triangles. |
| **○ circle, fast blink, number/`✓`** | **Point loopback**: the running stage's *internal fix loop* is patching this stage's artifact in place (e.g. verify rewriting the RTL through a fix prompt). The stage is **not** re-executed as a stage — its output is edited inline — so there is no `↻`. |
| **○ circle, slow pulse, no `↻`** | Ordinary current-stage execution; no reflow involved. |

Rules of thumb:

- **Triangle = waiting, circle = acting.**
- **`↻` = a stage-level re-run; no `↻` = an in-place artifact patch.**
- **Fast blink = "involved in the fix", slow pulse = "the one running".**

Both signals are **module-scoped**: in system mode, a loopback inside module
B never blinks module A's tabs.

### Reachability

A tab is clickable (full opacity) when there is anything to see inside it:
completed, currently running, stale, errored, or holding partial data.
Everything else renders at 25% opacity until the pipeline reaches it.

---

## Per-stage runs and the run selector

Every original run **and** every reflow re-run of a stage is recorded. When a
stage has run more than once, a **run-selector dropdown** appears above its
content — pick any run to view that run's result snapshot (entries carry
reflow provenance like *"run #3 · reflow inside judge iter 1"*). The judge's
**Trace** tab is synchronized with it: clicking a chain entry there selects
the matching run.

---

## Live progress

While a stage runs, its panel shows a **live activity display** (every LLM
chunk, CLI execution, skill application, and state transition as it happens)
instead of "No data yet.". After the stage finishes, the feed collapses to a
small pill below the content — click it to re-expand the in-flight trace.

---

## Judge verdicts

The Judge stage's verdict ring has **three** states, not two:

| Verdict | Color | Meaning |
|---|---|---|
| `PASS` | green | the eval gate passed **and** the verify data came from a real CLI simulation |
| `UNVERIFIED` | amber | the gate passed, but the simulation numbers were **LLM-estimated** (no CLI backend) — nothing was actually simulated. A note under the verdict explains how to earn a real PASS. |
| `FAIL` | red | the gate failed |

Package export ("Export as Package") is enabled **only** on a real `PASS` —
an UNVERIFIED run is not a verified deliverable. The raw gate outcome is
always preserved in the result (`evalOverall`) for audit.

Other judge tabs: per-criterion **Evals** breakdown, requirement
**Traceability**, **Judge Loop** iteration drill-down, execution **Trace**,
**Duration**/**Tokens** cost breakdowns, and the per-step **Log**.

---

## Verify stage extras

- Tests are grouped by requirement category with per-category PASS/FAIL
  rollups; `// covers: REQ-ID` annotations drive the attribution.
- **Real CLI vs AI Estimated** badges mark the provenance of every result.
- When formal properties are bound into the build (`svaInSim`, default on),
  the log lists which properties were checked and which were skipped (and
  why). A violated assertion fails the simulation like any test.
- With `mutationTesting` enabled, the log reports the **mutation score**
  (how many injected RTL bugs the testbench caught) and names every
  surviving mutant — see `docs/evals.md` (`mutation_score` criterion).

---

## Settings (⚙) tabs

| Tab | What it controls |
|---|---|
| **Workflow** | the pipeline editor: optional stages on/off, SVG flow graph, per-stage prompt section overrides |
| **Skills** | user style rules overlaid on LLM calls per stage (`docs/skills.md`) |
| **Evals** | the judge gate's 22 criteria — enable/disable + thresholds (`docs/evals.md`) |
| **Observer** | the opt-in knowledge-base agent (`docs/observer.md`) |
| **UI** | theme selection and customization (`docs/themes.md`) |
| **LLM** | provider, model, API key, temperature, **Per-Stage Settings** (incl. per-stage Max Tokens), budget ceilings |
| **CLI** | backend URL, lint/sim commands, strict-CLI mode, timeouts |
| **Library** | imported reusable module packages |
| **Checkpoints** | saved project snapshots (resume/delete) |
| **Paths** | settings/library directory locations |

Useful knobs that live in config (also settable via
`rtlforge config set <key> <value>` in the terminal app):

- `maxRunTokens` / `maxRunCostUsd` — run budget with graceful halt
- `svaInSim` — bind formal properties into simulation builds
- `mutationTesting` / `mutationMaxMutants` — testbench-strength gate
- `parallelModules` — wave-parallel module execution (full-auto)
- `truncationRetries` / `maxTokensCeiling` — auto-recovery from
  length-cut LLM output
- `parseRetries` — hinted re-ask when an LLM reply fails to parse
- `modelRouting` — per-stage LLM routing, e.g.
  `{ "test_generate": { "provider": "openai", "model": "gpt-4o" } }`, to let
  a different model write/review the testbench than wrote the RTL
  (decorrelation), or route cheap stages to a cheaper model. Honored at
  highest precedence regardless of the global "Use Global LLM" setting. *(A
  dedicated per-stage routing widget in Settings → LLM is a planned
  follow-up; today set it in config.)*

---

## Checkpoints & resume

Every successful stage auto-saves a checkpoint. On reload, the most recent
project offers to resume. API keys are **never** persisted — after a resume
you'll be prompted to re-enter the key before the next LLM call. The
terminal app shares the same checkpoint format (`rtlforge status` /
`resume`).
