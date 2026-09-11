// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// The spec stage disambiguates a vague sentence by appending a parenthetical to
// the requirement it writes. On runs 55 and 57 that invented reading was wrong,
// and nothing downstream could see it: the RTL, the testbench and any formal
// property all derive from the same sentence, so they agree with each other and
// disagree with what was asked for.
//
// This module REPORTS and never edits. An earlier attempt deleted the offending
// text and, when its heuristic missed, removed four sensor encodings from the
// one requirement that defined them — that design missed 1803 of 2040 samples.
// The first test below is the guard against ever doing that again.
import { describe, it, expect } from "vitest";
import { unsupportedParentheticals, describeUnsupported,
         uncitedRequirements, describeUncited,
         unsourcedRequirements, describeUnsourced,
         uncoveredDescription, describeUncovered } from "../src/pipeline/specTraceability.js";

const RUN55_SRC = "If a unit descends for too long then reaches the floor, it can fault. In particular, "
  + "if a unit descends for more than 20 clock cycles then reaches the floor, it will fault.";
const RUN57_SRC = "The FSM has to monitor the x input. When x has produced the values 1, 0, 1 in three "
  + "successive clock cycles, then g should be set to 1 on the following clock cycle.";
const SENSOR_SRC = "three sensors are placed vertically at 5-inch intervals. When the water level is "
  + "above the highest sensor s[2], the input flow rate should be zero.";

