# Errors-to-avoid: cross-run error memory fed into generation (tasks #26–28)

> **Re-spec.** The task list marks #26/#27/#28 completed, but that code is **not
> in the current tree** (same drift that lost the acceptance-ledger arc and the
> embedded executor — verified by `grep`/`ls`: no `errorsToAvoid.js`, no
> harvest, no injection, no docs). This specs the feature afresh against what
> exists today, mirroring `triageMemory` exactly.

## Problem

When the model writes RTL or a TB, it makes the *same* classes of mistake run
after run — width mismatches, undriven signals, blocking/non-blocking misuse,
latch inference. Today each is caught **reactively** by the in-run fix loop
(`promptRTLFromVerifyFail`, `promptTBLintFix`, …) and then forgotten: nothing is
saved, so the next project (or the next module) re-makes the same mistake from
scratch.

`triageMemory` already proves the pattern for the *judge* — persist outcomes,
recall them next time — but it targets triage decisions, is keyed on failure
*signatures*, and never touches generation. `#26–28` add the **generation-side**
analogue: harvest recurring lint errors, persist them, make them
**importable/exportable** (a shared team catalog), and inject an "avoid these"
section into the **cold** RTL-gen and TB-gen prompts.

Standing constraints (unchanged): SPDX header on new files; full vitest suite +
every `npm run verify` suite + `npm run build` stay green; node-only modules
never enter the browser bundle; commits local only (`git commit -F`).

---

## Part A (#26) — pure core + store adapters  (mirror `triageMemory.js`)

New module **`src/pipeline/errorsToAvoid.js`** — pure logic + a pluggable
adapter, exactly like `triageMemory` (pure functions in the browser-bundled
pipeline barrel; `node:fs` injected, never top-level-imported).

**Normalization → a stable lesson.** A lint error is `{ code, sev, line, msg }`
(from `parseCLIOutput`). Raw messages don't repeat verbatim — `signal 'foo'`
vs `signal 'bar'` are the same lesson. `errorSignature(err)` canonicalizes:

```
errorSignature({code:"WIDTH", msg:"Operand 'a' width 8 != 4"})
  → "WIDTH|operand width mismatch"      // strip identifiers/numbers/paths
```

- `normalizeMessage(msg)` — lower-case, drop quoted identifiers, line/col
  numbers, hex/dec literals, and file paths → a template string.
- `errorSignature(err)` = `code + "|" + normalizeMessage(msg)`.

**Aggregation (pure over the catalog):**
- `aggregateErrors(records)` → `[{ signature, code, sample, count, domain, lastTs }]`
  sorted by `count` desc (most-recurring = most worth avoiding).
- `formatErrorsToAvoid(records, { domain, topN = 8 })` → the prompt section
  string (or `""` when empty):
  ```
  COMMON MISTAKES TO AVOID (from N prior run(s) on this machine/team):
    • [WIDTH] operand width mismatch  (seen 6×)
    • [LATCH] inferred latch on missing else  (seen 4×)
  ```
  Filtered to `domain` ("rtl" | "tb") and capped to `topN`.

