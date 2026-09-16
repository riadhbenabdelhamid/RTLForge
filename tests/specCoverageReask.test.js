// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// Coverage self-review (run 59): when the description has table rows or
// directive sentences that no requirement cites, the spec node asks the model
// once to cover them — and keeps the first spec whenever the answer is
// malformed, drops an id, or makes coverage worse. Opt-in via config.specReask.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/llm/index.js", function() {
  return { callLLMJson: vi.fn(), addRetryHint: function(s) { return s; } };
});
vi.mock("../src/pipeline/applySkillsToPrompt.js", function() {
  return { applySkillsToPrompt: async function(p) { return p; } };
});
const { callLLMJson } = await import("../src/llm/index.js");
const { specNode } = await import("../src/pipeline/nodes/spec.js");
const { promptSpecCoverageReview } = await import("../src/prompts/spec.js");
const { assessDesignContract } = await import("../src/pipeline/designContract.js");

const DESC = "I would like you to implement a module named TopModule with the following interface.\n"
  + " - input  clk\n - input  tick\n - input  go\n - input  state (10 bits)\n - output RUN_next\n - output HOLD_next\n - output arm\n - output busy\n - output ready\n"
  + "The module should implement the next-state logic of this one-hot state machine.\n"
  + "state   (output)      --input--> next state\n"
  + "  ARM    (arm=1) --(always go to next cycle)--> RUN\n"
  + "  RUN (busy=1)  --tick=0--> RUN\n"
  + "  RUN (busy=1)  --tick=1--> HOLD\n"
  + "  HOLD  (ready=1)      --go=0--> HOLD\n"
  + "  HOLD  (ready=1)      --go=1--> IDLE\n";

const IFACE = [
  { name: "clk", dir: "input", width: "1", desc: "clock" },
  { name: "tick", dir: "input", width: "1", desc: "" },
  { name: "go", dir: "input", width: "1", desc: "" },
  { name: "state", dir: "input", width: "10", desc: "one-hot state" },
  // outputs carry a reset field and the rows' signals are all present: otherwise
  // the schema guard's own corrective re-ask fires first and eats the mocked review
  { name: "RUN_next", dir: "output", width: "1", desc: "", reset: "0" },
  { name: "HOLD_next", dir: "output", width: "1", desc: "", reset: "0" },
  { name: "arm", dir: "output", width: "1", desc: "", reset: "0" },
  { name: "busy", dir: "output", width: "1", desc: "", reset: "0" },
  { name: "ready", dir: "output", width: "1", desc: "", reset: "0" },
];
// the first answer drops both self-loop rows — exactly what run 59 measured
const FIRST = {
  modName: "TopModule", domain: "fsm",
  requirements: [
    { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", src: "ARM    (arm=1) --(always go to next cycle)--> RUN",
      desc: "The module shall assert RUN_next when the state is ARM.", rat: "[derived from description: ARM row]" },
    { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must", src: "RUN (busy=1)  --tick=1--> HOLD",
      desc: "The module shall assert HOLD_next when the state is RUN and tick is 1.", rat: "[derived from description: RUN row]" },
    { id: "REQ-FUNC-003", cat: "Functionality", pri: "Must", src: "The module should implement the next-state logic of this one-hot state machine.",
      desc: "The module shall implement the next-state logic of the one-hot state machine.", rat: "[derived from description]" },
    { id: "REQ-FUNC-004", cat: "Functionality", pri: "Must", src: "HOLD  (ready=1)      --go=1--> IDLE",
      desc: "The module shall leave HOLD when go is 1.", rat: "[derived from description: HOLD row]" },
  ],
  iface: IFACE, params: [],
};
const REVIEWED = {
  requirements: [
    FIRST.requirements[0],
    { id: "REQ-FUNC-002", cat: "Functionality", pri: "Must",
      src: "RUN (busy=1)  --tick=0--> RUN\n  RUN (busy=1)  --tick=1--> HOLD",
      desc: "The module shall assert RUN_next when the state is RUN and tick is 0, and HOLD_next when the state is RUN and tick is 1.",
      rat: "[derived from description: RUN rows]" },
    FIRST.requirements[2],
    { id: "REQ-FUNC-004", cat: "Functionality", pri: "Must",
      src: "HOLD  (ready=1)      --go=0--> HOLD\n  HOLD  (ready=1)      --go=1--> IDLE",
      desc: "The module shall assert HOLD_next when the state is HOLD and go is 0, and leave HOLD when go is 1.",
      rat: "[derived from description: HOLD rows]" },
  ],
  coverage: [
    { item: "RUN (busy=1)  --tick=0--> RUN", action: "covered", by: "REQ-FUNC-002", why: "self-loop term" },
    { item: "HOLD  (ready=1)      --go=0--> HOLD", action: "covered", by: "REQ-FUNC-004", why: "self-loop term" },
  ],
};
const reply = (data) => ({ data: data, llms: [{ text: JSON.stringify(data), tokensIn: 1, tokensOut: 1 }] });
function state(extra) {
  return Object.assign({
    _userDesc: DESC,
    _config: { provider: "openai", model: "m", apiKey: "k", stageSettings: {}, specReask: true },
    _onLog: vi.fn(),
  }, extra || {});
}

