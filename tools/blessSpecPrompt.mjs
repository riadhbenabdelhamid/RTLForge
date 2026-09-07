// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
//
// Bless a deliberate spec-prompt change in the recorded run corpora.
//
// The whole-run replay keys each recorded answer by a hash of the prompt, so an
// intentional prompt edit surfaces as a REPLAY MISS — "re-record or bless".
// Re-recording is not available here: the corpora were captured against a model
// this machine does not have, so a fresh recording would replace the baseline
// rather than preserve it.
//
// Blessing keeps the recorded ANSWER and updates only its key. The run replays
// with exactly the model output it always used; what changes is the prompt that
// output is filed under. That is sound only when the edit does not ask for
// different content — here the new "src" field is optional, absent from every
// recorded answer, and the traceability check treats a missing src as unknown
// rather than uncited, so the replayed verdict must come out identical. Verify
// that afterwards with the suite; this script does not assert it for you.
//
// Guardrails: a rename happens only when the parked prompt is recognisably the
// spec prompt AND the answer being renamed is a spec answer (requirements +
// iface). Anything else is left alone and reported.
//
// Usage: node tools/blessSpecPrompt.mjs [--apply]   (dry run by default)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPORA = path.join(REPO, "tests", "fixtures", "runs");
const APPLY = process.argv.includes("--apply");
const MAX_ROUNDS = 6;

function isSpecAnswer(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j.requirements) && Array.isArray(j.iface);
  } catch { return false; }
}

function isSpecPrompt(text) {
  return /REQ-<CAT>-NNN/.test(text) || /"requirements":\s*\[/.test(text);
}

/** One replay attempt; returns the first prompt the corpus could not answer. */
function probe(corpusDir) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-bless-"));
  const home = path.join(scratch, "home");
  const bridge = path.join(scratch, "bridge");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(bridge, "answers"), { recursive: true });
  fs.copyFileSync(path.join(corpusDir, "config.json"), path.join(home, "config.json"));
  for (const f of fs.readdirSync(path.join(corpusDir, "answers"))) {
    fs.copyFileSync(path.join(corpusDir, "answers", f), path.join(bridge, "answers", f));
  }
  spawnSync("node", [
    path.join(REPO, "bin", "rtlforge"), "run",
    "--file", path.join(corpusDir, "desc.txt"),
    "--llm-bridge", bridge, "--llm-bridge-timeout", "12",
  ], {
    cwd: REPO, encoding: "utf8", timeout: 900000,
    env: Object.assign({}, process.env, {
      RTLFORGE_HOME: home, RTLFORGE_API_KEY: "local", NO_COLOR: "1",
    }),
  });
  const pendingDir = path.join(bridge, "pending");
  if (!fs.existsSync(pendingDir)) return null;
  const files = fs.readdirSync(pendingDir).sort();
  if (files.length === 0) return null;
  const f = files[files.length - 1];                       // the one it stalled on
  let body = {};
  try { body = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")); } catch { /* ignore */ }
  return {
    hash: f.replace(/^\d+-/, "").replace(/\.[^.]+$/, ""),
    prompt: String(body.userMessage || body.prompt || ""),
  };
}

let renamed = 0;
for (const name of fs.readdirSync(CORPORA)) {
  const dir = path.join(CORPORA, name);
  if (!fs.existsSync(path.join(dir, "expected.json"))) continue;
  const answers = path.join(dir, "answers");
  const blessed = new Set();
  console.log(`\n${name}:`);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const miss = probe(dir);
    if (!miss) { console.log("   replays with no missing prompt"); break; }
    const have = fs.readdirSync(answers);
    if (have.some(function(f) { return f.startsWith(miss.hash); })) {
      console.log(`   stalled on ${miss.hash}, which IS present — not a prompt-drift problem; stopping`);
      break;
    }
    if (!isSpecPrompt(miss.prompt)) {
      console.log(`   stalled on ${miss.hash}, and it is not the spec prompt — leaving alone`);
      break;
    }
    const candidate = have.find(function(f) {
      return !blessed.has(f) && isSpecAnswer(path.join(answers, f));
    });
    if (!candidate) { console.log("   no unblessed spec answer left to map; stopping"); break; }
    const to = miss.hash + path.extname(candidate);
    console.log(`   ${APPLY ? "renaming" : "would rename"} ${candidate} → ${to}`);
    blessed.add(to);
    if (!APPLY) break;                                     // dry run shows one step per corpus
    fs.renameSync(path.join(answers, candidate), path.join(answers, to));
    renamed++;
  }
}
console.log(APPLY
  ? `\n${renamed} answer(s) rekeyed — now run the suite and confirm every recorded verdict is unchanged`
  : "\ndry run; pass --apply to rename");