**Adapters** (same surface as triageMemory's): `record(rec)`, `all()`, plus a
merge-on-record so the catalog dedups by signature instead of growing per error:
- `createInMemoryErrorMemory(seed)` — GUI session / bench / tests.
- `createFileErrorMemory(path, { fs, maxRows = 500 })` — CLI cross-run catalog
  at `~/.rtlforge/errors-to-avoid.json`. `record` increments `count` + bumps
  `lastTs` for an existing signature, else appends; capped to `maxRows` by
  recency. `fs` is REQUIRED + injected (never bundled).

Record shape: `{ signature, code, sev, msg (sample), domain, modId, ts, count }`.

---

## Part B (#27) — harvest from lint, inject into gen

**Harvest** (best-effort, opt-in, non-fatal — like the observer):
- In the **lint** node, after `errors` are produced, record each into
  `st._services.errorMemory` with `domain:"rtl"`.
- In the **lint_test** node, record each with `domain:"tb"`.
- This gives a clean symmetry: RTL-lint lessons steer RTL gen, TB-lint lessons
  steer TB gen. (Verify failures are less structured — noted as a future
  source, not harvested here.)

**Inject** into the **cold** generation prompts only (the fix branches already
carry the specific error):
- `promptRTL(arch, spec, el, ci, sharedPackageCode, errorsToAvoid)` — add a 6th
  optional param; when present, render the "COMMON MISTAKES TO AVOID" section.
- `promptTB(code, spec, el, ci, errorsToAvoid)` — add a 5th optional param.
- `rtl_generate` / `test_generate` (cold branch) read
  `st._services.errorMemory`, compute
  `formatErrorsToAvoid(all(), { domain })`, and pass it in — **only when
  `config.errorsToAvoid` is on**. Off or empty → `""` → prompts are
  **byte-identical** to today (the no-regression lock).

The lessons are framed as **hints, not constraints** ("watch for", not "never
do") — a lesson can be legitimately violated by a correct design.

---

## Part C (#28) — opt-in setting + federation import/export + docs

- **Opt-in:** `config.errorsToAvoid` (default **off**) gates both harvest and
  injection. Added to `defaultProjectConfig()` (useProject.jsx) and
  `term/config.js`, beside `mutationTesting`.
- **Federation (the "import them" ask):** a shared team catalog.
  - CLI `rtlforge errors export` → JSON dump of the catalog.
  - CLI `rtlforge errors import <file.json>` → **merge** another catalog,
    deduping by signature and summing counts (so a teammate's lessons fold in).
  - Pure merge core `mergeErrorCatalogs(dest, src)` → `{ merged, added, summedCounts }`,
    unit-testable without fs (mirrors `observer/merge.js planMerge`).
  - Also `errors show` (top-N table) / `errors wipe`, mirroring `observe`.
- **Docs:** this file + a README pointer.

---

## Wiring (mirror `triageMemory` line-for-line)

| Runtime | Adapter | Threaded via |
|---|---|---|
| CLI (`term/store.js`) | `createFileErrorMemory(~/.rtlforge/errors-to-avoid.json, {fs})` | `services.errorMemory` |
| GUI (`useProject.jsx`) | `createInMemoryErrorMemory()` (a ref) | `services.errorMemory` |
| `runStage.js` | passthrough | `st._services.errorMemory = services.errorMemory \|\| null` |
| headless/bench/tests | none | feature no-ops |

When no adapter is wired, harvest + injection simply no-op — same graceful
degradation as triageMemory.

---

## Soundness / boundaries

- **Advisory, never fatal.** Harvest and injection are wrapped best-effort; a
  failure never affects a run (like the observer / triageMemory).
- **Additive prompt.** Off or empty → gen prompts unchanged, asserted by a
  byte-identical no-regression test.
- **Bounded.** Merge-by-signature + `maxRows` keep the catalog small; `topN`
  bounds the injected section.
- **Hints not rules.** Phrasing avoids turning a past error into a hard
  constraint the model must obey even when wrong.
- **Federation is explicit.** Export/import are manual commands; error messages
  can contain identifiers, so sharing is opt-in and user-initiated.

---

## Tests

- `errorSignature` / `normalizeMessage` (pure): identifiers, numbers, paths
  collapse; distinct codes stay distinct.
- `aggregateErrors` (pure): dedup, counts, frequency sort, domain tag.
- `formatErrorsToAvoid` (pure): section shape, `topN` cap, domain filter,
  empty → `""`.
- `createInMemoryErrorMemory` / `createFileErrorMemory` (mock fs): record
  merges by signature + increments count; persist round-trips; `maxRows` cap.
- `mergeErrorCatalogs` (pure): dedup + summed counts; idempotent re-merge.
- **Prompt injection:** `promptRTL`/`promptTB` with `errorsToAvoid` → section
  present; **without** it → byte-identical to the pre-change output.
- Harvest hook: lint/lint_test nodes call `errorMemory.record` once per error
  when `config.errorsToAvoid` is on, never when off (stubbed memory).

---

## Out of scope (stated, not forgotten)

- Harvesting **verify** failures (unstructured) — lint/lint_test only here.
- Injecting into the **fix** branches — they already have the specific error;
  this targets cold first-pass generation.
- A rich GUI catalog editor — a small read-only panel + the settings toggle is
  enough; CLI owns management.
- Semantic clustering of lessons (embeddings) — frequency + code|template
  signature is the bounded, dependency-free baseline.

---

## Self-rating

**10/10.** Revisions applied to reach it from the first draft:

- Re-grounded on the **real tree** (prior #26–28 code gone) and pinned the exact
  mirror (`triageMemory`'s pure-core + injected-fs adapter + `st._services`
  wiring), so the design is a known-good shape, not a new invention.
- Made **normalization** the spine — without `errorSignature` collapsing
  identifiers/numbers, "errors to avoid" would never dedup and the catalog would
  be noise; defined it concretely.
- Added the **domain split** (rtl-lint → RTL gen, tb-lint → TB gen) so each
  generator gets the lessons that actually apply to it — a symmetry the first
  draft missed.
- Locked the **no-regression** boundary (off/empty → byte-identical prompts) and
  framed lessons as **hints not constraints**, so the feature can't make a clean
  run worse.
- Specified **federation** (`export`/`import` + pure `mergeErrorCatalogs`) as the
  literal answer to "import them," mirroring `observer/merge` for a tested,
  fs-free core.
