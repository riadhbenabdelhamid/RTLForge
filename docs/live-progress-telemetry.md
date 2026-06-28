<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Riadh Ben Abdelhamid
-->

# Live-progress LLM telemetry (nested-reflow visibility)

## The bug

The in-flight stage panel (`LiveProgressPanel`) shows two counters —
`N LLM calls` / `M CLI execs` — that are supposed to convey "this stage is
doing work right now." In practice the **LLM counter is structurally stuck at
0** for the entire run of every stage, and a long reflow-heavy stage (verify /
judge / lint grinding in a nested fix loop) can sit for many minutes reading
`0 LLM calls / 0 CLI execs`, which looks like broken telemetry.

Observed live on the gpt-oss-120b e2e: a Verify stage RUNNING for 26 minutes,
its nested `Re-run inside verify iter 1 (depth 1)` re-generating RTL, panel
counters frozen at `0 / 0`.

## Why it happens

Two independent causes, both in how live events are (not) wired:

1. **No node ever emits a live `llm` event.** LLM calls are recorded only in the
   node's returned `_llms` ledger; `runStage` *synthesizes* `llm` log entries
   from `_llms` **after the node returns** and attaches them to `result._log`
   (the persistent Log/Tokens tabs). That synthesis never goes through the live
   `onProgress` forwarder, so the live panel's `events` array — and therefore
   its `llmCount` — never sees an `llm` event. (CLI events *do* emit live, via
   `runCli` → `logger.cli`, but only at depth 0.)

2. **Nested reflow runs are forwarder-less.** `reflowRunner` builds each sub
   stage's logger with no `onEmit` (by design, to avoid flooding the live tail).
   So when the *real* work of a stage happens inside a depth≥1 re-run, none of
   it reaches the owner stage's live panel.

A secondary latent bug: `useProject` derived the counters as
`events.filter(type==="llm").length` over an array **capped at 500** — so any
stage exceeding 500 live events would silently *undercount*.

## The fix

A dedicated live-only channel, separate from the logger that feeds
`result._log`, so surfacing live activity can never double-count the persistent
Log.

- **`runStage`** hoists its progress forwarder into `liveEmit` and exposes it on
  the accState as `_emitLiveProgress` (null in headless/tests). On stage
  completion it forwards the stage's **own** synthesized `llm` events (those
  with no `_depth`, i.e. not produced by a nested re-run) to the live panel, so
  the count — and the collapsed pill — reflect reality for every stage.

- **`reflowRunner`** propagates `_emitLiveProgress` onto each sub-state and, as
  each chain entry completes, emits that entry's nested `llm` calls (from
  `result._llms`, already stamped `_depth = parentDepth+1`) through it. It also
  wires the sub-logger's `onEmit` to the same channel so nested `cli`/`state`
  events show up live *during* the entry. The de-dup rule: nested calls are
  surfaced live here and skipped by `runStage`'s own-only forward (they differ
  by `_depth`), so each call is counted exactly once.

- **`liveProgressReducer`** (new pure module) accumulates the counters
  **monotonically** per incoming batch instead of recomputing from the capped
  array — fixing the >500 undercount and correctly tallying forwarded nested
  events.

## Streaming heartbeat

The counter fix makes the *number* honest, but a single-call stage (spec,
architect, cold rtl_generate) still has a window where one long LLM call is
streaming and no event has been emitted yet — the panel sits on "Starting…" and
looks frozen. The LLM badge intentionally counts **completed** calls, so it
correctly reads 0 there; what was missing was any sign of life.

`runStage`'s `onLog` is the single chokepoint every streaming chunk flows
through — including nested reflow streaming, since `reflowRunner` propagates
`_onLog`. It now emits a **throttled** (`≤ ~1.2/s`) `state` heartbeat
("Streaming response… (N tok)") to the live panel. This lights up the in-flight
panel during both top-level and nested generation (so the 26-min nested verify
re-run shows live streaming instead of a frozen "Verify iteration 1/3"), without
inflating the completed-call badge.

## Invariants

- Headless / unit-test runs (no `services.onProgress`) get `_emitLiveProgress =
  null`; every new call site is guarded, so behavior there is unchanged.
- A given LLM call increments the live counter exactly once: nested calls via
  `reflowRunner`, own calls via `runStage`'s `_depth`-filtered forward.
- The persistent `result._log` is untouched — the live channel is write-only to
  the in-flight panel.
