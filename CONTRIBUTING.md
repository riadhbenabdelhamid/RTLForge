# Contributing to RTL Forge

Thanks for your interest in improving RTL Forge! This document explains how to
set up, test, and submit changes.

## Contributor License Agreement (required)

RTL Forge is **dual-licensed** (AGPL-3.0-or-later + a commercial option). To
keep that possible, every contributor must agree to the
[Contributor License Agreement](CLA.md) before their contribution can be
merged. By opening a pull request you confirm that you have read and agree to
the CLA. In practice, add this line to your PR description (the PR template
includes a checkbox):

> I have read and agree to the Contributor License Agreement (CLA.md).

## Development setup

```bash
git clone <your-fork-url> rtl-forge
cd rtl-forge
npm install
```

Optional, for CLI-backed lint/verify:

- [Verilator](https://www.veripool.org/verilator/) (and optionally Yosys) on
  your `PATH`.
- Run the local backend during development: `node backend.js`
  (localhost-only — see [SECURITY.md](SECURITY.md)).

## Running the project

```bash
npm run dev               # web UI (Vite dev server)
./bin/rtlforge help       # terminal app
```

## Tests — run these before every PR

```bash
npm test         # Vitest suite (single-threaded, deterministic)
npm run verify   # dependency-free standalone verifiers + driver smoke test
```

Both must be green. If you add behavior, add coverage:

- Logic/back-end changes → a `*.test.js` under `tests/` and/or a check in the
  relevant `verify/verify*.mjs`.
- React component changes → a `*.test.jsx` under `tests/` and/or a structural
  check in the matching `verify/verify-*.mjs`.

## Coding guidelines

- **Match the surrounding style.** The codebase favors small, pure ES modules,
  explicit named exports, and `const`/`let` (no `var`).
- **No new runtime dependencies** without discussion — the core is
  intentionally dependency-light (the only runtime deps are React/React-DOM,
  for the web UI).
- **Keep secrets out.** Never commit API keys; `.env*` is gitignored. The
  checkpoint layer scrubs API keys by design — don't regress that.
- **Don't reintroduce provenance noise** in comments (version tags, ticket
  numbers, "extracted from X"). Comments should explain the *why* and stand on
  their own.
- Keep comments at the same density and altitude as the file you're editing.

## Commit & PR process

1. Branch off `main`.
2. Make focused commits with clear messages.
3. Ensure `npm test` and `npm run verify` pass locally.
4. Open a PR describing **what** changed and **why**, and confirm the CLA.
5. CI runs the same test suites on your PR; please keep it green.

## Reporting bugs / requesting features

Use the GitHub issue templates. For **security** issues, do **not** open a
public issue — follow the private process in [SECURITY.md](SECURITY.md).
