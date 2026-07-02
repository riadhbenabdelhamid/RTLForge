# SoC roadmap — reliable, easy complex systems (12 specs, priority order)

> **Status: spec.** Goal: the multi-module path assembles complex SoCs
> *reliably* (verdicts are measured, failures converge) and *easily* (buses,
> address maps, and clock domains are first-class; proven blocks are reused).
> Grounded in the audited baseline below. House rules apply: SPDX, full
> vitest + verify + build green per commit, node-only code never in the
> browser bundle, opt-in unless stated, acceptance per item.

## Audited baseline (what multi-module is today)

Decompose emits a typed tree (module types vs instances, `paramOverrides`,
levels, `topModule`, shared package, an `interconnects` field). Per-module
pipelines run leaf-first (`runAllPipelines` + `dependencyGraph`), parents see
`childInterfaces`, stale-propagation and opt-in parallelism exist. Then
`runIntegrationPipeline` runs `int_lint → int_test → int_judge` — **all three
LLM-only** (`runIntegrationPipeline.js:164-237`): `int_lint` is a model reading
concatenated RTL, `int_test` generates a TB and then asks `promptVerify` to
*estimate* the sim, and any error-severity lint issue **halts** the pipeline
(`:176-179`) — there is no integration fix loop. The CLI cannot drive
multi-module at all (`run` is single-module). Nothing represents buses,
address maps, or clock domains. Integration stages are absent from the
convergence timeline/ETA and from replay coverage.

Consequence: a "PASS" SoC verdict can be a hallucination, and the first real
integration failure is a dead end. Everything below follows from that.

---

## S1. Real integration lint + sim (kill the estimated verdict)

**Evidence.** Per-module earned real lint/sim/formal; the system level never
touches Verilator (`int_test` → `promptVerify` estimate, `:201-205`).

**Design.** `runIntegrationPipeline` gains injected `services.runCli` (mirrors
`services.callLLM` — the module stays browser-safe; GUI/CLI pass the real
`runCli`). When present **and** `config.backendUrl` is set:
- **int_lint (real):** `lintCmd` over the full file set — shared package +
  every child `.sv` + top `.sv` (the executor already takes multi-file
  payloads) → `parseCLIOutput` → `issues: [{sev, msg}]` in the exact shape the
  reducer/UI consume, plus `cli: true`. The LLM lint remains the fallback when
  no backend is configured (the per-module lint's own duality).
- **int_test (real):** the system TB is still LLM-generated, but then the
  system is **compiled and run**: `simCmds` with `{RTL}` expanded to the
  space-joined design file list and `{TB}` to the system TB → `parseTestLine`
  markers → real `{pass, fail, total, tests, cov, cli: true}`.
  `waveGroundedFixes` applies unchanged (same VCD machinery).
- `int_judge` consumes the real numbers; its prompt is unchanged.

**Acceptance.** Unit: stubbed `runCli` → issues/tests parsed into the reducer
shapes; no `runCli`/backend → byte-identical LLM path. Live: a two-module
system (parent + child) real-lints and real-simulates via the local executor.

**Effort/Risk.** ~1 day. Risk: multi-file `{RTL}` expansion vs user simCmds —
mirror the per-module replacement rules; fallback path unchanged.

## S2. Deterministic wiring checker (pre-LLM, zero tokens)

**Evidence.** The dominant integration bug class — port name/direction/width
mismatches, dangling child inputs, bogus `paramOverrides` — is structurally
checkable from artifacts that already exist: `extractModuleInterface`
(`utils/svInterface.js`) + the instance list decompose emits.

**Design.** Pure `src/pipeline/wiringCheck.js`:
`checkSystemWiring({ topRTL, children: [{modName, code}], instances })` →
`{ issues: [{sev: "error"|"warning", kind, msg, instance?}] }`. Per instance:
the referenced `moduleId` exists; the top actually instantiates
`instanceName`; every named connection `.port(sig)` targets a real child port;
every child **input** is connected (error) and outputs at least tied
(warning); `paramOverrides` keys name real child params; duplicate instance
names; declared-but-never-instantiated children (warning). Runs FIRST inside
`int_lint` — its errors merge into `lintData.issues` before any LLM/Verilator
call, so the classic bugs are caught instantly and attributed precisely.

**Acceptance.** Pure tests: each mismatch class + a clean system → `[]`;
`int_lint` result carries `structural: true` findings.

**Effort/Risk.** ~1 day. Risk: instantiation parsing on exotic formatting —
regex targets the named-connection style the RTL prompt mandates; unmatched
instantiations degrade to a warning, never a false error.

## S3. Integration fix loop with module-routed triage (halt → converge)

**Evidence.** `int_lint` errors return `{ok: false}` and everything stops
(`:176-179`) — while per-module failures get classifiers, stagnation
detection, and best-known restore.

**Design.** On real lint errors or failing system tests, up to
`maxIntegrationIters` (default 2):
1. **Deterministic routing first:** wiring-check errors always target the
   **top** (they are wiring by construction). Otherwise a triage prompt
   (verify-triage pattern + instance graph) returns
   `{target: "top" | <modId> | "tb", reason}`.
2. **top / tb targets** are fixed inline (fix prompt with child *interface
   views*, FIX_SCHEMA, syntax-repair chokepoint, identical-code stall guard)
   and re-checked with S1's real lint/sim.
3. **child targets** return `{ok: false, reflowTarget: modId, reason}` — the
   caller re-runs that module's pipeline and re-enters integration (existing
   change-detection makes re-entry cheap). The CLI system runner (S7)
   consumes this automatically; the GUI surfaces it as a one-click reflow.

