// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ArchStage } from "../src/react/components/stages.jsx";

describe("ArchStage Module View tab (V22)", function() {
  const sampleSpec = {
    modName: "sync_fifo",
    iface: [
      { name: "clk",    dir: "input",  width: "1",      desc: "Clock" },
      { name: "rst_n",  dir: "input",  width: "1",      desc: "Async reset" },
      { name: "wr_en",  dir: "input",  width: "1",      desc: "Write enable" },
      { name: "din",    dir: "input",  width: "DATA_W", desc: "Write data" },
      { name: "rd_en",  dir: "input",  width: "1",      desc: "Read enable" },
      { name: "dout",   dir: "output", width: "DATA_W", desc: "Read data" },
      { name: "full",   dir: "output", width: "1",      desc: "FIFO full" },
      { name: "empty",  dir: "output", width: "1",      desc: "FIFO empty" },
    ],
    params: [
      { name: "DATA_W", def: 8,  range: "[1:1024]", desc: "Data width in bits" },
      { name: "DEPTH",  def: 16, range: "[2:1024]", desc: "Number of entries" },
    ],
    requirements: [],
  };
  const sampleArch = {
    strategy: "Synchronous FIFO with Gray-coded pointers",
    description: "A single-clock FIFO.",
    blocks: [{ name: "MemArray", desc: "x" }],
    mermaid: "graph TD\n  A-->B",
  };

  it("renders the Module View tab when spec has iface or params", function() {
    const { container } = render(<ArchStage data={sampleArch} spec={sampleSpec} />);
    expect(container.textContent).toMatch(/Module View/);
  });

  it("does NOT render Module View tab when spec is missing", function() {
    const { container } = render(<ArchStage data={sampleArch} spec={undefined} />);
    expect(container.textContent).not.toMatch(/Module View/);
  });

  it("does NOT render Module View tab when spec has empty iface AND empty params", function() {
    const { container } = render(
      <ArchStage data={sampleArch} spec={{ iface: [], params: [] }} />
    );
    expect(container.textContent).not.toMatch(/Module View/);
  });

  it("clicking Module View tab shows the SVG diagram with the module name", function() {
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={sampleSpec} />);
    fireEvent.click(getByText("Module View"));
    // The SVG has an aria-label including the module name
    const svg = container.querySelector("svg[aria-label*='sync_fifo']");
    expect(svg).toBeTruthy();
    // Module name text inside the box
    const txt = container.textContent;
    expect(txt).toMatch(/sync_fifo/);
  });

  it("Module View renders all input and output port labels", function() {
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={sampleSpec} />);
    fireEvent.click(getByText("Module View"));
    const txt = container.textContent;
    // Inputs
    expect(txt).toMatch(/clk/);
    expect(txt).toMatch(/rst_n/);
    expect(txt).toMatch(/wr_en/);
    expect(txt).toMatch(/din/);
    // Outputs
    expect(txt).toMatch(/dout/);
    expect(txt).toMatch(/full/);
    expect(txt).toMatch(/empty/);
  });

  it("Module View shows width annotations for multi-bit ports", function() {
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={sampleSpec} />);
    fireEvent.click(getByText("Module View"));
    // DATA_W bus width should appear
    expect(container.textContent).toMatch(/\[DATA_W\]/);
  });

  it("Module View lists parameters with their values and descriptions", function() {
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={sampleSpec} />);
    fireEvent.click(getByText("Module View"));
    const txt = container.textContent;
    expect(txt).toMatch(/DATA_W/);
    expect(txt).toMatch(/Data width in bits/);
    expect(txt).toMatch(/DEPTH/);
    expect(txt).toMatch(/Number of entries/);
    // Default values are shown
    expect(txt).toMatch(/= 8/);
    expect(txt).toMatch(/= 16/);
    // Range
    expect(txt).toMatch(/\[1:1024\]/);
  });

  it("Module View shows '(no interface ports declared)' when iface is empty but params exist", function() {
    const specOnlyParams = {
      modName: "constants_pkg",
      iface: [],
      params: [{ name: "WIDTH", def: 8, range: "[1:1024]", desc: "Bus width" }],
      requirements: [],
    };
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={specOnlyParams} />);
    fireEvent.click(getByText("Module View"));
    expect(container.textContent).toMatch(/no interface ports declared/);
    expect(container.textContent).toMatch(/WIDTH/);
  });

  it("Module View shows '(no parameters declared)' when params is empty but iface exists", function() {
    const specOnlyPorts = {
      modName: "buf_wire",
      iface: [
        { name: "in",  dir: "input",  width: "8", desc: "" },
        { name: "out", dir: "output", width: "8", desc: "" },
      ],
      params: [],
      requirements: [],
    };
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={specOnlyPorts} />);
    fireEvent.click(getByText("Module View"));
    expect(container.textContent).toMatch(/no parameters declared/);
  });

  it("module-name fallback chain: uses 'module' when spec has no modName/moduleName", function() {
    const spec = {
      iface: [{ name: "x", dir: "input", width: "1", desc: "" }],
      params: [],
      requirements: [],
    };
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={spec} />);
    fireEvent.click(getByText("Module View"));
    // The SVG header should fall back to "module"
    const svg = container.querySelector("svg[aria-label*='module']");
    expect(svg).toBeTruthy();
  });

  it("handles inout direction with an inout badge", function() {
    const spec = {
      modName: "bidir",
      iface: [
        { name: "clk",     dir: "input",  width: "1", desc: "" },
        { name: "io_pad",  dir: "inout",  width: "8", desc: "Bidir pad" },
      ],
      params: [],
      requirements: [],
    };
    const { container, getByText } = render(<ArchStage data={sampleArch} spec={spec} />);
    fireEvent.click(getByText("Module View"));
    const txt = container.textContent;
    expect(txt).toMatch(/io_pad/);
    expect(txt).toMatch(/inout/);
  });
});
