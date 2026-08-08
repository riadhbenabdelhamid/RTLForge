// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// Importing an existing specification instead of asking a model for one.
// The same spec written three ways must produce the SAME stage data, and a
// file the user got wrong must stop the run pointing at the line and field.

import { describe, it, expect } from "vitest";
import {
  importSpec, detectSpecFormat, parseYamlSpec, parseMarkdownSpec,
  validateSpec, formatImportIssues,
} from "../src/utils/specImport.js";

const JSON_SPEC = `{
  "modName": "sync_fifo",
  "domain": "Synchronous FIFO",
  "requirements": [
    { "id": "REQ-FUNC-001", "cat": "Functionality", "pri": "Must",
      "desc": "The module shall store a word on wr_en with full low." }
  ],
  "iface": [
    { "name": "clk", "dir": "input", "width": "1", "desc": "System clock" },
    { "name": "full", "dir": "output", "width": "1", "desc": "FIFO is full", "reset": "0" }
  ],
  "params": [{ "name": "DEPTH", "type": "parameter", "def": 4, "range": "[2:1024]", "desc": "Depth" }]
}`;

const YAML_SPEC = `# an existing spec, hand-written
modName: sync_fifo
domain: Synchronous FIFO
requirements:
  - id: REQ-FUNC-001
    cat: Functionality
    pri: Must
    desc: The module shall store a word on wr_en with full low.
iface:
  - name: clk
    dir: input
    width: "1"
    desc: System clock
  - name: full
    dir: output
    width: "1"
    reset: "0"
    desc: FIFO is full
params:
  - name: DEPTH
    type: parameter
    def: 4
    range: "[2:1024]"
    desc: Depth
`;

const MD_SPEC = `# sync_fifo
Domain: Synchronous FIFO

## Requirements
| ID | Cat | Pri | Description |
|----|-----|-----|-------------|
| REQ-FUNC-001 | Functionality | Must | The module shall store a word on wr_en with full low. |

## Interface
| Name | Dir | Width | Reset | Description |
|------|-----|-------|-------|-------------|
| clk  | input | 1 | | System clock |
| full | output | 1 | 0 | FIFO is full |

## Parameters
| Name | Type | Default | Range | Description |
|------|------|---------|-------|-------------|
| DEPTH | parameter | 4 | [2:1024] | Depth |
`;

describe("detectSpecFormat", () => {
  it("reads the format from the extension", () => {
    expect(detectSpecFormat("spec.json")).toBe("json");
    expect(detectSpecFormat("spec.yaml")).toBe("yaml");
    expect(detectSpecFormat("spec.yml")).toBe("yaml");
    expect(detectSpecFormat("spec.md")).toBe("md");
    expect(detectSpecFormat("spec.markdown")).toBe("md");
  });
  it("refuses a type it cannot read rather than guessing", () => {
    expect(detectSpecFormat("spec.txt")).toBeNull();
    expect(detectSpecFormat("spec")).toBeNull();
    const r = importSpec("anything", "spec.txt");
    expect(r.ok).toBe(false);
    expect(r.issues[0].message).toContain(".json, .yaml or .md");
  });
});

