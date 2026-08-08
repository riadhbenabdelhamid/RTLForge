// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// The export bundle carried RTL, testbenches and a manifest but never the
// SPEC, so the contract every artifact was built against could not leave the
// tool. It does now, in the three formats specImport reads — and the contract
// of that pairing is a clean round trip.

import { describe, it, expect, vi } from "vitest";
import { specToJson, specToYaml, specToMarkdown, specFiles } from "../src/utils/specExport.js";
import { importSpec } from "../src/utils/specImport.js";

const SPEC = {
  modName: "sync_fifo",
  domain: "Synchronous FIFO",
  requirements: [
    { id: "REQ-FUNC-001", cat: "Functionality", pri: "Must",
      desc: "The module shall store a word | even with a pipe in the text", rat: "[derived]" },
    { id: "REQ-INTF-001", cat: "Interface", pri: "Should", desc: "Ports are clk and q", rat: "r2" },
  ],
  iface: [
    { name: "clk", dir: "input", width: "1", desc: "System clock" },
    { name: "q", dir: "output", width: "DATA_W", desc: "read data", reset: "retains last value" },
  ],
  params: [{ name: "DEPTH", type: "parameter", def: 4, range: "[2:1024]", desc: "depth" }],
  // stage bookkeeping that must NOT be exported
  _llms: [{ tokensOut: 999 }],
  _log: "noise",
  _importedFrom: { filename: "x", format: "json" },
};

describe("specFiles", () => {
  it("emits all three formats, named after the module", () => {
    expect(Object.keys(specFiles(SPEC, "sync_fifo")).sort())
      .toEqual(["sync_fifo.json", "sync_fifo.md", "sync_fifo.yaml"]);
  });

  it("never leaks stage bookkeeping into any format", () => {
    for (const text of Object.values(specFiles(SPEC, "m"))) {
      expect(text).not.toContain("_llms");
      expect(text).not.toContain("_log");
      expect(text).not.toContain("_importedFrom");
      expect(text).not.toContain("999");
    }
  });
});

describe("round trip — export then import yields the same spec", () => {
  const canonical = importSpec(specToJson(SPEC), "s.json").spec;

  it("JSON round-trips", () => {
    const back = importSpec(specToJson(SPEC), "s.json");
    expect(back.ok).toBe(true);
    expect(back.spec.modName).toBe("sync_fifo");
    expect(back.spec.requirements).toHaveLength(2);
  });

  it("YAML round-trips to the identical object", () => {
    const back = importSpec(specToYaml(SPEC), "s.yaml");
    expect(back.ok).toBe(true);
    expect(JSON.stringify(back.spec)).toBe(JSON.stringify(canonical));
  });

  it("Markdown round-trips to the identical object", () => {
    const back = importSpec(specToMarkdown(SPEC), "s.md");
    expect(back.ok).toBe(true);
    expect(JSON.stringify(back.spec)).toBe(JSON.stringify(canonical));
  });

  it("survives a pipe inside a requirement description", () => {
    // specToMarkdown escapes it; a reader that split on every pipe would tear
    // the cell in half and silently move the tail into the next column
    const back = importSpec(specToMarkdown(SPEC), "s.md");
    expect(back.spec.requirements[0].desc).toContain("| even with a pipe");
    expect(back.spec.requirements[0].rat).toBe("[derived]");
  });

  it("keeps a numeric default numeric through every format", () => {
    for (const [text, name] of [[specToJson(SPEC), "s.json"], [specToYaml(SPEC), "s.yaml"], [specToMarkdown(SPEC), "s.md"]]) {
      expect(typeof importSpec(text, name).spec.params[0].def).toBe("number");
    }
  });

  it("quotes a YAML scalar that would otherwise read as a number or a keyword", () => {
    const tricky = Object.assign({}, SPEC, {
      iface: [{ name: "clk", dir: "input", width: "1", desc: "true" },
              { name: "q", dir: "output", width: "8", reset: "0", desc: "12" }],
    });
    const back = importSpec(specToYaml(tricky), "s.yaml");
    expect(back.ok).toBe(true);
    expect(back.spec.iface[0].desc).toBe("true");
    expect(back.spec.iface[1].desc).toBe("12");
  });

  it("a spec with no parameters still round-trips", () => {
    const noParams = Object.assign({}, SPEC, { params: [] });
    for (const [text, name] of [[specToJson(noParams), "s.json"], [specToYaml(noParams), "s.yaml"], [specToMarkdown(noParams), "s.md"]]) {
      const back = importSpec(text, name);
      expect(back.ok, name).toBe(true);
      expect(back.spec.params).toEqual([]);
    }
  });
});

describe("the spec stage reads an imported file instead of a model", () => {
  async function runSpecNode(text, filename, extra) {
    const { specNode } = await import("../src/pipeline/nodes/spec.js");
    const logs = [];
    const st = Object.assign({
      _specImport: { text, filename },
      _onLog: (m) => logs.push(m),
      _config: {},
    }, extra || {});
    return { out: await specNode(st), logs };
  }

  it("fills the stage, seeds elicit, and spends nothing", async () => {
    const { out, logs } = await runSpecNode(specToJson(SPEC), "mine.json");
    expect(out.spec.modName).toBe("sync_fifo");
    expect(out.spec.requirements).toHaveLength(2);
    expect(out.elicit.modName).toBe("sync_fifo");   // 14 downstream sites read this
    expect(out.elicit._fromImport).toBe(true);
    expect(out._llms).toEqual([]);                   // no model was called
    expect(out._llm).toBeNull();
    expect(out.spec._importedFrom).toMatchObject({ filename: "mine.json", format: "json" });
    expect(logs.join("\n")).toContain("SPEC IMPORTED");
  });

  it("aligns a category to its id prefix, as the generated path does", async () => {
    const s = JSON.stringify({
      modName: "m",
      requirements: [{ id: "REQ-FUNC-001", cat: "Interface", pri: "Must", desc: "d" }],
      iface: [{ name: "clk", dir: "input", width: "1" }],
      params: [],
    });
    const { out } = await runSpecNode(s, "m.json");
    expect(out.spec.requirements[0].cat).toBe("Functionality");
  });

  it("halts on a malformed file, naming the line and field, and generates nothing", async () => {
    const bad = `{
  "modName": "m",
  "requirements": [
    { "id": "REQ-FUNC-001", "pri": "Urgent", "desc": "d" }
  ],
  "iface": [{ "name": "clk", "dir": "input", "width": "1" }]
}`;
    await expect(runSpecNode(bad, "broken.json")).rejects.toThrow(/broken\.json:4/);
    await expect(runSpecNode(bad, "broken.json")).rejects.toThrow(/Must, Should or May/);
    await expect(runSpecNode(bad, "broken.json")).rejects.toThrow(/Nothing was generated/);
  });

  it("a SYSTEM run's decomposition still owns the module name", async () => {
    const { out, logs } = await runSpecNode(specToJson(SPEC), "m.json", { _modName: "u_fifo_type" });
    expect(out.spec.modName).toBe("u_fifo_type");
    expect(out.elicit.modName).toBe("u_fifo_type");
    expect(logs.join("\n")).toContain("MODULE NAME FROM DECOMPOSITION");
  });

  it("an empty import is ignored, so the normal generated path still runs", async () => {
    const { specNode } = await import("../src/pipeline/nodes/spec.js");
    // no _specImport text → falls through to the generating path, which needs
    // a model; the call failing proves it did NOT take the import branch
    await expect(specNode({ _specImport: { text: "   " }, _config: {}, _userDesc: "d" }))
      .rejects.toBeDefined();
  });
});
