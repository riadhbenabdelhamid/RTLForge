// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Regression: toggling "Strict CLI mode" in the CLI settings tab crashed with
// "Cannot read properties of undefined (reading 'strictCli')" because the
// onChange updater read `c.c.strictCli` (double `.c`) instead of `c.strictCli`.
// A stateful harness makes the real setConfig updater run, reproducing it.

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, fireEvent } from "@testing-library/react";
import { SettingsPanel } from "../src/react/components/panels.jsx";

function Harness({ initial }) {
  const [config, setConfig] = useState(initial);
  return (
    <SettingsPanel
      config={config}
      setConfig={(fn) => setConfig((c) => fn(c))}
      onClose={() => {}}
      importedPackages={{}}
      checkpointIndex={[]}
    />
  );
}

describe("CLI settings tab — Strict CLI toggle", () => {
  const base = {
    provider: "anthropic", apiKey: "", model: "", temperature: 0.2,
    useGlobalLLM: true, stageSettings: {},
    backendUrl: "http://localhost:3001", strictCli: false,
  };

  it("toggles strictCli on/off without a render crash", () => {
    const { getAllByText, getByText } = render(<Harness initial={base} />);
    // Open the CLI tab (label "CLI"); the tab button is the first match.
    fireEvent.click(getAllByText("CLI")[0]);

    const label = getByText("Strict CLI mode").closest("label");
    const checkbox = label.querySelector('input[type="checkbox"]');
    expect(checkbox.checked).toBe(false);

    // This click runs the setConfig updater — the bug threw right here.
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    // And back off again.
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("defaults to CHECKED when strictCli is absent/undefined (hardened: on unless explicitly off)", () => {
    const noKey = Object.assign({}, base);
    delete noKey.strictCli;   // config that never set strictCli
    const { getAllByText, getByText } = render(<Harness initial={noKey} />);
    fireEvent.click(getAllByText("CLI")[0]);
    const checkbox = getByText("Strict CLI mode").closest("label").querySelector('input[type="checkbox"]');
    expect(checkbox.checked).toBe(true);          // absent → on
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);         // explicit opt-out still works
  });
});
