# RTL Forge

[![CI](https://github.com/riadhbenabdelhamid/RTLForge/actions/workflows/ci.yml/badge.svg)](https://github.com/riadhbenabdelhamid/RTLForge/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

> Natural language → verified SystemVerilog, via a multi-stage LLM pipeline.

RTL Forge turns a plain-English hardware description into synthesizable,
lint-clean, simulation-verified SystemVerilog. It drives an LLM through a
12-stage StateGraph pipeline — elicit, spec, architect, generate, review,
lint, formal properties, testbench, verify, judge — with classifier-gated fix
loops and informed re-flow when a stage fails. It handles a single module, or
decomposes a whole system into modules and integrates them.

Three surfaces sit on one modular ES-module core:

- a **web UI** (React + Vite),
- a **terminal app** (`rtlforge`, including an agentic `ask` mode), and
- an **importable library** (subpath exports under `rtl-forge/*`).

The backend pipeline — every prompt builder, every pipeline node, the
StateGraph engine, the orchestration glue, the pure state reducer and
checkpoint layer — lives in dependency-light ES modules and is covered by both
a Vitest suite and a set of dependency-free standalone verifiers.

## License

RTL Forge is **dual-licensed**:

- **Open source — AGPL-3.0-or-later.** Free to use, study, modify, and share
  under the [GNU Affero General Public License v3.0](LICENSE). Note the
  network clause: if you run a modified version to provide a service over a
  network, you must offer that version's source to its users.
- **Commercial.** If AGPL copyleft (including the network/SaaS clause) doesn't
  fit — e.g. you want to embed RTL Forge in a proprietary product or hosted
  service without releasing your source — a separate commercial license is
  available. Contact **riadh.benabdelhamid@gmail.com**.

Copyright © 2026 Riadh Ben Abdelhamid.

## Security

RTL Forge includes an optional local backend that executes shell commands
(Verilator / Yosys) **with no authentication**, intended for localhost
developer use only. Read **[SECURITY.md](SECURITY.md)** before exposing it to
any network.

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. Because
RTL Forge is dual-licensed, contributors must agree to the
[Contributor License Agreement](CLA.md), which is what lets the project be
offered under both the AGPL and a commercial license. Before submitting, run
the test suites:

```bash
npm test        # Vitest suite
npm run verify  # standalone verifiers + driver smoke test
```

All participants are expected to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Subsystem docs

- **[Skills](docs/skills.md)** — user style rules that bias LLM calls per stage
- **[Evals](docs/evals.md)** — deterministic judge gate with 20 user-tunable criteria
- **[Themes](docs/themes.md)** — proxy-singleton theme system with 5 themes incl. customizable futuristic
- **[Observer](docs/observer.md)** — optional knowledge-base agent over SQLite

## Quick start

```bash
git clone https://github.com/riadhbenabdelhamid/RTLForge.git
cd RTLForge
npm install

npm run dev      # web UI (Vite dev server)
# or the terminal app:
./bin/rtlforge run "a synchronous FIFO with 8-bit data and depth 16"
```

You'll need an LLM API key (Anthropic, OpenAI/Groq, or a local Ollama/LM Studio
endpoint). For CLI-backed lint/verify you'll also want
[Verilator](https://www.veripool.org/verilator/) (and optionally Yosys) on your
`PATH`, plus the local backend running (see **Security** above).

## Layout

```
src/
├── constants/
│   ├── theme.js              TH palette + PRI_C
│   ├── stages.js             ALL_STAGES + helpers + MAX_*_ITERS
│   ├── providers.js          PROVIDERS + RECOMMENDED_STAGE_SETTINGS + getStageConfig
│   └── index.js
├── utils/
│   ├── hash.js               djb2 + computeInterfaceSignature
│   ├── levenshtein.js        Optimized rolling-row implementation
│   ├── constraints.js        deriveConstraints + buildAutoAssumptionsSVA
│   ├── library.js            isInterfaceCompatible + matchLibrary
│   └── index.js
├── llm/
│   ├── extractJSON.js        Robust JSON extraction + addRetryHint
│   ├── cost.js               estimateCost per provider
│   ├── sse.js                SSE stream reader
│   ├── callLLM.js            Main dispatch + retry wrapper
│   ├── providers/
│   │   ├── anthropic.js
│   │   ├── openai.js         (also handles Groq)
│   │   └── ollama.js
│   └── index.js
├── cli/
│   ├── runCli.js             Backend executor + parseCLIOutput
│   └── index.js
├── pipeline/
│   ├── StateGraph.js         Minimal node graph engine
│   ├── classifiers.js        matchDiagnostic + classifyDiagnostics + classifyTestResults
│   ├── buildPipeline.js      Factory wiring all 11 nodes
│   ├── runStages.js          Linear executor + stageKeysFromActive helper
│   ├── fixLoopHelpers.js     createStagnationDetector + createBestKnownTracker + tagFixes
│   ├── reflowPlanner.js      planReflow / planStageReflow (K-to-X re-flow)
│   ├── reflowRunner.js       runReflowChain
│   ├── nodes/
│   │   ├── elicit.js         elicitNode — Stage 1
│   │   ├── spec.js           specNode — Stage 2 (elicit-driven + full-auto)
│   │   ├── architect.js      architectNode — Stage 3
│   │   ├── rtl_generate.js   rtlGenerateNode — Stage 4
│   │   ├── rtl_review.js     rtlReviewNode — Stage 4b (with fix loop)
│   │   ├── formal_props.js   formalPropsNode — Stage 5 (merges auto-assumptions)
│   │   ├── lint.js           lintNode — Stage 6 (CLI fallback + classifier gating + stagnation)
│   │   ├── test_generate.js  testGenerateNode — Stage 7
│   │   ├── test_review.js    testReviewNode — Stage 7b (with fix loop)
│   │   ├── verify.js         verifyNode — Stage 8 (CLI fallback + triage routing)
│   │   ├── judge.js          judgeNode — Stage 9 (triage to spec/RTL/TB + best-known restore)
│   │   └── index.js
│   └── index.js
├── prompts/
│   ├── base.js               BASE_SYS + sys() + j()
│   ├── elicit.js             promptElicit
│   ├── spec.js               promptSpec + promptSpecFromDescription
│   ├── architect.js          promptArch
│   ├── rtl.js                promptRTL
│   ├── rtlReview.js          promptRTLReview + promptRTLReviewFix
│   ├── formalProps.js        promptFormalProps (with clock/reset analysis)
│   ├── lint.js               promptLint + promptRTLFix
│   ├── testGen.js            promptTB
│   ├── testReview.js         promptTestReview + promptTestReviewFix
│   ├── verify.js             promptVerify + Triage + RTLFromFail + TBFromFail
│   ├── judge.js              promptJudge + promptJudgeTriage
│   ├── decompose.js          promptDecompose (single|multi + forceMulti)
│   ├── sharedPackage.js      promptSharedPackage
│   ├── integration.js        promptIntegrationLint + SystemTB + IntegrationJudge
│   ├── propagate.js          promptPropagateSpec
│   └── index.js
├── projectState/
│   ├── moduleRegistry.js     blankModule + computeContentHash + computeIfaceHash
│   ├── dependencyGraph.js    getModuleOrder (Kahn) + computeEffectiveLevels (BFS)
│   ├── childInterfaces.js    buildChildInterfaces (with explicit args)
│   ├── stageFrontier.js      computeStageFrontier (module-state aware)
│   ├── actions.js            action type constants + stageRun actions
│   ├── reducer.js            projectReducer + createInitialProjectState
│   ├── checkpoint.js         serialize/deserialize + apiKey scrub
│   ├── storage.js            createMemoryStorage + cloud + localStorage adapters
│   ├── checkpointManager.js  save/load/list/remove/clear factory
│   ├── runStage.js           single-stage pure async executor
│   ├── runAllPipelines.js    multi-module topological orchestrator
│   ├── runIntegrationPipeline.js  int_lint/int_test/int_judge driver
│   └── index.js
├── react/
│   ├── useProject.jsx        React hook binding the core to useReducer
│   └── components/
│       ├── atoms.jsx         atomic UI primitives
│       ├── stages.jsx        8 stage components (Elicit/Spec/Arch/FormalProps + Lint/Verify/Judge/Review)
│       ├── workflow.jsx      WorkflowTab — pipeline editor with SVG flow graph + prompt section editor
│       ├── panels.jsx        SplitCodeView + ResumeDialog + SettingsPanel + DecompReview
│       └── RTLForge.jsx      root component
└── index.js                  Top-level barrel
```

## Tests

```bash
npm install     # one-time, installs vitest
npm test        # full Vitest suite (single-threaded; deterministic)
```

Or, without installing anything (uses Node's built-in `assert`):

```bash
npm run verify          # runs every standalone verifier + the driver smoke test
# or individually, e.g.:
node verify.mjs          # standalone backend verification
node verify-stages.mjs   # React stage components structural verification
node driver-smoke.mjs    # driver end-to-end integration
```

The React verifiers (`verify-atoms.mjs`, `verify-stages.mjs`, …) compile their
JSX targets through a one-shot `npx esbuild` invocation (the first run fetches
esbuild; later runs are offline-cached) and import the compiled module with a
local React-hook shim, so they can inspect the returned element trees without a
full React runtime. The walker recursively invokes component functions with
their props, making atom-level rendered text visible to the `findByText`
helper — which lets the harness test composed UIs that layer atoms inside
stage components.

Coverage spans the LLM transport and JSON extraction, the diagnostic/test
classifiers, every prompt builder, all pipeline nodes (including fix loops and
stagnation detection), the orchestration layer, the pure reducer and its
immutability invariants, checkpoint serialization (incl. API-key-leak
prevention), the single-stage and multi-module drivers, the K-to-X reflow
planner/runner, and the React component layer.

## Standalone usage example

The modular core is genuinely standalone — you can drive the entire pipeline
from Node with no React, no DOM, no browser:

```js
import { buildPipeline, runStages, stageKeysFromActive } from "rtl-forge/pipeline";
import { getActiveStages } from "rtl-forge/constants";

const pipeline  = buildPipeline();
const stageKeys = stageKeysFromActive(getActiveStages({}));

const finalState = await runStages(pipeline, stageKeys, {
  _userDesc: "a synchronous FIFO with 8-bit data and depth 16",
  _config: {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 3,
  },
  _onLog: (txt) => process.stdout.write("."),
}, {
  onStageComplete: (key) => console.log("\n✓ " + key),
});

console.log("Final verdict:", finalState.judge.overall, "score:", finalState.judge.score);
```

## Terminal app: `rtlforge`

The same pipeline, the same checkpoint format, the same project state — driven
from a terminal instead of the GUI. Install:

```sh
npm install -g .          # globally, from the source tree
# or, for a local checkout:
npm install
./bin/rtlforge help
```

### One-time setup

```sh
rtlforge config login                   # paste your Anthropic API key
# or use an env var instead:
export ANTHROPIC_API_KEY=sk-...
# or the provider-agnostic shortcut:
export RTLFORGE_API_KEY=sk-...
```

API keys are stored in `~/.rtlforge/auth.json` with file mode `0600`. The
config file (`~/.rtlforge/config.json`, mode 0644) is kept separate and
never contains credentials. Both paths can be relocated by setting
`$RTLFORGE_HOME`.

### Common commands

```sh
# Drive the full pipeline for a new module
rtlforge run "4-deep async FIFO with full/empty flags"
rtlforge run --file specs/uart_rx.txt --module uart_rx

# List saved projects, then look at one in detail
rtlforge status
rtlforge status 7f3c1b

# Continue an in-progress run (or one that errored partway)
rtlforge run --resume 7f3c1b
rtlforge resume 7f3c1b                  # alias

# Re-run a single stage in an existing project
rtlforge stage verify --project 7f3c1b
rtlforge stage 8 --project 7f3c1b       # by id

# Stop the pipeline at a specific stage
rtlforge run "..." --until lint
rtlforge run "..." --stage rtl_generate

# Write generated artifacts to disk
rtlforge export 7f3c1b --out ./generated/
# Writes: <module>.sv, <module>_tb.sv, <module>_sva.json,
#         <module>.spec.json, <module>.report.txt

# Configure pipeline knobs
rtlforge config get maxLintIters
rtlforge config set maxLintIters 5
rtlforge config set optionalStages.formal_props true
rtlforge config show
```

### Agentic mode: `rtlforge ask`

A conversational, tool-using LLM that drives the same pipeline. Two modes:

- `--mode build` *(default)* — full tool set. The agent can call
  `get_status`, `list_stages`, `read_module`, `run_stage`, and
  `write_spec_answer`. Mutating tools require user confirmation in a
  TTY unless `--yolo` is passed.
- `--mode plan` — read-only. The mutating tools are **hidden from the
  agent entirely** (they don't appear in the API request, so the agent
  can't even attempt them). Use this for "explore my project", "explain
  these lint errors", "is this RTL synthesizable on Xilinx 7-series" —
  questions that should never burn verify cycles or mutate state.

```sh
# One-shot (defaults to build mode)
rtlforge ask --project 7f3c1b "explain the lint errors"

# Explicit plan mode — agent gets no write tools
rtlforge ask --mode plan --project 7f3c1b "audit my testbench coverage"

# Interactive REPL (blank line + Enter sends each prompt)
rtlforge ask --interactive --mode build --project 7f3c1b
```

In the REPL you can switch modes mid-conversation with slash commands —
the read-only/full-tool toggle takes effect on the next user turn:

```
you> /mode plan
✓ mode → plan (read-only)

you> read my generated RTL and tell me what could be improved


you> /mode build
✓ mode → build (full tools)

you> good. now run the lint stage and show me what changes
```

Available REPL slash commands: `/mode plan`, `/mode build`, `/mode`
(show current), `/help`. Defense in depth: even if the tool list and
mode somehow diverge (stale message history, buggy override), the
executor double-checks at call time and returns `plan_mode_blocked`
rather than mutating.

`ask` currently requires `provider=anthropic` (the tool-use protocol
differs across providers; OpenAI/Ollama parity is on the roadmap).

### Environment reference

| Variable | Effect |
|---|---|
| `RTLFORGE_HOME` | override `~/.rtlforge` |
| `RTLFORGE_API_KEY` | provider-agnostic key (highest precedence) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | per-provider keys |
| `RTLFORGE_PROVIDER` | override `config.provider` |
| `RTLFORGE_MODEL` | override `config.model` |
| `RTLFORGE_BACKEND_URL` | override `config.backendUrl` (verilator CLI bridge) |
| `RTLFORGE_MAX_LINT_ITERS` | override `config.maxLintIters` |
| `RTLFORGE_MAX_VERIFY_ITERS` | override `config.maxVerifyIters` |
| `RTLFORGE_STRICT_CLI` | override `config.strictCli` (`true`/`false`) |
| `NO_COLOR` | disable ANSI color output (also `--no-color`) |

Resolution order (later beats earlier): defaults → `~/.rtlforge/config.json`
→ `./.rtlforge.json` (project-local) → environment variables → CLI flags.

### Cross-surface workflow

The terminal and GUI share the checkpoint format. A project started in the
GUI shows up in `rtlforge status`; a project run from the terminal can be
loaded into the GUI by pasting the project id into "Resume project". Both
write to `~/.rtlforge/projects/`.

### Architecture

The terminal app is a thin layer over the pipeline kernel:

```
src/term/                      ← terminal-app surface
├── cli.js                     ← argv dispatcher
├── argv.js                    ← minimal flag parser (no deps)
├── config.js                  ← ~/.rtlforge/{config.json, auth.json}
├── fsStorage.js               ← atomic file-system checkpoint adapter
├── format.js                  ← ANSI styling, table renderer
├── progress.js                ← live multi-stage progress (TTY + non-TTY)
├── store.js                   ← headless project store (reducer + dispatch)
└── commands/
    ├── run.js                 ← drive the full pipeline
    ├── stage.js               ← re-run one stage
    ├── status.js              ← list / detail projects
    ├── export.js              ← write artifacts to disk
    ├── config.js              ← get/set/show + login
    └── ask.js                 ← agentic chat (Anthropic tool-use)
src/projectState/, src/pipeline/, src/llm/, src/cli/, src/prompts/
                               ← shared with the GUI
```

Both surfaces drive the same `runStage` / `runAllPipelines` / reducer.

## React integration

The core ships a React hook at `src/react/useProject.jsx` that wires the
reducer, checkpoint layer, and drivers to a React component tree. A UI imports
and consumes it via a single hook call.

The hook is **not** re-exported from the top-level `./src/index.js` barrel —
doing so would force every non-React consumer (Node CLI, smoke tests, CI) to
carry React as a peer dependency. Consumers who want the hook import it
explicitly:

```jsx
import { useProject } from "rtl-forge/react";
import { callLLM, extractJSON, estimateCost } from "rtl-forge/llm";
import { promptSharedPackage } from "rtl-forge";

function App() {
  // Inject LLM transport via opts — keeps the hook file React-only and
  // lets tests swap callLLM for a mock without rebuilding the hook.
  const p = useProject({
    callLLM, extractJSON, estimateCost, promptSharedPackage,
  });

  return (
    <div>
      <input value={p.userDesc} onChange={(e) => p.setUserDesc(e.target.value)} />
      <button
        disabled={p.processing}
        onClick={() => p.launchSingleModule(p.userDesc)}
      >
        Launch
      </button>
      {p.activeMod && p.activeMod.stageData[p.viewingStage] && (
        <StageView
          data={p.activeMod.stageData[p.viewingStage]}
          onRun={() => p.runStage(p.viewingStage)}
          onAbort={p.abortCurrentStage}
        />
      )}
      <LedgerPanel totals={p.ledgerTotals} entries={p.state.ledger} />
    </div>
  );
}
```

**What the hook owns:**

- `useReducer(projectReducer, createInitialProjectState)` for all transactional
  project state (modules, instances, ledger, phase, integration, checkpoint)
- `useState` for UI-side ancillary state that doesn't need reducer semantics
  (userDesc buffer, config, mode, designMode, navigation, processing spinner)
- A `stateRef` synced on every render so async drivers see fresh state
- Singleton pipeline, singleton checkpoint manager, and an abort controller
  for in-flight stages
- A memoized services bag that the drivers consume
- Memoized derived values: `activeStages`, `isMultiModule`, `allModulesComplete`,
  `ledgerTotals`, `activeMod`

**Action methods exposed on the returned object:**

| Method | What it does |
|--------|--------------|
| `runStage(stageId, trigger?, overrideDesc?)` | Run one stage against the active module |
| `runAllPipelines(execMode?)` | Drive every module through every stage (full-auto) or run the first stage on the first module (semi-auto) |
| `runIntegrationPipeline()` | Run int_lint → int_test → int_judge for multi-module systems (idempotent via contentHash diffing) |
| `abortCurrentStage()` | Cancel the in-flight stage via AbortController |
| `proceed()` | Move forward one stage (semi-auto) or run all remaining (full-auto) |
| `switchModule(modId)` | Change the active module and set sensible activeStage/viewingStage |
| `launchSingleModule(description)` | Convenience launcher for single-module mode |
| `saveCheckpointNow()` | Serialize + persist current state |
| `resumeFromCheckpoint(projectIdOrPayload)` | Load state from storage and hydrate reducer + UI fields |
| `listCheckpoints()` | Fetch the checkpoint index for resume UI |
| `resetProject()` | Clear everything |