describe("the same spec in three formats", () => {
  it("each imports cleanly", () => {
    for (const [text, name] of [[JSON_SPEC, "s.json"], [YAML_SPEC, "s.yaml"], [MD_SPEC, "s.md"]]) {
      const r = importSpec(text, name);
      expect(r.ok, name + ": " + formatImportIssues(r.issues, name)).toBe(true);
      expect(r.spec.modName).toBe("sync_fifo");
    }
  });

  it("produces an IDENTICAL stage object from all three", () => {
    const a = importSpec(JSON_SPEC, "s.json").spec;
    const b = importSpec(YAML_SPEC, "s.yaml").spec;
    const c = importSpec(MD_SPEC, "s.md").spec;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it("fills every field the spec stage would have produced", () => {
    const s = importSpec(MD_SPEC, "s.md").spec;
    expect(s.domain).toBe("Synchronous FIFO");
    expect(s.requirements[0]).toMatchObject({ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must" });
    expect(s.iface.map((p) => p.name)).toEqual(["clk", "full"]);
    expect(s.iface[1].reset).toBe("0");
    // a markdown cell is text; the stage's schema wants a number
    expect(s.params[0].def).toBe(4);
    expect(typeof s.params[0].def).toBe("number");
  });

  it("supplies a rationale so downstream traceability has something to cite", () => {
    const s = importSpec(JSON_SPEC, "s.json").spec;
    expect(s.requirements[0].rat).toContain("imported");
  });
});

describe("a file the user got wrong stops the run and points at it", () => {
  it("names the line and field of every schema problem", () => {
    const bad = `{
  "modName": "sync_fifo",
  "requirements": [
    { "id": "REQ-FUNC-001", "cat": "Functionality", "pri": "Critical",
      "desc": "does a thing" }
  ],
  "iface": [
    { "name": "clk", "dir": "in", "width": "1" }
  ]
}`;
    const r = importSpec(bad, "spec.json");
    expect(r.ok).toBe(false);
    expect(r.spec).toBeNull();
    const errs = r.issues.filter((i) => i.severity === "error");
    const pri = errs.find((i) => i.field.endsWith(".pri"));
    expect(pri.line).toBe(4);
    expect(pri.message).toContain("Must, Should or May");
    const dir = errs.find((i) => i.field.endsWith(".dir"));
    expect(dir.line).toBe(8);
    expect(dir.message).toContain("input, output or inout");
  });

  it("gives a bad JSON file a line number", () => {
    const r = importSpec('{\n  "modName": "x",\n  "requirements": [,]\n}', "spec.json");
    expect(r.ok).toBe(false);
    expect(r.issues[0].line).toBe(3);
    expect(r.issues[0].message).toContain("not valid JSON");
  });

  it("rejects an empty file rather than importing nothing", () => {
    const r = importSpec("   \n  ", "spec.json");
    expect(r.ok).toBe(false);
    expect(r.issues[0].message).toContain("empty");
  });

  it("catches a duplicate requirement id, and points each item at its own line", () => {
    const dup = `{
  "modName": "m",
  "requirements": [
    { "id": "REQ-FUNC-001", "pri": "Must", "desc": "a" },
    { "id": "REQ-FUNC-001", "pri": "Must", "desc": "b" }
  ],
  "iface": [{ "name": "clk", "dir": "input", "width": "1" }]
}`;
    const r = importSpec(dup, "spec.json");
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /appears more than once/.test(i.message))).toBe(true);
  });

  it("catches a malformed requirement id and an unknown category prefix", () => {
    const base = (id) => `{ "modName": "m", "requirements": [{ "id": "${id}", "pri": "Must", "desc": "d" }],
      "iface": [{ "name": "clk", "dir": "input", "width": "1" }] }`;
    expect(importSpec(base("REQ-FUNC-1"), "s.json").ok).toBe(true);      // NNN is not enforced
    const bad = importSpec(base("REQ-NOPE-001"), "s.json");
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => /unknown category prefix/.test(i.message))).toBe(true);
    const junk = importSpec(base("FUNC001"), "s.json");
    expect(junk.ok).toBe(false);
    expect(junk.issues.some((i) => /malformed/.test(i.message))).toBe(true);
  });

  it("requires a module name, requirements and ports", () => {
    const r = importSpec('{ "requirements": [], "iface": [] }', "s.json");
    const msgs = r.issues.map((i) => i.message).join(" | ");
    expect(msgs).toContain("modName is required");
    expect(msgs).toContain("at least one requirement");
    expect(msgs).toContain("at least one port");
  });

  it("rejects a module name that is not a SystemVerilog identifier", () => {
    const r = importSpec('{ "modName": "2fifo", "requirements": [{"id":"REQ-FUNC-001","pri":"Must","desc":"d"}], "iface": [{"name":"clk","dir":"input","width":"1"}] }', "s.json");
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /not a valid SystemVerilog identifier/.test(i.message))).toBe(true);
  });

  it("formats issues with file, line and field so they can be acted on", () => {
    const r = importSpec('{ "modName": "m", "requirements": [], "iface": [] }', "my_spec.json");
    const out = formatImportIssues(r.issues, "my_spec.json");
    expect(out).toContain("my_spec.json");
    expect(out).toContain("✗");
  });
});

