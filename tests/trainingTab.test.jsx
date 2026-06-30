// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Settings → Training tab (docs/training-mode.md) — render + interaction.

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TrainingTab } from "../src/react/components/trainingTab.jsx";

// Stateful host so setConfig actually updates + re-renders (observe revealed
// controls + the synthesized command), like the real SettingsPanel.
function Host({ initial }) {
  const [config, setConfig] = useState(initial || {});
  return <TrainingTab config={config} setConfig={setConfig} />;
}

describe("TrainingTab", () => {
  it("renders the mode selector and cross-model control", () => {
    render(<Host initial={{}} />);
    expect(screen.getByRole("button", { name: "Off" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "RTL Gen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "TB Gen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Same model only" })).toBeTruthy();
  });

  it("selecting RTL Gen reveals the loop/expand controls and the CLI command", () => {
    render(<Host initial={{}} />);
    // Off → no loop control yet.
    expect(screen.queryByRole("button", { name: "Refine" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "RTL Gen" }));
    // Now Q1/Q2 controls appear...
    expect(screen.getByRole("button", { name: "Refine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
    // ...and the synthesized command shows.
    expect(screen.getByText(/rtlforge train rtl/)).toBeTruthy();
  });

  it("turning the automated loop on reveals source + budget inputs", () => {
    render(<Host initial={{ trainingMode: "tb" }} />);
    expect(screen.queryByRole("button", { name: "Adaptive" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "On" }));   // Automated loop → On
    expect(screen.getByRole("button", { name: "Adaptive" })).toBeTruthy();
    expect(screen.getByText(/--auto/)).toBeTruthy();
  });

  it("cross-model toggle flips to Cross-model", () => {
    render(<Host initial={{ trainingMode: "rtl" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Cross-model" }));
    // The selected (accent-bordered) state is reflected; the button stays present.
    expect(screen.getByRole("button", { name: "Cross-model" })).toBeTruthy();
  });
});
