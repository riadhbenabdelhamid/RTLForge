// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Settings → Guide tab — render + sub-tab navigation. The Guide explains the
// GUI in its own sub-tabs; the Convergence sub-tab documents the top strip.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GuideTab } from "../src/react/components/guideTab.jsx";

describe("GuideTab", () => {
  it("renders its sub-tab bar and opens on Overview", () => {
    render(<GuideTab />);
    // Every sub-tab is a button.
    for (const label of ["Overview", "Pipeline", "Stage badges", "Convergence", "Fix loops", "System", "Reading results"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    // Overview content is visible by default.
    expect(screen.getByText(/turns a natural-language hardware description/i)).toBeTruthy();
  });

  it("switches to the Convergence sub-tab and explains the strip", () => {
    render(<GuideTab />);
    fireEvent.click(screen.getByRole("button", { name: "Convergence" }));
    // The worked example the strip decodes (shown in the example chip and the note).
    expect(screen.getByText(/error count after each fix iteration/i)).toBeTruthy();
    expect(screen.getAllByText(/3→43→1/).length).toBeGreaterThan(0);
    // The trend glyphs are documented.
    expect(screen.getByText(/Regressing — badness rose/i)).toBeTruthy();
    expect(screen.getByText(/only one data point so far/i)).toBeTruthy();
    // Overview content is no longer shown.
    expect(screen.queryByText(/turns a natural-language hardware description/i)).toBeNull();
  });

  it("Fix loops sub-tab documents the loop guards", () => {
    render(<GuideTab />);
    fireEvent.click(screen.getByRole("button", { name: "Fix loops" }));
    expect(screen.getByText(/deletes the module body/i)).toBeTruthy();
    expect(screen.getAllByText(/best-known/i).length).toBeGreaterThan(0);
    // The reliability contract is documented (docs/reliability.md R1/R2/R3).
    expect(screen.getByText(/rejected, not adopted/i)).toBeTruthy();
    expect(screen.getByText(/maxStageMinutes/)).toBeTruthy();
    expect(screen.getByText(/only errors/i)).toBeTruthy();
  });

  it("System sub-tab documents the one-click reflow banner", () => {
    render(<GuideTab />);
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(screen.getAllByText(/re-run/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/rtlforge run --system/)).toBeTruthy();
  });
});