describe("spec traceability — report only, never edit", function() {
  it("NEVER modifies a requirement, whatever it flags", function() {
    const reqs = [
      { id: "R1", desc: "The module shall fault (counter reached 21 or more)." },
      { id: "R2", desc: "The module shall classify (s=3'b111) and (s=3'b000)." },
    ];
    const frozen = reqs.map(function(r) { return r.desc; });
    unsupportedParentheticals(reqs, RUN55_SRC);
    expect(reqs.map(function(r) { return r.desc; })).toEqual(frozen);
  });

  it("flags a reading the description never made", function() {
    const f = unsupportedParentheticals(
      [{ id: "REQ-FUNC-004", desc: "The module shall fault when the descent exceeded 20 clock cycles (counter reached 21 or more)." }],
      RUN55_SRC);
    expect(f).toHaveLength(1);
    expect(f[0].req).toBe("REQ-FUNC-004");
    expect(f[0].text).toBe("counter reached 21 or more");
    expect(f[0].terms).toEqual(expect.arrayContaining(["counter", "21"]));
  });

  it("flags an algorithm choice the description never stated", function() {
    const f = unsupportedParentheticals(
      [{ id: "REQ-FUNC-003", desc: "The module shall monitor x for 1,0,1 on three consecutive clock cycles (non-overlapping detection)." }],
      RUN57_SRC);
    expect(f[0].text).toBe("non-overlapping detection");
    expect(f[0].terms).toEqual(expect.arrayContaining(["overlapping", "detection"]));
  });

  it("stays quiet on value bindings — the requirement doing its job", function() {
    const f = unsupportedParentheticals(
      [{ id: "REQ-FUNC-001", desc: "The module shall classify the level: above_s2 (s=3'b111), "
        + "between_s2_s1 (s=3'b011), between_s1_s0 (s=3'b001), below_s0 (s=3'b000)." }],
      SENSOR_SRC);
    expect(f).toHaveLength(0);
  });

  it("stays quiet on restatements, bit selects and noise", function() {
    expect(unsupportedParentheticals(
      [{ id: "R", desc: "The module shall resume moving (floor=1) when faulting ends." }],
      "when the floor signal is 1 the unit stops faulting and resumes moving")).toHaveLength(0);
    expect(unsupportedParentheticals(
      [{ id: "R", desc: "The module shall drive (data[7:0]) and (s) each cycle." }],
      "drive the payload each cycle")).toHaveLength(0);
    expect(unsupportedParentheticals(
      [{ id: "R", desc: "The module shall assert ready." }], "assert ready")).toHaveLength(0);
  });

  it("separates a flagged reading from a kept binding in one requirement", function() {
    const f = unsupportedParentheticals(
      [{ id: "R1", desc: "The module shall fault (floor=1) after the descent exceeds 20 clock cycles (counter reached 21 or more)." }],
      RUN55_SRC);
    expect(f).toHaveLength(1);
    expect(f[0].text).toBe("counter reached 21 or more");
  });

  it("renders a readable block, and nothing when there is nothing to say", function() {
    const f = unsupportedParentheticals(
      [{ id: "R1", desc: "The module shall fault (counter reached 21 or more)." }], RUN55_SRC);
    expect(describeUnsupported(f)).toContain("R1");
    expect(describeUnsupported(f)).toContain("counter");
    expect(describeUnsupported([])).toBe("");
  });

  it("tolerates junk input", function() {
    expect(unsupportedParentheticals(null, "x")).toEqual([]);
    expect(unsupportedParentheticals([{ id: "R" }], "x")).toEqual([]);
    expect(unsupportedParentheticals([{ id: "R", desc: "no parens here" }], "")).toEqual([]);
  });

  describe("citation check — exact, not heuristic", function() {
    // The spec stage is asked to quote the sentence each requirement derives
    // from. The quote is either in the description or it is not; there is
    // nothing to tune and no vocabulary to get wrong.
    const SRC = "When x has produced the values 1, 0, 1 in three\nsuccessive clock cycles, then g should "
      + "be set to 1 on the following clock cycle.";

    it("accepts a real quote even when the description wrapped it across lines", function() {
      const f = uncitedRequirements(
        [{ id: "R1", src: "x has produced the values 1, 0, 1 in three successive clock cycles" }], SRC);
      expect(f).toEqual([]);
    });

    it("flags a quote that is not in the description", function() {
      const f = uncitedRequirements([{ id: "R2", src: "the detector must not overlap windows" }], SRC);
      expect(f).toHaveLength(1);
      expect(f[0].req).toBe("R2");
      expect(f[0].reason).toMatch(/not found/);
    });

    it("does not check a requirement that makes no claim — absent is unknown, not wrong", function() {
      // Every recorded corpus and every older spec predates the field; treating
      // absent as uncited would bury the real signal under a wall of flags.
      expect(uncitedRequirements([{ id: "R3" }, { id: "R4", desc: "x" }], SRC)).toEqual([]);
    });

    it("rejects a stub quote as unverifiable", function() {
      const f = uncitedRequirements([{ id: "R5", src: "x = 1" }], SRC);
      expect(f[0].reason).toMatch(/too short/);
    });

    it("an empty src is an honest 'nothing supports this' and is not flagged", function() {
      expect(uncitedRequirements([{ id: "R6", src: "" }], SRC)).toEqual([]);
    });

    it("renders a readable block", function() {
      const f = uncitedRequirements([{ id: "R7", src: "invented text nobody wrote" }], SRC);
      expect(describeUncited(f)).toContain("R7");
      expect(describeUncited([])).toBe("");
    });

    it("tolerates junk input", function() {
      expect(uncitedRequirements(null, SRC)).toEqual([]);
      expect(uncitedRequirements([{ id: "R", src: "anything at all here" }], "")).toEqual([]);
    });
  });

  describe("empty citations — the gap the spec stage filled with a rule", function() {
    // Run 59: every first-shot failure traced to a requirement with src "".
    it("reports requirements with an EMPTY src, not ones with no src at all", function() {
      const f = unsourcedRequirements([
        { id: "R1", pri: "Should", src: "", desc: "The module shall return to idle after done deasserts." },
        { id: "R2", pri: "Must", desc: "no src field: an older spec" },
        { id: "R3", pri: "Must", src: "a real quote", desc: "cited" },
      ]);
      expect(f.map(function(x) { return x.req; })).toEqual(["R1"]);
      expect(f[0].pri).toBe("Should");
    });

    it("renders id, priority and text, and nothing for nothing", function() {
      const f = unsourcedRequirements([{ id: "R9", pri: "Must", src: "", desc: "Outputs are purely combinational." }]);
      expect(describeUnsourced(f)).toContain("R9 [Must]");
      expect(describeUnsourced(f)).toContain("purely combinational");
      expect(describeUnsourced([])).toBe("");
    });

    it("tolerates junk input", function() {
      expect(unsourcedRequirements(null)).toEqual([]);
      expect(unsourcedRequirements([null, { id: "R" }])).toEqual([]);
    });
  });

  describe("coverage — what the description says that no requirement cites", function() {
    // Run 59: a one-hot FSM's two self-loop rows were dropped from an otherwise
    // fully cited spec; every provenance check passed and the design was wrong.
    const ROWS = "state   (output)      --input--> next state\n"
      + "  ARM    (arm=1) --(always go to next cycle)--> RUN\n"
      + "  RUN (busy=1)  --tick=0--> RUN\n"
      + "  RUN (busy=1)  --tick=1--> HOLD\n"
      + "  HOLD  (ready=1)      --go=0--> HOLD\n"
      + "  HOLD  (ready=1)      --go=1--> IDLE\n"
      + "The module should assert ready in the HOLD state.";

    it("flags table rows no requirement cites, and not the header", function() {
      const f = uncoveredDescription([
        { id: "R1", src: "ARM    (arm=1) --(always go to next cycle)--> RUN" },
        { id: "R2", src: "RUN (busy=1)  --tick=1--> HOLD" },
        { id: "R3", src: "HOLD  (ready=1)      --go=1--> IDLE" },
        { id: "R4", src: "The module should assert ready in the HOLD state." },
      ], ROWS);
      expect(f.map(function(x) { return x.text; })).toEqual([
        "RUN (busy=1)  --tick=0--> RUN",
        "HOLD  (ready=1)      --go=0--> HOLD",
      ]);
      expect(f[0].kind).toBe("row");
    });

    it("flags a directive sentence nobody cites, tolerating wrapped quotes", function() {
      const SRC = "When the buffer is below the low mark, the request rate should be at maximum (both channels opened). "
        + "Each fill level has a nominal request rate. The module shall have a reset.";
      const f = uncoveredDescription([{ id: "R1", src: "The module shall have\na reset." }], SRC);
      expect(f.map(function(x) { return x.kind; })).toEqual(["sentence"]);
      expect(f[0].text).toMatch(/both channels opened/);
    });

    it("says nothing when nothing was cited (older specs), and renders", function() {
      expect(uncoveredDescription([{ id: "R1", desc: "no src at all" }], ROWS)).toEqual([]);
      expect(uncoveredDescription(null, ROWS)).toEqual([]);
      const f = uncoveredDescription([{ id: "R1", src: "The module should assert ready in the HOLD state." }], ROWS);
      expect(describeUncovered(f)).toContain("row");
      expect(describeUncovered([])).toBe("");
    });
  });
});
