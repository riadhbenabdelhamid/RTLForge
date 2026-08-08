// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// SoC roadmap S7: `rtlforge run --system` — headless decompose → confirm →
// dependency-ordered walk → integration. Orchestration is tested through the
// deps injection seam; the heavy machinery (runAllPipelines, integration fix
// loops) has its own suites.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cmdRunSystem, decomposeSystem, formatDecompTree, seedDecomposition, sanitizeDecomposition,
} from "../src/term/commands/runSystem.js";
import { createInitialProjectState, projectReducer } from "../src/projectState/index.js";
import { extractJSON as realExtractJSON } from "../src/llm/index.js";

const DECOMP = {
  type: "multi", systemName: "counter_sys", topModule: "top",
  description: "a counter system",
  modules: [
    { modId: "cnt", name: "Counter", description: "8-bit counter", level: 1, params: [] },
    { modId: "top", name: "Top", description: "wires the counter out", level: 0, params: [] },
  ],
  instances: [
    { instId: "i1", moduleId: "cnt", parentModuleId: "top", instanceName: "u_cnt0", paramOverrides: { W: 8 } },
  ],
};

let homeDir;
beforeAll(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtlforge-s7-"));
  process.env.RTLFORGE_HOME = homeDir;
});
afterAll(() => {
  delete process.env.RTLFORGE_HOME;
  try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
});

const decompLLM = async (p) => {
  if (!/decompos/i.test((p.userMessage || "") + (p.systemPrompt || ""))) {
    throw new Error("unexpected LLM call: " + (p.userMessage || "").slice(0, 60));
  }
  return { text: JSON.stringify(DECOMP), tokensIn: 5, tokensOut: 5, latencyMs: 1, model: "stub", provider: "stub" };
};

// Fake per-module stage runner: marks the stage complete so the walk's child
// readiness + progress logic run for real.
const fakeRunStage = async (a) => {
  a.dispatch({ type: "MODULE_STAGE_DATA_SET", modId: a.targetModId, stageId: a.stageId, data: { synthetic: true } });
  a.dispatch({ type: "MODULE_STAGE_COMPLETE", modId: a.targetModId, stageId: a.stageId });
  return { ok: true };
};

const fakeIntegration = (judge) => async (store) => {
  store.dispatch({ type: "INTEGRATION_STAGE_DATA_SET", stageId: "int_lint", data: { status: "PASS", issues: [] } });
  store.dispatch({ type: "INTEGRATION_STAGE_COMPLETE", stageId: "int_lint" });
  store.dispatch({ type: "INTEGRATION_STAGE_DATA_SET", stageId: "int_test", data: { code: "tb", verify: { pass: 1, total: 1, fail: 0, cli: true } } });
  store.dispatch({ type: "INTEGRATION_STAGE_COMPLETE", stageId: "int_test" });
  store.dispatch({ type: "INTEGRATION_STAGE_DATA_SET", stageId: "int_judge", data: judge });
  store.dispatch({ type: "INTEGRATION_STAGE_COMPLETE", stageId: "int_judge" });
  return { ok: true, judgeData: judge, currentHashes: {} };
};

const baseArgs = () => ({
  _: ["an 8-bit counter system with a top wrapper"],
  system: true, yes: true, "no-checkpoint": true, skillsDisabled: true,
});

