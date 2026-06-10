# Security Policy

## ⚠️ Important: the local backend executes arbitrary shell commands

RTL Forge ships an optional local backend (`backend.js`) that bridges the
browser UI to CLI tools such as Verilator and Yosys. **By design, the
`/api/execute` endpoint runs shell commands with no authentication.** It is a
developer convenience for running the toolchain on your own machine — it is
**not** a hardened, multi-tenant service.

Treat the backend like running a shell on your own box:

- **Bind to localhost only.** It defaults to `HOST=127.0.0.1`. Do **not** set
  `HOST=0.0.0.0` or expose the port to a LAN/public network unless you fully
  understand that anyone who can reach it can run arbitrary commands as your
  user.
- **Do not run it on a shared or production host.**
- **CORS is restricted** to localhost origins by default (`ALLOW_ORIGIN`).
  Loosening it (`ALLOW_ORIGIN=*`) re-opens the surface — only do so knowingly.
- Filenames passed to the backend are sanitized (`backend/sanitize.js`), and
  request bodies are size-bounded, but the command-execution surface remains
  inherently powerful.

If you need a deployable multi-user setup, you must add your own
authentication, sandboxing (e.g. containers/jails), and command allow-listing
in front of the backend.

## API keys

RTL Forge never persists your LLM API key to disk or checkpoints. Provide it at
runtime (Settings → LLM, or the relevant environment variable). Do not commit
keys to the repository; `.env` files are gitignored.

## Reporting a vulnerability

If you discover a security issue, please report it privately by email to
**riadh.benabdelhamid@gmail.com** rather than opening a public issue. Include a
description, reproduction steps, and impact. You can expect an initial response
within a reasonable timeframe; please allow time for a fix before public
disclosure.
