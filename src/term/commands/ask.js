// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/ask — Agentic chat surface
//
//   rtlforge ask "<prompt>" [--project <id>] [--mode build|plan]
//   rtlforge ask --interactive [--project <id>] [--mode build|plan]
//
// This is the opencode-equivalent layer: a tool-using LLM that can drive
// the rtlforge pipeline, read project state, and write updates. Unlike
// `rtlforge run` which auto-drives every stage, `ask` lets the user have
// a conversation with the agent — "look at my spec and tell me which
// requirements are ambiguous", "run the lint stage and explain the
// errors", "regenerate the testbench focusing on overflow tests".
//
// Two modes (matching opencode's build/plan distinction):
//
//   build (default) — full tool set. The agent can run pipeline stages,
//                     write elicit answers, etc. Mutating tools require
//                     user confirmation in TTY mode (skip with --yolo).
//
//   plan            — read-only. Mutating tools are HIDDEN from the
//                     agent — it doesn't see them in the API request,
//                     so it can't even attempt to call them. Useful for
//                     "explore my project", "explain these lint errors",
//                     "is my generated RTL synthesizable on Xilinx 7"
//                     without burning verify cycles.
//
// In the interactive REPL, switch modes mid-conversation:
//   /mode plan        — switch to plan
//   /mode build       — switch to build
//   /mode             — show current mode
//
// (We use a slash command rather than a Tab keypress because raw-mode
// terminal hijacking would conflict with readline's line-editing.)
//
// Currently scoped to the Anthropic provider — the tool-use protocol
// differs across OpenAI/Ollama/Anthropic enough that supporting all three
// well needs more code than fits in this slice. The infrastructure is
// here; OpenAI/Ollama can be added by switching on config.provider.
// ═══════════════════════════════════════════════════════════════════════════

import readline from "node:readline";
import { loadConfig, loadApiKey } from "../config.js";
import { createFsStorage } from "../fsStorage.js";
import { createStore } from "../store.js";
import { ALL_STAGES, getActiveStages, OPTIONAL_STAGE_DEFS } from "../../constants/stages.js";
import { c, ICON, heading } from "../format.js";

const VALID_MODES = new Set(["build", "plan"]);

function systemPromptFor(mode) {
  const base = [
    "You are RTL Forge, an agent that helps a hardware engineer design SystemVerilog modules through a multi-stage pipeline.",
    "",
    "The pipeline has 12 stages: elicit (1), spec (2), architect (3), rtl_generate (4), formal_props (5), lint (6), test_generate (7), verify (8), judge (9), rtl_review (10), test_review (11), lint_test (12). Stages run in `order` field order, not id order. Some are optional and may be disabled.",
    "",
    "Prefer reading state before acting; never invent module contents.",
    "",
    "If the user's request is ambiguous, ask one clarifying question rather than guessing. Keep your turns short — one tool call or one summary at a time, not an essay.",
  ];
  if (mode === "plan") {
    base.push("");
    base.push("YOU ARE IN PLAN MODE. You can only read project state — you cannot run pipeline stages, write spec answers, or modify anything. If the user wants you to make changes, tell them to switch to build mode with `/mode build` (or restart with --mode build for a one-shot).");
  } else {
    base.push("");
    base.push("You can run pipeline stages and write spec answers when the user has agreed. LLM stages take 10-60 seconds; verify with a real CLI backend can take minutes. Tell the user what you're doing before invoking. Summarize results concisely after.");
  }
  return base.join("\n");
}

// ── Tool definitions ──────────────────────────────────────────────────────

const TOOL_GET_STATUS = {
  name: "get_status",
  description: "Read the current state of all modules in this project. Returns each module's per-stage completion status and any error messages.",
  input_schema: { type: "object", properties: {}, required: [] },
};

const TOOL_LIST_STAGES = {
  name: "list_stages",
  description: "List the active pipeline stages in order, including which optional stages are enabled. Use this to understand which steps the project will run through.",
  input_schema: { type: "object", properties: {}, required: [] },
};