describe("decomposeSystem", () => {
  it("returns the parsed decomposition and records the LLM call", async () => {
    const r = await decomposeSystem({ userDesc: "x", config: {}, callLLM: decompLLM, extractJSON: JSON.parse });
    expect(r.decomp.topModule).toBe("top");
    expect(r.llms).toHaveLength(1);
  });

  it("doubles maxTokens and retries once on truncation", async () => {
    const seen = [];
    const llm = async (p) => {
      seen.push(p.maxTokens);
      if (seen.length === 1) return { text: "{", stopReason: "max_tokens" };
      return { text: JSON.stringify(DECOMP) };
    };
    const r = await decomposeSystem({ userDesc: "x", config: {}, callLLM: llm, extractJSON: JSON.parse });
    expect(seen).toEqual([8000, 16000]);
    expect(r.decomp.type).toBe("multi");
  });

  it("retries with a CORRECTIVE hint when the decomposition is semantically unusable", async () => {
    const prompts = [];
    const badIds = {
      type: "multi", topModule: "sync_counter",   // never defined below
      modules: [{ modId: "counter_unit" }, { modId: "counter_top" }],
      instances: [{ instId: "u0", moduleId: "top_ctrl", parentModuleId: "ghost", instanceName: "u0" }],
    };
    const llm = async (p) => {
      prompts.push(p);
      return { text: JSON.stringify(prompts.length === 1 ? badIds : DECOMP) };
    };
    const r = await decomposeSystem({ userDesc: "x", config: {}, callLLM: llm, extractJSON: JSON.parse });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].userMessage).toContain("inconsistent");
    expect(prompts[1].userMessage).toContain("MUST exactly match");
    expect(r.decomp.topModule).toBe("top");
  });

  it("re-asks WITH the parse error as a hint on malformed JSON (measured lfm2-24b failure mode)", async () => {
    const prompts = [];
    const llm = async (p) => {
      prompts.push(p);
      // first reply: broken JSON (unescaped quote), then a clean one
      return prompts.length === 1
        ? { text: '{"type": "multi", "description": "8" wide", "modules": [' }
        : { text: JSON.stringify(DECOMP) };
    };
    const r = await decomposeSystem({ userDesc: "x", config: {}, callLLM: llm, extractJSON: realExtractJSON });
    expect(r.decomp.topModule).toBe("top");
    expect(prompts).toHaveLength(2);
    // schema-constrained decoding requested on every attempt
    expect(prompts[0].jsonSchema && prompts[0].jsonSchema.name).toBe("system_decomposition");
    // the re-ask carries the actual parse diagnosis, not a blind re-roll
    expect(prompts[1].userMessage.length).toBeGreaterThan(prompts[0].userMessage.length);
    expect(prompts[1].userMessage).toMatch(/JSON|parse/i);
  });
});

describe("formatDecompTree / seedDecomposition", () => {
  it("renders the instance tree with param overrides", () => {
    const s = formatDecompTree(DECOMP);
    expect(s).toContain("top: top");
    expect(s).toContain("└─ u_cnt0 : cnt  (W=8)");
    expect(s).toContain("2 module(s)");
  });

  it("guards against instance cycles instead of recursing forever", () => {
    const cyclic = {
      ...DECOMP,
      instances: [
        ...DECOMP.instances,
        { instId: "i2", moduleId: "top", parentModuleId: "cnt", instanceName: "u_loop", paramOverrides: {} },
      ],
    };
    const s = formatDecompTree(cyclic);
    expect(s).toContain("cycle");
  });

  it("sanitize drops instances that reference undefined modules (hallucination guard)", () => {
    const dirty = {
      ...DECOMP,
      instances: [
        ...DECOMP.instances,
        { instId: "ghost", moduleId: "counter_controller", parentModuleId: "top_ctrl", instanceName: "ctrl_0", paramOverrides: {} },
      ],
    };
    const { decomp, dropped } = sanitizeDecomposition(dirty);
    expect(decomp.instances).toHaveLength(1);
    expect(decomp.instances[0].instId).toBe("i1");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("ghost");
    // clean input passes through untouched
    expect(sanitizeDecomposition(DECOMP).dropped).toEqual([]);
  });

  it("sanitize flags an undefined topModule and then infers the real one", () => {
    const { decomp, dropped, fixed } = sanitizeDecomposition({ ...DECOMP, topModule: "phantom" });
    expect(dropped.some((m) => /phantom/.test(m))).toBe(true);
    expect(decomp.topModule).toBe("top");                 // only never-placed module
    expect(fixed.some((m) => /inferred as 'top'/.test(m))).toBe(true);
  });

  it("sanitize drops SELF-instantiations (they deadlock the dependency walk)", () => {
    const dirty = {
      ...DECOMP,
      instances: [
        ...DECOMP.instances,
        { instId: "self", moduleId: "top", parentModuleId: "top", instanceName: "u_self", paramOverrides: {} },
      ],
    };
    const { decomp, dropped } = sanitizeDecomposition(dirty);
    expect(decomp.instances).toHaveLength(1);
    expect(dropped.some((m) => /inside itself/.test(m))).toBe(true);
  });

  it("sanitize infers a MISSING topModule and defaults systemName (measured lfm2-24b omissions)", () => {
    const bare = { ...DECOMP };
    delete bare.topModule;
    delete bare.systemName;
    const { decomp, fixed } = sanitizeDecomposition(bare);
    expect(decomp.topModule).toBe("top");
    expect(decomp.systemName).toBe("top_system");
    expect(fixed).toHaveLength(2);
  });

  it("with several unplaced modules, the decompose levels break the inference tie (L0 = top)", () => {
    const twoRoots = { ...DECOMP, instances: [] };   // nothing placed — both are roots
    delete twoRoots.topModule;
    const { decomp, fixed } = sanitizeDecomposition(twoRoots);
    expect(decomp.topModule).toBe("top");            // DECOMP levels: top L0, cnt L1
    expect(fixed.some((m) => /inferred/.test(m))).toBe(true);
  });

  it("sanitize cannot infer when the tie is unbreakable — topModule stays null", () => {
    const flat = {
      ...DECOMP,
      modules: [{ modId: "a", level: 0 }, { modId: "b", level: 0 }],
      instances: [],
    };
    delete flat.topModule;
    const { decomp } = sanitizeDecomposition(flat);
    expect(decomp.topModule == null).toBe(true);
  });

  it("seeds modules, instances, decomposition, and the active module", () => {
    let state = createInitialProjectState();
    const dispatch = (a) => { state = projectReducer(state, a); };
    seedDecomposition(dispatch, DECOMP);
    expect(Object.keys(state.modules).sort()).toEqual(["cnt", "top"]);
    expect(state.modules.cnt.description).toBe("8-bit counter");
    expect(state.instances.i1).toMatchObject({ moduleId: "cnt", parentModuleId: "top", instanceName: "u_cnt0" });
    expect(state.decomposition.topModule).toBe("top");
    expect(state.activeModId).toBe("top");
  });
});