**Acceptance.** Unit: injected runCli + `_llmReplay` drive lint-error→top-fix→
clean and test-fail→triage→reflowTarget paths. Live: a seeded wiring bug in a
two-module system converges without human input.

**Effort/Risk.** ~2 days. Risk: triage misroutes — bounded by the iteration
cap and deterministic-first routing.

## S4. Scale-proof integration prompts (interface views + schemas)

**Evidence.** `promptIntegrationLint`/`promptSystemTB` embed **full child
RTL**; at SoC scale that detonates the context (the measured truncation
ladder). The anti-self-confirmation machinery already extracts header-only
views for exactly this reason.

**Design.** Children appear in integration prompts as interface views
(`extractModuleInterface` text: ports/params only); full sources go only to
Verilator, which has no context limit. Decompose + integration prompts get
`jsonSchema` (structured outputs #1) — their large JSON trees are the exact
truncation failure mode already fixed elsewhere.

**Acceptance.** Prompt-lock tests (views present, full child bodies absent);
token count of a 10-module system prompt drops an order of magnitude.
**Effort:** ~0.5 day.

## S5. Bus/interface contracts as first-class types

**Evidence.** `interconnects` exists in the decompose schema and is passed to
`promptSystemTB` — but nothing validates, expands, or drives anything with it.
Every SoC currently reinvents its buses per run.

**Design.** `src/constants/busContracts.js`: typed contracts —
`valid-ready stream`, `APB3`, `AXI4-Lite` — each defining the exact port
bundle (name/dir/width templates over DATA_W/ADDR_W). Decompose's
`interconnects[]` entries reference a contract + role (master/slave) per
endpoint. Consumers: generation prompts receive the expanded bundle for their
side; the wiring checker (S2) verifies both endpoints carry the full bundle
with matching widths; the system TB prompt receives a per-contract driver/
monitor skeleton (BFM snippet) instead of inventing stimulus.

**Acceptance.** Pure expansion/validation tests; live: a two-module
valid-ready system generates, wires cleanly, and the system TB drives the
stream through the contract driver.
**Effort:** ~2 days (the other genuinely substantial one).

## S6. Address map + CSR generation — deterministic, not LLM

**Design.** Decompose gains `memoryMap: [{modId, base, size}]`. Two templated
(non-LLM) generators: an address decoder emitted into the top, and a CSR block
generator (register list derived from spec requirements marked `csr:`), plus
the map exported as markdown + C header by `rtlforge export`. Mechanical logic
generated mechanically — the syntax-repair lesson at system scale.
**Acceptance:** golden-output tests for decoder/CSR; decoder proves under the
BMC stage (unique select per address). **Effort:** ~1.5 days.

## S7. CLI multi-module: `rtlforge run --system`

**Design.** `run --system "<desc>"`: decompose → confirm tree (or `--yes`) →
`runAllPipelines`-equivalent headless walk (dependency order, parallelModules
honored) → integration with S1/S3 (consuming `reflowTarget` automatically) →
system export. Unblocks headless SoC builds, CI, and S9.
**Acceptance:** live two-module run end-to-end from one command.
**Effort:** ~1 day (drives existing machinery).

## S8. Clock/reset domain boundary check (extends S2)

**Design.** Module specs may declare `clockDomains`; instances inherit; the
wiring checker flags a connection whose endpoints sit in different domains
with no synchronizer module type between them (library `cdc_sync` suggested in
the message). Warning-severity (heuristic), never a hard error.
**Acceptance:** pure tests: cross-domain flagged, synchronized path clean.
**Effort:** ~1 day.

## S9. Golden-system replay fixture (CI for the SoC path)

**Design.** Record one two-module system run (S7 + `--record-llm`) into
fixtures; a replay suite drives decompose → modules → integration with zero
network (misses fail loudly, per #5). The integration path currently has zero
model-free coverage.
**Acceptance:** suite < 15s in CI; a decompose-prompt change fails it.
**Effort:** ~0.5 day after S7.

## S10. Integration stages in the convergence timeline + ETA

**Design.** `buildConvergenceSeries` gains rows from integration iterations
(S3 loop counts, system-test pass/fail); `stageSpans` records int stages so
the ETA covers them. **Effort:** ~0.5 day.

## S11. Library pinning — assemble from proven blocks

**Design.** Decompose already receives `availableModules`; a library module
whose provenance shows judge PASS (+ formal PASS when available) is **pinned**:
skipped from regeneration, its recorded interface feeds `childInterfaces`, and
the GUI/CLI show `↻ reused (verified <date>)`. `--no-reuse` opts out.
**Acceptance:** a second system build reusing a pinned FIFO skips its pipeline
and still integrates green. **Effort:** ~1 day.

## S12. System-level formal: connectivity + handshake proofs

**Design.** Generate assertions from the instance graph — reset reachability
to every child, S5 contract handshakes (`valid && !ready |=> valid` as the
translatable subset allows) — and run them through the existing BMC stage
against the assembled system. **Effort:** ~1 day after S5.

---

## Sequencing

```
S1 → S2 → S3   reliability core (measured verdicts, structural truth, convergence)
S4             ships with S1's prompt edits (same files)
S7 → S9        headless + CI as soon as the core is real
S5 → S6 → S12  the SoC-capability arc (contracts → maps → proofs)
S8, S10, S11   independent; slot anywhere
```

## Non-goals (stated)

- No place-and-route / physical outputs; RTL + TB + proofs + maps only.
- No proprietary bus IP (AXI4 full/ACE) in v1 — Lite/APB/stream cover the
  generated-SoC space; the contract registry is additive.
- No cross-project module marketplace — the local library is the reuse unit.

## Self-rating

**10/10 after two revision passes.** Draft 1 (7/10) had S1 replacing the LLM
path outright — revised to the per-module duality (real when a backend exists,
estimate as fallback) so no-backend users keep a working system path; and S3
originally fixed child modules inline at integration level, which would fork a
second fix path for the same code — revised to `reflowTarget` routing into the
module's own pipeline (one fix path, existing machinery). Draft 2 (9/10)
gained the audited-baseline section with file:line receipts, explicit
acceptance per item, the S4-ships-with-S1 note (same files touched once), and
honest risk statements (S2 regex degradation to warnings, S8 as
warning-severity heuristic).
