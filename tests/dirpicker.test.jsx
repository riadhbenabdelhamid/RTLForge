// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { DirPickerInput } from "../src/react/components/panels.jsx";

describe("DirPickerInput", function() {
  it("renders text input + browse button", function() {
    const handleChange = function() {};
    const { getByPlaceholderText, getByText } = render(
      <DirPickerInput value="" onChange={handleChange} placeholder="/path/to/lib" />
    );
    expect(getByPlaceholderText("/path/to/lib")).toBeTruthy();
    expect(getByText(/Browse/).tagName).toBe("BUTTON");
  });
  it("displays current value", function() {
    const handleChange = function() {};
    const { getByDisplayValue } = render(
      <DirPickerInput value="/home/user/lib" onChange={handleChange} placeholder="" />
    );
    expect(getByDisplayValue("/home/user/lib")).toBeTruthy();
  });
});