describe("cmdRunSystem", () => {
  it("decompose → walk (leaf before top) → integration → exit 0 on judge PASS", async () => {
    const stageOrder = [];
    const code = await cmdRunSystem(baseArgs(), {
      callLLM: decompLLM,
      extractJSON: JSON.parse,
      runStage: async (a, _store) => {
        stageOrder.push(a.targetModId + ":" + a.stageId);
        return fakeRunStage(a);
      },
      runIntegrationPipeline: fakeIntegration({ overall: "PASS", score: 92 }),
    });
    expect(code).toBe(0);
    // dependency order: every cnt stage precedes every top stage
    const firstTop = stageOrder.findIndex((s) => s.startsWith("top:"));
    const lastCnt = stageOrder.map((s, i) => (s.startsWith("cnt:") ? i : -1)).filter((i) => i >= 0).pop();
    expect(lastCnt).toBeLessThan(firstTop);
  });

  it("exits 1 when the integration judge FAILs", async () => {
    const code = await cmdRunSystem(baseArgs(), {
      callLLM: decompLLM,
      extractJSON: JSON.parse,
      runStage: fakeRunStage,
      runIntegrationPipeline: fakeIntegration({ overall: "FAIL", score: 40 }),
    });
    expect(code).toBe(1);
  });

  it("exits 1 with guidance when the model returns a single-module decomposition", async () => {
    const code = await cmdRunSystem(baseArgs(), {
      callLLM: async () => ({ text: JSON.stringify({ type: "single", modules: [] }) }),
      extractJSON: JSON.parse,
    });
    expect(code).toBe(1);
  });

  it("requires --yes when stdin is not a TTY and no confirm hook is given", async () => {
    const args = Object.assign(baseArgs(), { yes: false });
    const code = await cmdRunSystem(args, { callLLM: decompLLM, extractJSON: JSON.parse });
    expect(code).toBe(2);
  });

  it("a declined confirmation aborts cleanly with exit 0 and runs nothing", async () => {
    let ran = 0;
    const args = Object.assign(baseArgs(), { yes: false });
    const code = await cmdRunSystem(args, {
      callLLM: decompLLM,
      extractJSON: JSON.parse,
      confirm: async () => false,
      runStage: async (a) => { ran++; return fakeRunStage(a); },
    });
    expect(code).toBe(0);
    expect(ran).toBe(0);
  });

  it("missing description is a usage error (exit 2)", async () => {
    const args = Object.assign(baseArgs(), { _: [] });
    const code = await cmdRunSystem(args, { callLLM: decompLLM, extractJSON: JSON.parse });
    expect(code).toBe(2);
  });

  it("--resume skips stages a module already completed (cheap resume), reruns the rest", async () => {
    // Seed a checkpoint: cnt fully complete, top untouched.
    const { createStore } = await import("../src/term/store.js");
    const { createFsStorage } = await import("../src/term/fsStorage.js");
    const { ALL_STAGES } = await import("../src/constants/stages.js");
    const seedStore = createStore({ config: {}, storage: createFsStorage(), projectId: "s7resume" });
    seedDecomposition(seedStore.dispatch, DECOMP);
    ALL_STAGES.forEach((s) => {
      seedStore.dispatch({ type: "MODULE_STAGE_DATA_SET", modId: "cnt", stageId: s.id, data: { done: true } });
      seedStore.dispatch({ type: "MODULE_STAGE_COMPLETE", modId: "cnt", stageId: s.id });
    });
    await seedStore.saveCheckpoint();

    const calls = [];
    const args = Object.assign(baseArgs(), { _: [], resume: "s7resume" });
    delete args["no-checkpoint"];   // resume needs storage
    const code = await cmdRunSystem(args, {
      callLLM: async () => { throw new Error("no LLM call expected — decompose must be skipped on resume"); },
      extractJSON: JSON.parse,
      runStage: async (a) => { calls.push(a.targetModId + ":" + a.stageId); return fakeRunStage(a); },
      runIntegrationPipeline: fakeIntegration({ overall: "PASS", score: 90 }),
    });
    expect(code).toBe(0);
    expect(calls.some((s) => s.startsWith("cnt:"))).toBe(false);   // all skipped
    expect(calls.some((s) => s.startsWith("top:"))).toBe(true);    // still runs
  });

  it("exits 1 and prints resume guidance when integration ends on an unconsumed reflowTarget", async () => {
    const code = await cmdRunSystem(baseArgs(), {
      callLLM: decompLLM,
      extractJSON: JSON.parse,
      runStage: fakeRunStage,
      runIntegrationPipeline: async (store) => {
        store.dispatch({ type: "INTEGRATION_STAGE_DATA_SET", stageId: "int_lint", data: { status: "FAIL", issues: [{ sev: "error", msg: "x" }], reflowTarget: "cnt" } });
        return { ok: false, stage: "int_lint", reflowTarget: "cnt", reason: "attributed to cnt", currentHashes: {} };
      },
    });
    expect(code).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The store must hand runAllPipelines the USER's description (run 50).
//
// eb6fe66 made each module's pipeline attribute the user's own paragraph out
// of the system description. It was inert in the CLI: store.runAllPipelines
// built its uiState with `userDesc: ""` hardcoded, so systemModuleDesc always
// received an empty string and always fell back to decompose's paraphrase.
//
// The helper's own unit tests could not catch this — they call it directly.
// Measured on run 50's bridge pass: the sync_fifo elicit prompt came out
// BYTE-IDENTICAL to run 48's (hash 24186a83, 5104 chars), which is how the
// dead wiring was noticed at all. After the fix: 27ac7dc3, 5806 chars, and
// the description leads with the user's enumerated port list.
// ═══════════════════════════════════════════════════════════════════════════
describe("store carries the user description into a system run (run 50)", () => {
  const SYS_DESC = [
    "A counter system.",
    "",
    "The leaf module, cnt, is an 8-bit counter. Ports: clk, rst_n, en, q.",
    "",
    "The top level, top, wires the counter out. Ports: clk, rst_n, q.",
  ].join("\n");

  async function descsSeenByStages(userDesc) {
    const { createStore } = await import("../src/term/store.js");
    const store = createStore({ config: {}, projectId: "userdesc", userDesc });
    seedDecomposition(store.dispatch, DECOMP);
    const seen = [];
    await store.runAllPipelines("full-auto", {
      runStage: async function(a) {
        seen.push({ mod: a.targetModId, desc: a.overrideDesc || "" });
        // Mark it done so the walk advances to the next module — a stub that
        // only reports success leaves every module incomplete and the walk
        // never leaves the first one.
        store.dispatch({ type: "MODULE_STAGE_DATA_SET", modId: a.targetModId, stageId: a.stageId, data: { done: true } });
        store.dispatch({ type: "MODULE_STAGE_COMPLETE", modId: a.targetModId, stageId: a.stageId });
        return { ok: true };
      },
      runIntegrationPipeline: async function() { return { ok: true, notApplicable: true }; },
    });
    return seen;
  }

  it("each module's stages see the user's own paragraph, not only the paraphrase", async () => {
    const seen = await descsSeenByStages(SYS_DESC);
    const cnt = seen.find((x) => x.mod === "cnt");
    expect(cnt).toBeTruthy();
    // the user's enumerated clause — what the port validator reads
    expect(cnt.desc).toContain("Ports: clk, rst_n, en, q");
    // and decompose's elaboration is still there for the model
    expect(cnt.desc).toContain("8-bit counter");
  });

  it("the top gets ITS paragraph, not the leaf's", async () => {
    const seen = await descsSeenByStages(SYS_DESC);
    const top = seen.find((x) => x.mod === "top");
    expect(top.desc).toContain("Ports: clk, rst_n, q");
    expect(top.desc).not.toContain("Ports: clk, rst_n, en, q");
  });

  it("without a user description it degrades to the paraphrase, never to empty", async () => {
    const seen = await descsSeenByStages("");
    const cnt = seen.find((x) => x.mod === "cnt");
    expect(cnt.desc).toContain("8-bit counter");
  });
});
