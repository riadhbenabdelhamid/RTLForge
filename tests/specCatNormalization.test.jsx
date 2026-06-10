// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SpecStage } from "../src/react/components/stages.jsx";

describe("SpecStage requirement category normalization (V22-bug-pass-4 #2)", function() {
  // Spec data where the LLM correctly emitted "Functionality" for a
  // REQ-FUNC-001. Pre-fix: the GUI dropdown only had "Functional" as
  // an option, so the <select> fell back to the FIRST option,
  // "Interface", which is what the user saw on screen.
  const specWithCanonicalCats = {
    requirements: [
      { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must",   desc: "X" },
      { id: "REQ-INTF-001", cat: "Interface",    pri: "Must",   desc: "Y" },
      { id: "REQ-TIME-001", cat: "Timing",       pri: "Should", desc: "Z" },
    ],
    iface: [], params: [],
  };

  it("non-edit mode: displays each req's cat as-is (canonical Functionality)", function() {
    const { container } = render(
      <SpecStage data={specWithCanonicalCats} setData={function() {}} isActive={false} />
    );
    const txt = container.textContent;
    // REQ-FUNC-001 must show as Functionality, NOT Interface
    expect(txt).toMatch(/Functionality/);
    // The other cats are present
    expect(txt).toMatch(/Interface/);
    expect(txt).toMatch(/Timing/);
  });

  it("edit mode: dropdown for REQ-FUNC-001 has Functionality selected (not Interface)", function() {
    const { container } = render(
      <SpecStage data={specWithCanonicalCats} setData={function() {}} isActive={true} />
    );
    // Three select elements for cat, one per req (plus pri selects for each)
    const selects = container.querySelectorAll("select");
    // Find the cat selects — they have 5 canonical options
    const catSelects = Array.from(selects).filter(function(s) {
      return s.options.length === 5;
    });
    expect(catSelects.length).toBeGreaterThanOrEqual(3);
    // First cat select corresponds to REQ-FUNC-001
    expect(catSelects[0].value).toBe("Functionality");
    expect(catSelects[1].value).toBe("Interface");
    expect(catSelects[2].value).toBe("Timing");
  });

  it("edit mode: legacy 'Functional' value is shown as 'Functionality' (normalized)", function() {
    // Old checkpoint data with legacy GUI vocabulary
    const legacySpec = {
      requirements: [
        { id: "REQ-FUNC-001", cat: "Functional", pri: "Must", desc: "X" },
      ],
      iface: [], params: [],
    };
    const { container } = render(
      <SpecStage data={legacySpec} setData={function() {}} isActive={true} />
    );
    const selects = container.querySelectorAll("select");
    const catSelects = Array.from(selects).filter(function(s) {
      return s.options.length === 5;
    });
    expect(catSelects[0].value).toBe("Functionality");
  });

  it("dropdown only offers the 5 canonical cats (Parameter is gone)", function() {
    const { container } = render(
      <SpecStage data={specWithCanonicalCats} setData={function() {}} isActive={true} />
    );
    const selects = container.querySelectorAll("select");
    const catSelects = Array.from(selects).filter(function(s) {
      return s.options.length === 5;
    });
    const options = Array.from(catSelects[0].options).map(function(o) { return o.value; });
    expect(options).toEqual(["Interface", "Functionality", "Timing", "Error", "Verification"]);
    // Parameter was removed — it's not a requirement category
    expect(options).not.toContain("Parameter");
    // "Functional" (old name) is gone too
    expect(options).not.toContain("Functional");
  });

  it("new-req form: default cat is Functionality (not Functional)", function() {
    const { container, getByText } = render(
      <SpecStage data={specWithCanonicalCats} setData={function() {}} isActive={true} />
    );
    // Click "+ Add Requirement" to reveal the new-req form
    fireEvent.click(getByText("+ Add Requirement"));
    const selects = container.querySelectorAll("select");
    // The newly-revealed cat select is the one whose initial value is the canonical default
    const catSelects = Array.from(selects).filter(function(s) {
      return s.options.length === 5;
    });
    // The last cat select is the new-req form's (the first 3 belong to existing reqs)
    expect(catSelects[catSelects.length - 1].value).toBe("Functionality");
  });
});
