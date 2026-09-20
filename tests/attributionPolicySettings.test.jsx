// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid
import React, { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { WorkflowTab } from "../src/react/components/workflow.jsx";
import { defaultProjectConfig } from "../src/react/useProject.jsx";

describe("attribution policy settings", () => {
  it("defaults to auto and updates the persisted config field without changing other settings", () => {
    let selected;
    function Settings() {
      const [config, setConfig] = useState({ attributionPolicy: defaultProjectConfig().attributionPolicy,
        optionalStages: { formal_verify: true } });
      selected = config;
      return <WorkflowTab config={config} setConfig={setConfig} />;
    }
    const { getByLabelText, getByText } = render(<Settings />);
    const field = getByLabelText("Attribution policy");
    expect(field.value).toBe("auto");
    expect([...field.options].map(o => o.value)).toEqual(["auto", "strict", "relaxed"]);
    expect(getByText(/Auto uses strict in semi-auto and relaxed in full-auto/)).toBeTruthy();
    for (const policy of ["strict", "relaxed", "auto"]) {
      fireEvent.change(field, { target: { value: policy } });
      expect(selected).toEqual({ attributionPolicy: policy, optionalStages: { formal_verify: true } });
      expect(field.value).toBe(policy);
    }
  });
});
