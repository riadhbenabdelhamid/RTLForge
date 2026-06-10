// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/commands/config — Manage user-global config and credentials
//
// Subcommands:
//   rtlforge config show
//   rtlforge config get <key>
//   rtlforge config set <key> <value>
//   rtlforge config path
//   rtlforge config login [--provider <name>]
// ═══════════════════════════════════════════════════════════════════════════

import readline from "node:readline";
import {
  loadConfig, saveUserConfig, saveApiKey, loadApiKey,
  userConfigPath, userAuthPath,
} from "../config.js";
import { c } from "../format.js";

/**
 * Parse a value string into the right type for a config key. We don't
 * have a schema, so we keep this conservative: "true"/"false" → boolean,
 * pure-digit → number, JSON-parseable → JSON, otherwise raw string.
 */
function coerceValue(raw) {
  if (raw === "true")  return true;
  if (raw === "false") return false;
  if (raw === "null")  return null;
  if (/^-?\d+$/.test(raw))      return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) ||
      (raw.startsWith("[") && raw.endsWith("]"))) {
    try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  }
  return raw;
}

/**
 * Set a possibly-dotted key path on the config object. Returns the
 * updated config (mutated).
 */
function setKeyPath(cfg, dottedKey, value) {
  const parts = dottedKey.split(".");
  let target = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] == null || typeof target[parts[i]] !== "object") {
      target[parts[i]] = {};
    }
    target = target[parts[i]];
  }
  target[parts[parts.length - 1]] = value;
  return cfg;
}

function getKeyPath(cfg, dottedKey) {
  const parts = dottedKey.split(".");
  let cur = cfg;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

async function promptHidden(prompt) {
  // Minimal hidden-input prompt — flips raw mode and masks input. Works
  // on most terminals; falls back to plain readline if raw mode is N/A.
  return new Promise(function(resolve) {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const supportsRaw = typeof stdin.setRawMode === "function" && stdin.isTTY;
    if (!supportsRaw) {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question("", function(answer) { rl.close(); resolve(answer); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let answer = "";
    function onData(ch) {
      // ch can be a single byte or a paste of many
      for (const c1 of ch) {
        if (c1 === "\r" || c1 === "\n") {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(answer);
          return;
        }
        if (c1 === "\u0003") {  // Ctrl+C
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (c1 === "\u007f" || c1 === "\b") {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          answer += c1;
          process.stdout.write("*");
        }
      }
    }
    stdin.on("data", onData);
  });
}

export async function cmdConfig(args) {
  const sub = args._[0] || "show";

  if (sub === "show") {
    const cfg = loadConfig();
    process.stdout.write(c.bold("Effective config") + " " + c.dim("(file + env + defaults)") + "\n");
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return 0;
  }

  if (sub === "path") {
    process.stdout.write(c.bold("user config:") + " " + userConfigPath() + "\n");
    process.stdout.write(c.bold("user auth:  ") + " " + userAuthPath() + "\n");
    return 0;
  }

  if (sub === "get") {
    const key = args._[1];
    if (!key) {
      process.stderr.write(c.red("error:") + " missing key. usage: rtlforge config get <key>\n");
      return 2;
    }
    const cfg = loadConfig();
    const v = getKeyPath(cfg, key);
    if (v === undefined) {
      process.stdout.write(c.dim("(unset)") + "\n");
      return 1;
    }
    process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\n");
    return 0;
  }

  if (sub === "set") {
    const key = args._[1];
    const rawVal = args._[2];
    if (!key || rawVal === undefined) {
      process.stderr.write(c.red("error:") + " usage: rtlforge config set <key> <value>\n");
      return 2;
    }
    if (key === "apiKey" || key.endsWith(".apiKey")) {
      process.stderr.write(c.red("error:") + " API keys go in auth.json — use `rtlforge config login`\n");
      return 2;
    }
    // Load only files (not env) so saving doesn't preserve env-injected values
    const cfg = loadConfig({ skipFiles: false });
    setKeyPath(cfg, key, coerceValue(rawVal));
    const saved = saveUserConfig(cfg);
    process.stdout.write(c.green("✓") + " saved " + key + " → " + saved + "\n");
    return 0;
  }

  if (sub === "login") {
    const provider = args.provider || "anthropic";
    const existing = loadApiKey(provider);
    if (existing) {
      process.stdout.write(c.dim("note: an API key for " + provider + " is already configured (env var or auth.json).") + "\n");
    }
    const key = await promptHidden("Paste API key for " + c.bold(provider) + ": ");
    if (!key.trim()) {
      process.stderr.write(c.red("error:") + " empty key, nothing saved\n");
      return 2;
    }
    const path = saveApiKey(provider, key.trim());
    process.stdout.write(c.green("✓") + " key saved to " + path + " (mode 0600)\n");
    return 0;
  }

  process.stderr.write("unknown subcommand: " + sub + "\n");
  process.stderr.write("try: show, get, set, path, login\n");
  return 2;
}
