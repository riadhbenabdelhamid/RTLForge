# RTL Forge benchmark

Empirical measurement of pipeline quality, so prompt and loop changes get a
**number** instead of a vibe. Runs a golden suite of canonical designs
end-to-end and scores each run; diff two runs to see whether a change helped.

## Run it

```bash
# Whole suite, against your configured LLM + Verilator backend
RTLFORGE_PROVIDER=anthropic RTLFORGE_MODEL=claude-… \
RTLFORGE_API_KEY=sk-… RTLFORGE_BACKEND_URL=http://localhost:3001 \
npm run bench

npm run bench -- --spec=fifo_sync,uart_rx       # a subset
npm run bench -- --baseline=bench/results/<old>.json   # run + diff vs baseline
npm run bench:mock                               # offline self-test (no LLM/backend)
```

A **CLI backend** (`RTLFORGE_BACKEND_URL`) is what makes the verify, mutation,
and SVA numbers real. Without one, verify falls back to LLM-estimated results
and judge caps at `UNVERIFIED` — the scorer records that faithfully, so a
no-backend run is still a valid (cheaper, weaker) data point.

## What it measures

Per spec: final verdict (`PASS`/`UNVERIFIED`/`FAIL`) + verified flag, judge
score, **first-pass rate** (did lint/verify/judge pass on iteration 1, no fix
needed), **fix iterations per stage**, **mutation score** (testbench
strength), SVA bound count, coverage, tokens, and estimated cost.

## Compare runs

```bash
node bench/run.mjs --diff=bench/results/new.json,bench/results/old.json
```

Prints both summaries and the per-metric delta (with ↑good / ↓worse direction,
so e.g. lower fix-iters and lower cost read as improvements).

## Layout

- `specs.mjs` — the golden suite (10 designs; add an entry to extend)
- `scorer.mjs` — pure: one `finalState` → metrics (unit-tested)
- `report.mjs` — pure: aggregate + diff + format (unit-tested)
- `run.mjs` — the runner (drives the pipeline, writes results, `--mock`/`--diff`)
- `results/` — per-SHA result JSON (gitignored; commit the ones worth tracking)

## Notes & honest limits

- The benchmark drives the **linear** pipeline (`runStages`), so K-to-X reflow
  chains take their legacy inline path. This keeps one `_llms` ledger per
  stage (no double-counted tokens) and fewer confounds when attributing a
  metric change to a prompt change — a deliberate simplification, not full
  fidelity to a GUI full-auto run.
- LLM generation is stochastic; run the suite a few times (or raise the spec
  count) before trusting a small delta. Pin a sampling seed per stage in
  config to reduce variance when comparing prompt-only changes.
- Results are environment-specific (model, Verilator version) — only diff runs
  produced under the same conditions.
