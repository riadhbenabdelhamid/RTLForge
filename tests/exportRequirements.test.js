// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Phase 5 (surface): the acceptance ledger in the exported regression suite.

import { describe, it, expect } from "vitest";
import { generateRequirementsYaml, requirementsReadmeSection, generateReadme } from "../src/utils/export.js";

const LEDGER = {
  requirements: [
    { id: "REQ-INTF-001", pri: "Must", cat: "Interface", status: "structural", green: true, coveringTests: [] },
    { id: "REQ-FUNC-001", pri: "Must", cat: "Functionality", status: "tested-passing", green: true, coveringTests: ["t_inc", "t_wrap"] },
    { id: "REQ-FUNC-002", pri: "Should", cat: "Functionality", status: "tested-passing-estimated", green: false, coveringTests: ["t_est"] },
  ],
  progress: { greenMust: 2, totalMust: 2, greenAll: 2, totalAll: 3, done: true },
};

describe("generateRequirementsYaml", () => {
  it("emits progress + per-req status/green and quotes covering tests", () => {
    const y = generateRequirementsYaml(LEDGER);
    expect(y).toMatch(/greenMust: 2/);
    expect(y).toMatch(/totalMust: 2/);
    expect(y).toMatch(/done: true/);
    expect(y).toMatch(/id: REQ-FUNC-001/);
    expect(y).toMatch(/status: tested-passing\b/);
    expect(y).toMatch(/coveringTests: \["t_inc","t_wrap"\]/);
  });

  it("marks an estimated pass distinctly and never as a clean pass", () => {
    const y = generateRequirementsYaml(LEDGER);
    expect(y).toMatch(/status: tested-passing-estimated/);
    const estBlock = y.slice(y.indexOf("REQ-FUNC-002"));
    expect(estBlock).toMatch(/green: false/);
  });

  it("returns a valid, empty-but-well-formed body for a null/empty ledger", () => {
    expect(generateRequirementsYaml(null)).toMatch(/requirements: \[\]/);
    expect(generateRequirementsYaml({ requirements: [] })).toMatch(/greenMust: 0/);
  });
});

describe("requirementsReadmeSection", () => {
  it("renders a Requirements table with the greenMust headline + provenance", () => {
    const md = requirementsReadmeSection(LEDGER);
    expect(md).toMatch(/## Requirements/);
    expect(md).toMatch(/2\/2 Must requirements green/);
    expect(md).toMatch(/`REQ-FUNC-001`/);
    expect(md).toMatch(/est\. pass \(not simulated\)/);
  });

  it("is omitted (empty string) when the ledger is absent", () => {
    expect(requirementsReadmeSection(null)).toBe("");
    expect(requirementsReadmeSection({ requirements: [] })).toBe("");
  });
});

describe("generateReadme — Requirements section threading", () => {
  const modList = [{ modId: "ctr", score: 100, overall: "PASS" }];
  it("includes the Requirements section + lists requirements.yaml when a ledger is supplied", () => {
    const md = generateReadme("ctr", modList, false, null, null, null, null, null, LEDGER);
    expect(md).toMatch(/## Requirements/);
    expect(md).toMatch(/requirements\.yaml/);
  });
  it("omits both when no ledger is supplied (back-compat)", () => {
    const md = generateReadme("ctr", modList, false, null, null, null, null, null);
    expect(md).not.toMatch(/## Requirements/);
    expect(md).not.toMatch(/requirements\.yaml/);
  });
});
