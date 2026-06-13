# RTL Forge benchmark

Empirical measurement of pipeline quality, so prompt and loop changes get a
**number** instead of a vibe. Runs a golden suite of canonical designs
end-to-end and scores each run; diff two runs to see whether a change helped.

## Run it

### Configuration

The runner reuses the **same config as the `rtlforge` CLI**, so anything you've
already set up just works. Resolution chain (later wins):

```
defaults → ~/.rtlforge/config.json → ./.rtlforge.json → RTLFORGE_* env → CLI flags
```

So if you've run `rtlforge config login` and `rtlforge config set backendUrl
http://localhost:3001`, plain `npm run bench` picks up your model, key, and
backend. The header prints exactly what it resolved (provider, model, backend,
gates) — check it before a long run.

```bash
npm run bench                                    # uses your ~/.rtlforge config

# Local LLM (LM Studio / Ollama) + your running backend, via env:
RTLFORGE_PROVIDER=lmstudio RTLFORGE_MODEL=qwen2.5-coder-32b \
RTLFORGE_BACKEND_URL=http://localhost:3001 npm run bench

# …or via flags (flags beat env beat config file):
npm run bench -- --provider=ollama --model=qwen2.5-coder --backend=http://localhost:3001
npm run bench -- --baseurl=http://localhost:1234/v1   # custom local-LLM port

npm run bench -- --spec=fifo_sync,uart_rx        # a subset
npm run bench -- --baseline=bench/results/<old>.json   # run + diff vs baseline
npm run bench:mock                               # offline self-test (no LLM/backend)
```

Flag → config key: `--provider`, `--model`, `--apikey`, `--backend`→`backendUrl`,
`--baseurl`→`baseUrl`. Local providers default to LM Studio `:1234` / Ollama
`:11434`; override the port with `--baseurl` (or `baseUrl` in your config).

A **CLI backend** (`backendUrl`) is what makes the verify, mutation, and SVA
numbers real, and turns the measurement gates (`svaInSim`, `mutationTesting`)
ON automatically. Without one, verify falls back to LLM-estimated results and
judge caps at `UNVERIFIED` — the scorer records that faithfully, so a
no-backend run is still a valid (cheaper, weaker) data point. If `backend.js`
is running but the header still says "none", you haven't pointed bench at it —
set `backendUrl` by any of the means above (the default port is `3001`).

> Note: `npm run bench` needs `--` before flags (`npm run bench -- --spec=…`);
> env vars don't.

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
