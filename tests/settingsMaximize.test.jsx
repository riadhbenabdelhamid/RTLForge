// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SettingsPanel } from "../src/react/components/panels.jsx";

describe("SettingsPanel maximize button (V22 #7)", function() {
  const baseConfig = {
    provider: "anthropic", apiKey: "", model: "", temperature: 0.2,
    useGlobalLLM: true, stageSettings: {},
  };

  function noop() {}

  it("renders both maximize and close buttons", function() {
    const { container, getByLabelText } = render(
      <SettingsPanel
        config={baseConfig}
        setConfig={noop}
        onClose={noop}
        importedPackages={{}}
        onDeletePackage={noop}
        onRedownloadPackage={noop}
        onClearLibrary={noop}
        checkpointIndex={[]}
        onDeleteCheckpoint={noop}
        onClearCheckpoints={noop}
        onBackendVerified={noop}
        onSave={noop}
      />
    );
    // Both controls present
    expect(getByLabelText("Maximize window")).toBeTruthy();
    expect(getByLabelText("Close settings")).toBeTruthy();
    // Initially the dialog has the small width
    const dialog = container.querySelector('div[style*="width: 700"]');
    expect(dialog).toBeTruthy();
  });

  it("clicking maximize switches to full-viewport size and changes the icon to 'restore'", function() {
    const { container, getByLabelText } = render(
      <SettingsPanel
        config={baseConfig}
        setConfig={noop}
        onClose={noop}
        importedPackages={{}}
        checkpointIndex={[]}
      />
    );
    const maxBtn = getByLabelText("Maximize window");
    fireEvent.click(maxBtn);
    // Now should be in maximized state — the original "Maximize window"
    // button has been replaced with the "Restore window size" one.
    expect(getByLabelText("Restore window size")).toBeTruthy();
    // The dialog now uses calc-based viewport sizing
    const maximizedDialog = container.querySelector('div[style*="calc(100vw"]');
    expect(maximizedDialog).toBeTruthy();
  });

  it("clicking maximize twice toggles back to normal size", function() {
    const { container, getByLabelText } = render(
      <SettingsPanel
        config={baseConfig}
        setConfig={noop}
        onClose={noop}
        importedPackages={{}}
        checkpointIndex={[]}
      />
    );
    fireEvent.click(getByLabelText("Maximize window"));
    fireEvent.click(getByLabelText("Restore window size"));
    // Back to the normal "Maximize" button
    expect(getByLabelText("Maximize window")).toBeTruthy();
    // Small-width dialog restored
    expect(container.querySelector('div[style*="width: 700"]')).toBeTruthy();
  });

  it("Esc key restores from maximized", function() {
    const { getByLabelText } = render(
      <SettingsPanel
        config={baseConfig}
        setConfig={noop}
        onClose={noop}
        importedPackages={{}}
        checkpointIndex={[]}
      />
    );
    fireEvent.click(getByLabelText("Maximize window"));
    expect(getByLabelText("Restore window size")).toBeTruthy();
    // Send Esc on the document
    fireEvent.keyDown(document, { key: "Escape" });
    // Should be back to non-maximized
    expect(getByLabelText("Maximize window")).toBeTruthy();
  });
});
