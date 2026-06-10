// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/cli — Entry point for the rtlforge terminal app
//
// Subcommands:
//   run       — drive the pipeline for one module
//   stage     — re-run a single stage in an existing project
//   resume    — alias for `run --resume <id>`
//   status    — show project state
//   export    — write artifacts to disk
//   config    — get/set config + login
//   ask       — agentic chat mode
//   version   — print version
//   help      — print this list
// ═══════════════════════════════════════════════════════════════════════════

import { parseArgs } from "./argv.js";
import { c } from "./format.js";

const VERSION = "6.0.0-term.1";

const HELP = [
  "rtlforge — terminal-native agentic hardware design",
  "",
  c.bold("USAGE"),
  "  rtlforge <command> [options]",
  "",
  c.bold("COMMANDS"),
  "  run \"<description>\"     drive the full pipeline for a new module",
  "  run --file <path>        ... reading the description from a file",
  "  run --resume <id>        continue a saved project",
  "  stage <id|key> --project <id>   re-run one stage",
  "  status [<id>]            list projects, or detail one",
  "  export <id> [--out <dir>]      write generated artifacts",
  "  ask \"<prompt>\"           agentic chat (Anthropic)",
  "  ask --interactive        agentic REPL (use /mode plan|build to switch)",
  "  ask --mode plan          read-only agentic mode (hides write tools)",
  "  skills list              list user/project skills (per workflow)",
  "  skills show <stage>      show body of skills targeting a stage",
  "  skills check [<stage>]   validate skills against pipeline invariants",
  "  skills new <stage>       create a starter skill file in your editor",
  "  skills path              print user + project skill directories",
  "  skills invariants        list all enforced skill invariants",
  "  skills workflows         list registered workflows",
  "  evals show               show eval criteria + thresholds (judge gate)",
  "  evals set <id> <f>=<v>   set enabled or threshold (e.g. verify_pass_rate threshold=90)",
  "  evals reset [<id>]       restore defaults (single criterion or all)",
  "  evals run --project <id> debug-run the gate against a saved project",
  "  evals criteria           list all registered criteria",
  "  observe show             observer KB summary (per workflow)",
  "  observe list             list captured observations",
  "  observe dismiss <id>     hide one event from the list",
  "  observe delete <id>      hard-delete an event",
  "  observe wipe             delete all events (asks for confirm)",
  "  observe path             print resolved DB path",
  "  observe import-browser <path.json>  merge browser observer events into SQLite",
  "  config show              print effective config",
  "  config get <key>         read one config value",
  "  config set <key> <val>   persist a config value",
  "  config login             store an API key in ~/.rtlforge/auth.json",
  "  config path              show config + auth file paths",
  "  version                  print version",
  "  help                     this listing",
  "",
  c.bold("COMMON FLAGS"),
  "  --project <id>           target project id (status/stage/export/ask)",
  "  --module <name>          module to act on (default: active)",
  "  --no-color               disable ANSI colors (or set NO_COLOR)",
  "  --no-checkpoint          don't persist run progress (run only)",
  "  --provider <p>           override config.provider",
  "  --model <m>              override config.model",
  "",
  c.bold("ENV"),
  "  RTLFORGE_HOME            override ~/.rtlforge",
  "  RTLFORGE_API_KEY         provider-agnostic key (highest precedence)",
  "  ANTHROPIC_API_KEY etc.   per-provider keys",
  "  RTLFORGE_PROVIDER        override config.provider",
  "  RTLFORGE_MODEL           override config.model",
  "  RTLFORGE_BACKEND_URL     override config.backendUrl",
  "  NO_COLOR                 disable ANSI colors",
  "",
  c.bold("EXAMPLES"),
  "  rtlforge config login",
  "  rtlforge run \"4-deep async fifo with full/empty flags\"",
  "  rtlforge status",
  "  rtlforge stage verify --project 3a8b1c",
  "  rtlforge ask --project 3a8b1c \"explain the lint errors\"",
  "",
].join("\n");

const COMMANDS = {
  run:     async function() { return (await import("./commands/run.js")).cmdRun;       },
  stage:   async function() { return (await import("./commands/stage.js")).cmdStage;   },
  status:  async function() { return (await import("./commands/status.js")).cmdStatus; },
  export:  async function() { return (await import("./commands/export.js")).cmdExport; },
  config:  async function() { return (await import("./commands/config.js")).cmdConfig; },
  ask:     async function() { return (await import("./commands/ask.js")).cmdAsk;       },
  skills:  async function() { return (await import("./commands/skills.js")).cmdSkills; },
  evals:   async function() { return (await import("./commands/evals.js")).cmdEvals;   },
  observe: async function() { return (await import("./commands/observe.js")).cmdObserve; },
};

const ALIASES = {
  resume: "run",   // `rtlforge resume <id>` → `rtlforge run --resume <id>`
  ls:     "status",
};

const BOOL_FLAGS = [
  "no-color", "no-checkpoint", "semi", "interactive", "yolo",
  "help", "version",
];

const SHORT_ALIASES = {
  h: "help",
  v: "version",
  o: "out",
  p: "project",
  m: "module",
  i: "interactive",
};

export async function main(argv) {
  const args = argv || process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "version" || args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  let cmd = args[0];
  let rest = args.slice(1);

  // Aliases that translate the verb plus optionally inject flags
  if (ALIASES[cmd]) {
    if (cmd === "resume") {
      const id = rest[0];
      if (!id) {
        process.stderr.write(c.red("error:") + " usage: rtlforge resume <projectId>\n");
        return 2;
      }
      rest = ["--resume", id].concat(rest.slice(1));
    }
    cmd = ALIASES[cmd];
  }

  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write(c.red("error:") + " unknown command: " + cmd + "\n");
    process.stderr.write("       run `rtlforge help` for a list\n");
    return 2;
  }

  // NO_COLOR support via flag too
  const flagArgs = parseArgs(rest, { boolFlags: BOOL_FLAGS, aliases: SHORT_ALIASES });
  if (flagArgs["no-color"]) process.env.NO_COLOR = "1";

  try {
    const fn = await loader();
    const code = await fn(flagArgs);
    return code == null ? 0 : code;
  } catch (e) {
    process.stderr.write(c.red("✗ unexpected error: ") + (e && e.stack ? e.stack : String(e)) + "\n");
    return 1;
  }
}

// Allow this module to run standalone if invoked via `node src/term/cli.js`.
// The bin/rtlforge shim does the same import + call.
if (import.meta.url === ("file://" + (process.argv[1] || ""))) {
  main().then(function(code) { process.exit(code); });
}
