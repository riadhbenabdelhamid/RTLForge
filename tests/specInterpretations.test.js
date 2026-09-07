// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
// The spec stage disambiguates vague sentences by appending a parenthetical to
// the requirement it writes. Measured on runs 55 and 57, that invented text was
// the half that turned out to be wrong — and because one requirement drives the
// RTL, the testbench AND any formal property, nothing downstream could see it.
// An interpretation belongs on spec.interpretations, where it is reviewable,
// not inside a Must requirement, where it is normative.
import { describe, it, expect } from "vitest";
import { splitInventedParentheticals, describeInterpretations } from "../src/pipeline/specInterpretations.js";

// Verbatim shapes from the two runs (neutral domain wording).
const RUN55_SRC = "If a unit descends for too long then reaches the floor, it can fault. "
  + "In particular, if a unit descends for more than 20 clock cycles then reaches the floor, "
  + "it will fault and cease moving, descending, or drilling.";
const RUN55_REQ = {
  id: "REQ-FUNC-004", pri: "Must",
  desc: "The module shall fault when a descending unit reaches the floor (floor=1) and "
      + "the descent duration exceeded 20 clock cycles (counter reached 21 or more).",
};
const RUN57_SRC = "The FSM has to monitor the x input. When x has produced the values 1, 0, 1 in "
  + "three successive clock cycles, then g should be set to 1 on the following clock cycle.";
const RUN57_REQ = {
  id: "REQ-FUNC-003", pri: "Must",
  desc: "The module shall continuously monitor x for the pattern 1,0,1 on three consecutive "
      + "clock cycles, resetting match progress on any non-matching bit (non-overlapping detection).",
};

describe("invented parentheticals are lifted out of requirements", function() {
  it("removes a counter restatement the description never made", function() {
    const r = splitInventedParentheticals([RUN55_REQ], RUN55_SRC);
    expect(r.requirements[0].desc).toBe(
      "The module shall fault when a descending unit reaches the floor (floor=1) and "
      + "the descent duration exceeded 20 clock cycles.");
    expect(r.interpretations).toHaveLength(1);
    expect(r.interpretations[0].req).toBe("REQ-FUNC-004");
    expect(r.interpretations[0].text).toBe("counter reached 21 or more");
    expect(r.interpretations[0].novel).toEqual(expect.arrayContaining(["counter", "21"]));
    // The prose half — which was the CORRECT half — survives untouched.
    expect(r.requirements[0].desc).toContain("more than 20 clock cycles".replace("more than ", "exceeded "));
  });

  it("removes an overlap rule the description never stated", function() {
    const r = splitInventedParentheticals([RUN57_REQ], RUN57_SRC);
    expect(r.requirements[0].desc).not.toContain("non-overlapping");
    expect(r.requirements[0].desc).toContain("three consecutive clock cycles");
    expect(r.interpretations[0].text).toBe("non-overlapping detection");
    expect(r.interpretations[0].novel).toEqual(expect.arrayContaining(["overlapping", "detection"]));
  });

  it("keeps value bindings — they are the requirement doing its job, not a reading", function() {
    // The harm this guards against is real: an earlier cut stripped these four
    // encodings out of the ONE requirement that defined them, leaving "classify
    // the water level into one of four states: above_s2, between_s2_s1,
    // between_s1_s0, below_s0" with no statement of what any of them mean. That
    // design then missed 1803 of 2040 samples.
    const src = "three sensors are placed vertically at 5-inch intervals. When the water level is "
      + "above the highest sensor s[2], the input flow rate should be zero.";
    const req = [{ id: "REQ-FUNC-001", desc: "The module shall classify the water level into one of four "
      + "states based on the sensor pattern: above_s2 (s=3'b111), between_s2_s1 (s=3'b011), "
      + "between_s1_s0 (s=3'b001), below_s0 (s=3'b000)." }];
    const r = splitInventedParentheticals(req, src);
    expect(r.interpretations).toHaveLength(0);
    expect(r.requirements[0].desc).toBe(req[0].desc);
  });

  it("distinguishes a formalisation from a reading in the same requirement", function() {
    const r = splitInventedParentheticals(
      [{ id: "R1", desc: "The module shall fault (floor=1) after the descent exceeds 20 clock cycles (counter reached 21 or more)." }],
      "the unit faults when it reaches the floor after descending for more than 20 clock cycles");
    expect(r.interpretations).toHaveLength(1);
    expect(r.interpretations[0].text).toBe("counter reached 21 or more");
    expect(r.requirements[0].desc).toContain("(floor=1)");     // the binding survives
  });

  it("keeps bit selects and sized literals", function() {
    for (const inner of ["data[7:0] holds the payload", "8'hFF terminates", "count >= 4"]) {
      const r = splitInventedParentheticals([{ id: "R", desc: "The module shall emit (" + inner + ")." }], "emit the payload");
      expect(r.interpretations).toHaveLength(0);
    }
  });

  it("leaves a parenthetical that only restates the description", function() {
    // "(floor=1)" survives above; bit literals are not evidence of invention,
    // and inflection is tolerated (source "fault", requirement "faulting").
    const src = "when the floor signal is 1 the unit stops faulting and resumes moving";
    const reqs = [{ id: "R1", desc: "The module shall resume moving (floor=1) when faulting ends." }];
    const r = splitInventedParentheticals(reqs, src);
    expect(r.interpretations).toHaveLength(0);
    expect(r.requirements[0].desc).toBe(reqs[0].desc);
  });

  it("ignores noise parentheticals and requirements without any", function() {
    const r = splitInventedParentheticals(
      [{ id: "R1", desc: "The module shall drive data_o (s) each cycle." },
       { id: "R2", desc: "The module shall assert ready." }],
      "drive data_o each cycle and assert ready");
    expect(r.interpretations).toHaveLength(0);
  });

  it("records the original text so nothing is silently lost", function() {
    const r = splitInventedParentheticals([RUN55_REQ], RUN55_SRC);
    expect(r.interpretations[0].desc).toBe(RUN55_REQ.desc);
    expect(r.requirements[0]._interpretationsRemoved).toEqual(["counter reached 21 or more"]);
    expect(describeInterpretations(r.interpretations)).toContain("REQ-FUNC-004");
    expect(describeInterpretations([])).toBe("");
  });

  it("tolerates junk input", function() {
    expect(splitInventedParentheticals(null, "x").requirements).toEqual([]);
    expect(splitInventedParentheticals([{ id: "R" }], "x").interpretations).toEqual([]);
    expect(splitInventedParentheticals([RUN57_REQ], "").interpretations).toHaveLength(1);
  });
});
