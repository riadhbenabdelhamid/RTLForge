// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { WorkflowTab } from "../src/react/components/workflow.jsx";

describe("WorkflowTab observer integration (V22)", function() {
  it("does NOT render observer block in diagram when observerEnabled is false", function() {
    const { container } = render(
      <WorkflowTab
        config={{ workflow: "rtl", optionalStages: {} }}
        setConfig={function() {}}
      />
    );
    // The "Observer Agent" label inside the SVG block is what we're
    // checking for — when disabled, no rect with stroke-dasharray="4,3"
    // exists (that's the observer block's distinctive marker).
    const obsRect = container.querySelector('rect[stroke-dasharray="4,3"]');
    expect(obsRect).toBeNull();
    // Legend item should also be absent
    expect(container.textContent).not.toMatch(/observer signal/);
  });

  it("renders observer block + dotted-line legend entry when enabled", function() {
    const { container } = render(
      <WorkflowTab
        config={{ workflow: "rtl", optionalStages: {}, observerEnabled: true }}
        setConfig={function() {}}
      />
    );
    expect(container.textContent).toMatch(/Observer Agent/);
    expect(container.textContent).toMatch(/observer signal/);
    // The observer block has a sub-label
    expect(container.textContent).toMatch(/knowledge \/ drift \/ cost/);
  });

  it("renders dotted lines from observer to each enabled stage", function() {
    const { container } = render(
      <WorkflowTab
        config={{ workflow: "rtl", optionalStages: {}, observerEnabled: true }}
        setConfig={function() {}}
      />
    );
    // Lines with strokeDasharray="3,3" are the observer connectors
    const dottedLines = container.querySelectorAll('line[stroke-dasharray="3,3"]');
    // At least one per pipeline stage
    expect(dottedLines.length).toBeGreaterThanOrEqual(7);
  });

  it("clicking observer block opens the detail panel with extraction + surfacing sections", function() {
    let lastConfigPatch = null;
    const setConfig = function(fn) {
      const result = fn({ workflow: "rtl", optionalStages: {}, observerEnabled: true });
      lastConfigPatch = result;
    };
    const { container, getByText } = render(
      <WorkflowTab
        config={{ workflow: "rtl", optionalStages: {}, observerEnabled: true }}
        setConfig={setConfig}
      />
    );
    // Find the observer SVG rect and click it. There's only one element
    // with this exact text combination ("Observer Agent" + dotted-stroke).
    const observerText = getByText("Observer Agent");
    expect(observerText).toBeTruthy();
    // Click via the parent <g> element (the rect itself handles onClick)
    const obsRect = container.querySelector('rect[stroke-dasharray="4,3"]');
    expect(obsRect).toBeTruthy();
    fireEvent.click(obsRect);

    // Detail panel opens. The panel header should now display "Observer Agent"
    // in a different style (it appears twice: once in the SVG, once in the
    // detail panel). textContent will contain it; we instead check for the
    // default-prompt section titles.
    expect(container.textContent).toMatch(/Extraction — System Identity/);
    expect(container.textContent).toMatch(/Extraction — Schema/);
    expect(container.textContent).toMatch(/Extraction — Rules/);
    expect(container.textContent).toMatch(/Surfacing — Template/);
  });
});