describe("spec coverage self-review", function() {
  beforeEach(function() { callLLMJson.mockReset(); });

  it("builds a review prompt that names every uncovered item and the current requirements", function() {
    const p = promptSpecCoverageReview(DESC, FIRST, [{ kind: "row", text: "HOLD  (ready=1)      --go=0--> HOLD" }]);
    expect(p.userMessage).toContain('row: "HOLD  (ready=1)      --go=0--> HOLD"');
    expect(p.userMessage).toContain("REQ-FUNC-004");
    expect(p.userMessage).toContain("Keep every existing requirement and its id");
  });

  it("re-asks once for the dropped rows and adopts a well-formed review that covers them", async function() {
    callLLMJson.mockResolvedValueOnce(reply(FIRST)).mockResolvedValueOnce(reply(REVIEWED));
    const out = await specNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(String(callLLMJson.mock.calls[1][0].userMessage)).toContain("tick=0--> RUN");
    expect(out.spec._coverageReask.before).toBeGreaterThanOrEqual(2);
    expect(out.spec._coverageReask.after).toBeLessThan(out.spec._coverageReask.before);
    expect(out.spec.requirements.find((r) => r.id === "REQ-FUNC-002").desc).toMatch(/tick is 0/);
    expect(out.spec.iface).toEqual(IFACE);                       // never taken from the re-ask
    expect(out._llms.length).toBe(2);                            // both attempts ledgered
  });

  it("keeps the first spec when the review drops a requirement id", async function() {
    const bad = { requirements: REVIEWED.requirements.slice(1), coverage: [] };
    callLLMJson.mockResolvedValueOnce(reply(FIRST)).mockResolvedValueOnce(reply(bad));
    const out = await specNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(out.spec._coverageReask).toBeUndefined();
    expect(out.spec.requirements.map((r) => r.id)).toEqual(FIRST.requirements.map((r) => r.id));
    expect(out.spec.uncovered.length).toBeGreaterThanOrEqual(2);
    expect(String(out.spec.requirements[0].desc)).toBe(FIRST.requirements[0].desc);
  });

  it("does nothing without config.specReask (the flags are still reported)", async function() {
    callLLMJson.mockResolvedValueOnce(reply(FIRST));
    const st = state(); st._config.specReask = false;
    const out = await specNode(st);
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    expect(out.spec.uncovered.length).toBeGreaterThanOrEqual(2);
  });

  it("does nothing when everything is covered", async function() {
    const full = Object.assign({}, FIRST, { requirements: REVIEWED.requirements });
    callLLMJson.mockResolvedValueOnce(reply(full));
    const out2 = await specNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    expect(out2.spec._coverageReask).toBeUndefined();
  });

  function interpretationFixture() {
    const interpreted = {
      id: "REQ-FUNC-005", cat: "Functionality", pri: "Must",
      desc: "At most one bit of the supplied state vector is active at a time.",
      src: "", sources: [], rat: "[derived from description: one-hot state representation]",
      environment: true,
      provenance: { kind: "interpretation", reasoning: "One-hot representation excludes multiple simultaneous active state bits.",
        sources: [{ quote: "one-hot state machine" }], alternatives: ["Allow multiple simultaneous active state bits"] },
    };
    const first = structuredClone(FIRST);
    first.requirements.push(interpreted);
    const reviewed = structuredClone(REVIEWED);
    const { provenance, environment, ...projection } = interpreted;
    reviewed.requirements.unshift(projection); // match by id, not list position
    return { first, reviewed, interpreted };
  }

  it("preserves interpretation provenance and formal role across a lossy coverage response", async () => {
    const { first, reviewed, interpreted } = interpretationFixture();
    const before = structuredClone(first), response = structuredClone(reviewed);
    callLLMJson.mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply(reviewed));
    const out = await specNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(out.spec.requirements.find(r => r.id === interpreted.id)).toEqual(interpreted);
    expect(out.spec._coverageReask.preservedAttribution).toEqual([{ id: interpreted.id, fields: ["provenance"] }]);
    expect(out.spec._coverageReask.after).toBeLessThan(out.spec._coverageReask.before);
    expect(out.spec._sourceContract.status).toBe("READY");
    const contract = assessDesignContract(DESC, out.spec, out.elicit);
    expect(contract.issues).toEqual([]);
    expect(contract.assumptions).toMatchObject([{ id: interpreted.id, kind: "interpretation", environment: true,
      alternatives: interpreted.provenance.alternatives }]);
    expect(first.requirements).toEqual(before.requirements);
    expect(reviewed).toEqual(response);
  });

  it.each([
    { desc: "The state vector may contain several active bits at a time." },
    { pri: "Should" },
    { rat: "[source: assumption A-99]" },
    { latency: 2 },
    { provenance: null },
    { provenance: { kind: "interpretation", reasoning: "", sources: [] } },
    { environment: false },
  ])("rejects coverage changes that lose qualification or alter formal role: %j", async changes => {
    const { first, reviewed, interpreted } = interpretationFixture();
    Object.assign(reviewed.requirements[0], changes);
    callLLMJson.mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply(reviewed));
    const out = await specNode(state());
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(out.spec._coverageReask.status).toBe("REJECTED");
    expect(out.spec._coverageReask.issues[0].id).toBe(interpreted.id);
    expect(out.spec.requirements).toEqual(first.requirements);
    expect(out.spec._sourceContract.status).toBe("READY");
    expect(out.spec.uncovered.length).toBeGreaterThan(0);
  });

  it("accepts supported amendments without transferring the previous interpretation to new behavior", async () => {
    const { first, reviewed, interpreted } = interpretationFixture();
    Object.assign(reviewed.requirements[0], {
      desc: "The supplied state vector shall use one-hot state encoding.",
      src: "The module should implement the next-state logic of this one-hot state machine.",
    });
    callLLMJson.mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply(reviewed));
    const out = await specNode(state());
    const amended = out.spec.requirements.find(r => r.id === interpreted.id);
    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(out.spec._coverageReask.status).not.toBe("REJECTED");
    expect(amended.provenance).toBeUndefined();
    expect(amended.desc).toBe(reviewed.requirements[0].desc);
    expect(out.spec._sourceContract.status).toBe("READY");
  });

  it("rejects promoting a design requirement into a formal environment assumption", async () => {
    const reviewed = structuredClone(REVIEWED);
    reviewed.requirements[0].environment = true;
    callLLMJson.mockResolvedValueOnce(reply(structuredClone(FIRST))).mockResolvedValueOnce(reply(reviewed));
    const out = await specNode(state());
    expect(out.spec._coverageReask.status).toBe("REJECTED");
    expect(out.spec._coverageReask.reason).toContain("formal environment role");
    expect(out.spec.requirements[0].environment).toBeUndefined();
  });
});
