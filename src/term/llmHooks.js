// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// term/llmHooks — attach the record / bridge hooks to a run's config
//
// Both live on config as injected functions (see callLLM): `_llmTap` observes
// every completed call, `_llmReplay` answers one without touching the network.
// They were wired inline in `run`, which quietly made them single-module-only
// — `run --system` could neither record a system run nor drive one through
// the bridge, so the multi-module flow had no way to be replayed or to be
// driven by an external model. Sharing the wiring is what lets a system run
// be measured the same way a module run is.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mutates `runtimeConfig` in place with whichever hooks the flags ask for.
 *
 * @param {object} runtimeConfig  the config the pipeline will see
 * @param {object} args           parsed CLI args
 * @param {function} log          writes a line of user-facing status
 */
export async function attachLLMHooks(runtimeConfig, args, log) {
  const say = typeof log === "function" ? log : function() {};

  // Record LLM fixtures for the replay regression suite (roadmap #5):
  //   … --record-llm tests/fixtures/llm/<name>
  if (args["record-llm"]) {
    const rr = await import("../llm/recordReplay.js");
    runtimeConfig._llmTap = rr.createLLMRecorder(String(args["record-llm"]));
    say("recording LLM calls → " + args["record-llm"]);
  }

  // Put an EXTERNAL model (or a human) in the LLM seat: every prompt is
  // parked in <dir>/pending/ and the run blocks until an answer lands in
  // <dir>/answers/<hash8>.txt — see src/llm/bridge.js.
  //   … --llm-bridge talk/run47/bridge [--llm-bridge-models a,b]
  if (args["llm-bridge"]) {
    const br = await import("../llm/bridge.js");
    const bridgeTimeoutSec = args["llm-bridge-timeout"]
      ? Number(args["llm-bridge-timeout"]) : 3600;
    const bridgeModels = args["llm-bridge-models"]
      ? String(args["llm-bridge-models"]).split(",").map(function(x) { return x.trim(); }).filter(Boolean)
      : null;
    runtimeConfig._llmReplay = br.createLLMBridge(String(args["llm-bridge"]), {
      timeoutMs: bridgeTimeoutSec * 1000,
      models: bridgeModels,
      onWait: function(info) {
        say("[llm-bridge] waiting for answer " + info.short
          + "  (prompt " + info.promptLen + " ch → " + info.file + ")");
      },
    });
    say("LLM bridge → " + args["llm-bridge"]
      + "  (answers: <hash8>.txt, timeout " + bridgeTimeoutSec + "s"
      + (bridgeModels ? "; only model(s) " + bridgeModels.join(",") + " — the rest go to the provider" : "")
      + ")");
  }
  return runtimeConfig;
}