const TOOL_READ_MODULE = {
  name: "read_module",
  description: "Read parts of a module: 'spec', 'rtl', 'tb', 'verify', 'lint', 'judge', or 'all'. Returns the requested fields trimmed to a reasonable size.",
  input_schema: {
    type: "object",
    properties: {
      module: { type: "string", description: "Module id (e.g. 'fifo'). Use the active module if omitted." },
      fields: {
        type: "array",
        items: { type: "string", enum: ["spec", "rtl", "tb", "verify", "lint", "judge", "all"] },
        description: "Which fields to return.",
      },
    },
    required: ["fields"],
  },
};

const TOOL_RUN_STAGE = {
  name: "run_stage",
  description: "Invoke a pipeline stage. Stages cost LLM tokens; only run when the user has agreed. Verify with a real CLI backend can take minutes.",
  input_schema: {
    type: "object",
    properties: {
      stage:  { type: "string", description: "Stage key (e.g. 'rtl_generate', 'verify') or id (e.g. '4', '8')." },
      module: { type: "string", description: "Module id; uses active if omitted." },
    },
    required: ["stage"],
  },
};

const TOOL_WRITE_SPEC_ANSWER = {
  name: "write_spec_answer",
  description: "Answer an open elicit (stage 1) question on the user's behalf. The questionId comes from get_status or read_module(['spec']). Use only when the user has explicitly delegated this — otherwise ask the user directly. Writing an answer marks downstream stages stale, so the user will need to re-run from spec.",
  input_schema: {
    type: "object",
    properties: {
      questionId: { type: "string", description: "Id of the elicit question." },
      answer:     { type: "string", description: "Plain-text answer." },
      module:     { type: "string", description: "Module id; uses active if omitted." },
    },
    required: ["questionId", "answer"],
  },
};

const READ_TOOLS  = [TOOL_GET_STATUS, TOOL_LIST_STAGES, TOOL_READ_MODULE];
const WRITE_TOOLS = [TOOL_RUN_STAGE, TOOL_WRITE_SPEC_ANSWER];

function toolsForMode(mode) {
  if (mode === "plan") return READ_TOOLS;            // hide write tools entirely
  return READ_TOOLS.concat(WRITE_TOOLS);             // build mode = full set
}

const READONLY_TOOL_NAMES = new Set(READ_TOOLS.map(function(t) { return t.name; }));

function summarizeStageData(d, fields) {
  if (!d) return null;
  const picks = {};
  for (const k of fields) if (k in d) picks[k] = d[k];
  return picks;
}

async function confirmAction(prompt) {
  if (!process.stdin.isTTY) return false;
  return new Promise(function(resolve) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(c.yellow("? ") + prompt + " [y/N] ", function(ans) {
      rl.close();
      resolve(/^y(es)?$/i.test(String(ans).trim()));
    });
  });
}

/**
 * Execute a tool call. Returns a JSON-serializable tool result.
 *
 * IMPORTANT: this function trusts that the caller filtered the tool list
 * by mode — the agent shouldn't be ABLE to call a write tool from plan
 * mode because write tools aren't in the API request. But we add a
 * defense-in-depth check so a misconfigured caller can't bypass.
 */
