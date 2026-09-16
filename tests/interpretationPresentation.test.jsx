// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SpecStage } from "../src/react/components/stages.jsx";
import { VerificationSummary } from "../src/react/components/verificationSummary.jsx";
import { printVerificationSummary } from "../src/term/verificationSummary.js";
import { TH } from "../src/constants/theme.js";

const entry = { id: "REQ-FUNC-001", kind: "interpretation", description: "Hold the count at fifteen.",
  reasoning: "Saturation holds the maximum unsigned four-bit value.", sources: [{ quote: "4-bit unsigned", start: 12, end: 26 }], alternatives: [] };
afterEach(cleanup);
it("shows the five provenance fields in Spec and verification with unconfirmed intent in amber", () => {
  for (const component of [<SpecStage data={{ requirements: [], _designContract: { entries: [entry] } }} setData={() => {}} />,
    <VerificationSummary stageData={{ 2: { _designContract: { entries: [entry] } } }} />]) {
    const view = render(component);
    for (const label of ["Requirement", "Origin", "Triggering source", "Reasoning", "User confirmation"]) expect(view.getByRole("rowheader", { name: label })).toBeTruthy();
    expect(view.getByText("LLM interpretation")).toBeTruthy();
    expect(view.getByText("Unconfirmed")).toHaveStyle({ color: TH.yellow });
    expect(view.getByText(/characters 12–26/)).toBeTruthy();
    view.unmount();
  }
});
it("prints the same fields in non-GUI mode", () => {
  const output = [];
  printVerificationSummary({ 2: { _designContract: { entries: [entry] } } }, { write: s => output.push(s) });
  const text = output.join("");
  expect(text).toContain("Origin: LLM interpretation");
  expect(text).toContain("Triggering source: “4-bit unsigned” (characters 12–26)");
  expect(text).toContain("Reasoning: Saturation holds the maximum unsigned four-bit value.");
  expect(text).toContain("User confirmation: Unconfirmed");
});