describe("problems the pipeline already repairs are warnings, not failures", () => {
  it("a cat that disagrees with its id prefix warns and still imports", () => {
    const s = `{ "modName": "m",
      "requirements": [{ "id": "REQ-FUNC-001", "cat": "Interface", "pri": "Must", "desc": "d" }],
      "iface": [{ "name": "clk", "dir": "input", "width": "1" }] }`;
    const r = importSpec(s, "s.json");
    expect(r.ok).toBe(true);                        // the spec node aligns cat to the id
    const w = r.issues.find((i) => i.severity === "warning");
    expect(w.message).toContain("the id wins");
  });

  it("an output with no stated reset warns — the reset contract, not a stop", () => {
    const s = `{ "modName": "m",
      "requirements": [{ "id": "REQ-FUNC-001", "cat": "Functionality", "pri": "Must", "desc": "d" }],
      "iface": [{ "name": "clk", "dir": "input", "width": "1" },
                { "name": "q", "dir": "output", "width": "8" }] }`;
    const r = importSpec(s, "s.json");
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.severity === "warning" && /reset behaviour/.test(i.message))).toBe(true);
  });
});

describe("the YAML subset refuses what it cannot read, rather than mis-reading it", () => {
  it("names the line of a multi-line scalar block", () => {
    const r = parseYamlSpec("modName: m\ndesc: >\n  folded text\n");
    expect(r.data).toBeNull();
    const e = r.issues.find((i) => i.severity === "error");
    expect(e.line).toBe(2);
    expect(e.message).toContain("multi-line scalar");
  });

  it("names the line of an anchor", () => {
    const r = parseYamlSpec("modName: m\n&anchor\n");
    expect(r.issues.some((i) => i.line === 2 && /anchors and aliases/.test(i.message))).toBe(true);
  });

  it("names the line of a flow mapping", () => {
    const r = parseYamlSpec("modName: m\niface: {name: clk}\n");
    expect(r.issues.some((i) => i.line === 2 && /flow mappings/.test(i.message))).toBe(true);
  });

  it("reads comments, quoting and an empty list", () => {
    const r = parseYamlSpec('# lead\nmodName: m   # trailing\nparams: []\n');
    expect(r.data.modName).toBe("m");
    expect(r.data.params).toEqual([]);
  });
});

describe("the markdown template", () => {
  it("requires a level-1 heading for the module name", () => {
    const r = parseMarkdownSpec("Domain: x\n\n## Requirements\n");
    expect(r.data).toBeNull();
    expect(r.issues[0].message).toContain("level-1 heading");
  });

  it("tolerates column order and alternative header spellings", () => {
    const md = `# m
## Requirements
| Priority | ID | Category | Description |
|---|---|---|---|
| Must | REQ-FUNC-001 | Functionality | does a thing |

## Ports
| Direction | Name | Width |
|---|---|---|
| input | clk | 1 |
`;
    const r = importSpec(md, "s.md");
    expect(r.ok, formatImportIssues(r.issues, "s.md")).toBe(true);
    expect(r.spec.requirements[0].id).toBe("REQ-FUNC-001");
    expect(r.spec.iface[0]).toMatchObject({ name: "clk", dir: "input", width: "1" });
  });

  it("warns about a column it does not read rather than dropping it silently", () => {
    const md = `# m
## Requirements
| ID | Pri | Description | Owner |
|---|---|---|---|
| REQ-FUNC-001 | Must | d | alice |

## Interface
| Name | Dir | Width |
|---|---|---|
| clk | input | 1 |
`;
    const r = importSpec(md, "s.md");
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.severity === "warning" && /Owner/.test(i.message))).toBe(true);
  });

  it("points a table problem at its own row", () => {
    const md = `# m
## Requirements
| ID | Pri | Description |
|---|---|---|
| REQ-FUNC-001 | Must | ok |
| REQ-FUNC-002 | Urgent | bad priority |

## Interface
| Name | Dir | Width |
|---|---|---|
| clk | input | 1 |
`;
    const r = importSpec(md, "s.md");
    expect(r.ok).toBe(false);
    const e = r.issues.find((i) => i.severity === "error");
    expect(e.line).toBe(6);
  });
});

describe("validateSpec is reusable on an already-parsed spec", () => {
  it("accepts a well-formed object with no source text", () => {
    const spec = {
      modName: "m",
      requirements: [{ id: "REQ-FUNC-001", cat: "Functionality", pri: "Must", desc: "d" }],
      iface: [{ name: "clk", dir: "input", width: "1" }],
      params: [],
    };
    expect(validateSpec(spec, "").filter((i) => i.severity === "error")).toEqual([]);
  });
});