async function executeTool(name, input, ctx) {
  const { store, yolo, mode } = ctx;

  // Defense in depth — if mode and tool list ever diverge, refuse
  // mutation here. The agent shouldn't have these tools listed in plan
  // mode, but a buggy caller could route through a stale message history.
  if (mode === "plan" && !READONLY_TOOL_NAMES.has(name)) {
    return { error: "plan_mode_blocked", message: "Cannot run " + name + " in plan mode." };
  }

  if (name === "get_status") {
    const state = store.getState();
    const out = { activeModId: state.activeModId, modules: {} };
    for (const [modId, mod] of Object.entries(state.modules || {})) {
      const completed = Array.from(mod.completed || []);
      const sd = mod.stageData || {};
      // Surface elicit question ids so the agent can call write_spec_answer
      const elicit = sd[1];
      const elicitQuestions = elicit && Array.isArray(elicit.questions)
        ? elicit.questions.map(function(q) { return { id: q.id, text: q.text || q.question || "", answered: !!(elicit.answers && elicit.answers[q.id]) }; })
        : null;
      out.modules[modId] = {
        completedStageIds: completed,
        stageErrors: mod.stageErrors || {},
        elicitQuestions: elicitQuestions,
        verify: sd[8] ? { pass: sd[8].pass, fail: sd[8].fail, total: sd[8].total } : null,
        judge:  sd[9] ? { verdict: sd[9].verdict || sd[9].overall } : null,
      };
    }
    return out;
  }

  if (name === "list_stages") {
    const config = (store && store.config) || {};
    const active = getActiveStages(config);
    const optional = config.optionalStages || {};
    return {
      activeStages: active.map(function(s) {
        return { id: s.id, key: s.key, label: s.label, optional: !!s.optional };
      }),
      optionalStages: Object.keys(OPTIONAL_STAGE_DEFS).map(function(k) {
        return { key: k, enabled: !!optional[k], label: OPTIONAL_STAGE_DEFS[k].label };
      }),
    };
  }

  if (name === "read_module") {
    const state = store.getState();
    const modId = input.module || state.activeModId;
    const mod = state.modules[modId];
    if (!mod) return { error: "no_such_module", module: modId };
    const sd = mod.stageData || {};
    const result = { modId: modId, fields: {} };
    const want = new Set(input.fields || []);
    if (want.has("all") || want.has("spec"))   result.fields.spec   = summarizeStageData(sd[2], ["requirements", "iface", "params"]);
    if (want.has("all") || want.has("rtl"))    result.fields.rtl    = sd[4] && { code: sd[4].code, _fixSource: sd[4]._fixSource };
    if (want.has("all") || want.has("tb"))     result.fields.tb     = sd[7] && { code: sd[7].code };
    if (want.has("all") || want.has("verify")) result.fields.verify = summarizeStageData(sd[8], ["pass", "fail", "total", "tests", "cli"]);
    if (want.has("all") || want.has("lint"))   result.fields.lint   = summarizeStageData(sd[6], ["status", "errors", "warnings"]);
    if (want.has("all") || want.has("judge"))  result.fields.judge  = summarizeStageData(sd[9], ["verdict", "overall", "summary"]);
    return result;
  }

  if (name === "run_stage") {
    const ref = input.stage;
    const stage = /^\d+$/.test(ref)
      ? ALL_STAGES.find(function(s) { return s.id === parseInt(ref, 10); })
      : ALL_STAGES.find(function(s) { return s.key === ref; });
    if (!stage) return { error: "unknown_stage", stage: ref };
    if (!yolo) {
      const ok = await confirmAction("agent wants to run stage " + c.bold(stage.label) + " — proceed?");
      if (!ok) return { error: "user_declined", message: "User declined to run this stage." };
    }
    const modName = input.module || store.getState().activeModId;
    if (!modName) return { error: "no_active_module" };
    try {
      const result = await store.runStage({
        stageId: stage.id, stageKey: stage.key,
        targetModId: modName, trigger: "agent",
      });
      try { await store.saveCheckpoint(); } catch (_) { /* best effort */ }
      return { ok: true, stageId: stage.id, result: result && result.ok };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  if (name === "write_spec_answer") {
    const state = store.getState();
    const modId = input.module || state.activeModId;
    const mod = state.modules[modId];
    if (!mod) return { error: "no_such_module", module: modId };
    const elicit = (mod.stageData || {})[1];
    if (!elicit) return { error: "no_elicit_data", message: "Module has no elicit (stage 1) data yet." };
    const questions = Array.isArray(elicit.questions) ? elicit.questions : [];
    const q = questions.find(function(qq) { return qq.id === input.questionId; });
    if (!q) {
      return { error: "unknown_question", questionId: input.questionId,
        knownIds: questions.map(function(qq) { return qq.id; }) };
    }
    if (!yolo) {
      const ok = await confirmAction(
        "agent wants to answer elicit question " + c.bold(input.questionId) +
        " (" + (q.text || q.question || "?").slice(0, 60) + ")\n" +
        "  with: " + JSON.stringify(input.answer).slice(0, 80) + " — proceed?");
      if (!ok) return { error: "user_declined" };
    }
    // Write the answer via MODULE_STAGE_DATA_MERGE, which preserves any other
    // elicit metadata while overlaying answers.
    const newAnswers = Object.assign({}, elicit.answers || {}, {
      [input.questionId]: input.answer,
    });
    store.dispatch({
      type: "MODULE_STAGE_DATA_MERGE", modId: modId, stageId: 1,
      data: { answers: newAnswers },
    });
    try { await store.saveCheckpoint(); } catch (_) { /* best effort */ }
    return {
      ok: true,
      questionId: input.questionId,
      totalAnswered: Object.keys(newAnswers).length,
      totalQuestions: questions.length,
      note: "Downstream stages should be re-run after answering — call run_stage on 'spec' next, or tell the user to.",
    };
  }

  return { error: "unknown_tool", name: name };
}

/**
 * Single message exchange with the Anthropic Messages API.
 */
async function anthropicTurn(messages, systemPrompt, tools, config, signal) {
  const url = "https://api.anthropic.com/v1/messages";
  const body = {
    model: config.model,
    system: systemPrompt,
    max_tokens: 2048,
    tools: tools,
    messages: messages,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Anthropic API " + res.status + ": " + text.slice(0, 400));
  }
  return await res.json();
}

export async function cmdAsk(args) {
  const config = loadConfig({ flags: args });
  if (config.provider !== "anthropic") {
    process.stderr.write(c.red("error:") + " `ask` currently requires provider=anthropic (got " + config.provider + ")\n");
    process.stderr.write("       OpenAI/Ollama tool-use parity is on the roadmap.\n");
    return 2;
  }
  const apiKey = loadApiKey("anthropic");
  if (!apiKey) {
    process.stderr.write(c.red("error:") + " no Anthropic API key. set with: rtlforge config login\n");
    return 2;
  }
  const runtimeConfig = Object.assign({}, config, { apiKey: apiKey });

  // Resolve mode — default build to match opencode's default.
  let mode = (args.mode || "build").toLowerCase();
  if (!VALID_MODES.has(mode)) {
    process.stderr.write(c.red("error:") + " --mode must be 'build' or 'plan' (got '" + mode + "')\n");
    return 2;
  }

  const projectId = args.project || null;
  const storage = createFsStorage();
  const store = createStore({ config: runtimeConfig, storage: storage, projectId: projectId });
  if (projectId) {
    const loaded = await store.loadCheckpoint();
    if (!loaded) {
      process.stderr.write(c.red("error:") + " no checkpoint for project " + projectId + "\n");
      return 1;
    }
  }

  const ctx = { store: store, yolo: !!args.yolo, mode: mode };
  const messages = [];

  const initial = args._.join(" ").trim();
  const interactive = !!args.interactive || !initial;

  process.stdout.write(heading("RTL Forge — agentic mode") + "\n");
  if (projectId) process.stdout.write(c.dim("project:  ") + projectId + "\n");
  process.stdout.write(c.dim("provider: ") + "anthropic / " + runtimeConfig.model + "\n");
  process.stdout.write(c.dim("mode:     ") + (mode === "plan" ? c.cyan("plan (read-only)") : c.green("build (full tools)")) + "\n");
  if (mode === "build" && !ctx.yolo) {
    process.stdout.write(c.dim("note: mutating tools require confirmation. pass --yolo to skip.") + "\n");
  }
  if (interactive) {
    process.stdout.write(c.dim("commands: /mode plan | /mode build | /mode") + "\n");
  }
  process.stdout.write("\n");

  async function runOneTurn(userText) {
    messages.push({ role: "user", content: userText });
    for (let safety = 0; safety < 8; safety++) {
      // Tool list re-resolves every turn so /mode commands take effect
      // mid-conversation. We snapshot ctx.mode here so the executeTool
      // call below sees the same value as the LLM request.
      const turnMode = ctx.mode;
      const toolsForTurn = toolsForMode(turnMode);
      const sysPrompt = systemPromptFor(turnMode);

      const resp = await anthropicTurn(messages, sysPrompt, toolsForTurn, runtimeConfig);
      const blocks = resp.content || [];
      messages.push({ role: "assistant", content: blocks });

      const toolUses = blocks.filter(function(b) { return b.type === "tool_use"; });
      const texts    = blocks.filter(function(b) { return b.type === "text"; });

      for (const t of texts) {
        if (t.text) process.stdout.write(c.brightBlue("agent:") + " " + t.text + "\n");
      }
      if (toolUses.length === 0) return;

      const toolResults = [];
      for (const tu of toolUses) {
        const isReadOnly = READONLY_TOOL_NAMES.has(tu.name);
        if (!isReadOnly && !ctx.yolo) {
          process.stdout.write(c.dim("  tool: ") + tu.name + " " + JSON.stringify(tu.input).slice(0, 80) + "\n");
        } else {
          process.stdout.write(c.dim("  tool: ") + tu.name + "\n");
        }
        // Pass the snapshot mode so an in-flight tool call doesn't get
        // confused if the user types /mode mid-execution.
        const result = await executeTool(tu.name, tu.input || {}, Object.assign({}, ctx, { mode: turnMode }));
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
    process.stderr.write(c.yellow("⚠") + " safety cap on tool-use loop reached (8 hops)\n");
  }

  /**
   * Handle a /command. Returns true if it was a slash command (consumed),
   * false if it should be passed to the agent as a normal message.
   */
  function handleSlash(line) {
    if (!line.startsWith("/")) return false;
    const parts = line.slice(1).trim().split(/\s+/);
    const cmd = parts[0];
    if (cmd === "mode") {
      const target = parts[1];
      if (!target) {
        process.stdout.write(c.dim("current mode: ") + ctx.mode + "\n");
        return true;
      }
      if (!VALID_MODES.has(target)) {
        process.stdout.write(c.red("invalid mode: ") + target + " (use 'build' or 'plan')\n");
        return true;
      }
      ctx.mode = target;
      process.stdout.write(c.green("✓ ") + "mode → " + (target === "plan" ? c.cyan("plan (read-only)") : c.green("build (full tools)")) + "\n");
      return true;
    }
    if (cmd === "help" || cmd === "?") {
      process.stdout.write([
        c.bold("REPL commands:"),
        "  /mode plan        switch to plan mode (read-only)",
        "  /mode build       switch to build mode (full tools)",
        "  /mode             show current mode",
        "  /help             this listing",
        "  blank line + Enter   send buffered prompt",
        "  Ctrl-D            exit",
        "",
      ].join("\n"));
      return true;
    }
    process.stdout.write(c.dim("unknown slash command: /") + cmd + "\n");
    return true;
  }

  if (initial) {
    try { await runOneTurn(initial); }
    catch (e) {
      process.stderr.write(c.red("✗") + " " + (e.message || e) + "\n");
      return 1;
    }
    if (!interactive) return 0;
  }

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(c.dim("type a prompt, blank line + Enter to send, /help for commands, Ctrl-D to exit") + "\n\n");
    let buffer = "";
    rl.setPrompt(c.green("you> "));
    rl.prompt();
    rl.on("line", async function(line) {
      // Slash commands work even with empty buffer and aren't sent to LLM.
      if (line.startsWith("/")) {
        handleSlash(line);
        rl.prompt();
        return;
      }
      if (line === "" && buffer === "") { rl.prompt(); return; }
      if (line === "") {
        const text = buffer; buffer = "";
        try { await runOneTurn(text); }
        catch (e) { process.stderr.write(c.red("✗") + " " + (e.message || e) + "\n"); }
        process.stdout.write("\n");
        rl.prompt();
        return;
      }
      buffer += (buffer ? "\n" : "") + line;
    });
    return new Promise(function(resolve) {
      rl.on("close", function() { process.stdout.write("\n"); resolve(0); });
    });
  }
  return 0;
}

// Exported for tests
export const _internal = {
  toolsForMode, executeTool, READONLY_TOOL_NAMES, VALID_MODES,
  TOOL_GET_STATUS, TOOL_LIST_STAGES, TOOL_READ_MODULE,
  TOOL_RUN_STAGE, TOOL_WRITE_SPEC_ANSWER,
  systemPromptFor,
};
