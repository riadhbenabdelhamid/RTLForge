// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

// ═══════════════════════════════════════════════════════════════════════════
// Tests for utils/promptYaml.js
//
// The most important invariant is round-trip stability: serialise → parse →
// serialise should produce byte-identical output. If that holds, users can
// safely edit YAML files in any text editor and re-import.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import {
  serializeStageYaml,
  serializeAllStagesYaml,
  parsePromptYaml,
  importPromptYaml,
  YamlParseError,
} from "../src/utils/promptYaml.js";

describe("serializeStageYaml", function() {
  it("produces well-formed single-stage YAML", function() {
    const yaml = serializeStageYaml("rtl_generate", [
      { title: "System Identity", content: "You are RTL Forge." },
      { title: "Task", content: "Generate RTL." },
    ]);
    expect(yaml).toContain("stage: rtl_generate");
    expect(yaml).toContain("sections:");
    expect(yaml).toContain("- title: System Identity");
    expect(yaml).toContain("You are RTL Forge.");
  });

  it("uses block scalar (|) for multi-line content", function() {
    const yaml = serializeStageYaml("test", [
      { title: "Multi", content: "line 1\nline 2\nline 3" },
    ]);
    // The block-scalar indicator should appear on the content line
    expect(yaml).toMatch(/content: \|/);
    expect(yaml).toContain("line 1");
    expect(yaml).toContain("line 2");
    expect(yaml).toContain("line 3");
  });

  it("quotes titles that contain special characters", function() {
    const yaml = serializeStageYaml("test", [
      { title: "Has: a colon", content: "x" },
    ]);
    // Colons in titles must be quoted to round-trip
    expect(yaml).toContain('"Has: a colon"');
  });

  it("quotes titles that look like booleans or numbers", function() {
    const yaml = serializeStageYaml("test", [
      { title: "true",  content: "x" },
      { title: "42",    content: "y" },
      { title: "yes",   content: "z" },
    ]);
    expect(yaml).toContain('"true"');
    expect(yaml).toContain('"42"');
    expect(yaml).toContain('"yes"');
  });
});

describe("parsePromptYaml", function() {
  it("parses a simple single-stage document", function() {
    const yaml = `stage: rtl_generate
sections:
  - title: System Identity
    content: |
      You are RTL Forge.
  - title: Task
    content: |
      Generate RTL.
`;
    const parsed = parsePromptYaml(yaml);
    expect(parsed.stage).toBe("rtl_generate");
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0].title).toBe("System Identity");
    expect(parsed.sections[0].content).toBe("You are RTL Forge.\n");
    expect(parsed.sections[1].title).toBe("Task");
  });

  it("ignores comment lines", function() {
    const yaml = `# header comment
stage: spec
# another comment
sections: []
`;
    const parsed = parsePromptYaml(yaml);
    expect(parsed.stage).toBe("spec");
    expect(parsed.sections).toEqual([]);
  });

  it("preserves multi-line content fully", function() {
    const yaml = `stage: rtl
sections:
  - title: Long
    content: |
      Line 1
      Line 2

      Line 4 (after blank)
      Line 5
`;
    const parsed = parsePromptYaml(yaml);
    expect(parsed.sections[0].content).toBe("Line 1\nLine 2\n\nLine 4 (after blank)\nLine 5\n");
  });

  it("handles strip-final-newline indicator |-", function() {
    const yaml = `stage: x
sections:
  - title: Strip
    content: |-
      no trailing newline
`;
    const parsed = parsePromptYaml(yaml);
    expect(parsed.sections[0].content).toBe("no trailing newline");
  });

  it("throws YamlParseError on malformed indentation", function() {
    // Mid-block indent jump (no key, just an indented line) is malformed.
    const yaml = "stage: x\nsections:\n   bad: random_indent_jump\n";
    expect(function() { parsePromptYaml(yaml); }).toThrow(YamlParseError);
  });
});

describe("round-trip stability", function() {
  it("single-stage: serialize → parse → serialize is byte-identical", function() {
    const sections = [
      { title: "System Identity", content: "You are RTL Forge.\n" },
      { title: "Task",            content: "Generate RTL.\n" },
      { title: "Multi-line",      content: "Step 1\nStep 2\nStep 3\n" },
    ];
    const yaml1 = serializeStageYaml("rtl_generate", sections);
    const parsed = parsePromptYaml(yaml1);
    const yaml2 = serializeStageYaml(parsed.stage, parsed.sections);
    expect(yaml2).toBe(yaml1);
  });

  it("titles with special chars survive round-trip", function() {
    const sections = [
      { title: "Section: with colon", content: "ok\n" },
      { title: "Has \"quotes\"",      content: "ok\n" },
    ];
    const yaml1 = serializeStageYaml("test", sections);
    const parsed = parsePromptYaml(yaml1);
    expect(parsed.sections[0].title).toBe("Section: with colon");
    expect(parsed.sections[1].title).toBe('Has "quotes"');
  });
});

describe("serializeAllStagesYaml + multi-stage parsing", function() {
  it("serialises multiple stages and round-trips", function() {
    const stagesObj = {
      rtl_generate:  [{ title: "Task", content: "rtl\n" }],
      test_generate: [{ title: "Task", content: "tb\n" }],
    };
    const yaml1 = serializeAllStagesYaml(stagesObj);
    expect(yaml1).toContain("stages:");
    expect(yaml1).toContain("rtl_generate:");
    expect(yaml1).toContain("test_generate:");

    const parsed = parsePromptYaml(yaml1);
    expect(parsed.stages.rtl_generate.sections[0].content).toBe("rtl\n");
    expect(parsed.stages.test_generate.sections[0].content).toBe("tb\n");
  });

  it("emits stages in deterministic (alphabetical) order", function() {
    const stagesObj = {
      verify:       [{ title: "x", content: "a\n" }],
      architect:    [{ title: "x", content: "a\n" }],
      rtl_generate: [{ title: "x", content: "a\n" }],
    };
    const yaml = serializeAllStagesYaml(stagesObj);
    // Find positions of each stage
    const archPos   = yaml.indexOf("  architect:");
    const rtlPos    = yaml.indexOf("  rtl_generate:");
    const verifyPos = yaml.indexOf("  verify:");
    expect(archPos).toBeLessThan(rtlPos);
    expect(rtlPos).toBeLessThan(verifyPos);
  });
});

describe("importPromptYaml — high-level helper", function() {
  it("auto-detects single-stage shape", function() {
    const yaml = `stage: rtl_generate
sections:
  - title: A
    content: |
      hello
`;
    const result = importPromptYaml(yaml);
    expect(result.kind).toBe("single");
    expect(result.stageKey).toBe("rtl_generate");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].content).toBe("hello\n");
  });

  it("auto-detects bundle shape", function() {
    const yaml = `stages:
  rtl_generate:
    sections:
      - title: A
        content: |
          rtl
  test_generate:
    sections:
      - title: B
        content: |
          tb
`;
    const result = importPromptYaml(yaml);
    expect(result.kind).toBe("bundle");
    expect(Object.keys(result.stages).sort()).toEqual(["rtl_generate", "test_generate"]);
  });

  it("rejects YAML with neither 'stage' nor 'stages'", function() {
    expect(function() { importPromptYaml("foo: bar\n"); }).toThrow(/'stage'.*'stages'/);
  });

  it("rejects sections list with missing title", function() {
    const yaml = `stage: x
sections:
  - content: |
      no title here
`;
    expect(function() { importPromptYaml(yaml); }).toThrow(/title/);
  });

  it("preserves user-added sections beyond the defaults (the imported list IS the truth)", function() {
    // This is the contract for "yaml file can ADD new sections that show up
    // in the workflow when imported": the importer returns the full list,
    // the caller stores it via setPromptSections, and getPromptSections will
    // then return ALL sections including new ones.
    const yaml = `stage: rtl_generate
sections:
  - title: System Identity
    content: |
      base
  - title: My Custom Rule
    content: |
      always use UVM
  - title: Output Schema
    content: |
      json shape
`;
    const result = importPromptYaml(yaml);
    expect(result.sections).toHaveLength(3);
    expect(result.sections.map(function(s) { return s.title; })).toEqual([
      "System Identity",
      "My Custom Rule",
      "Output Schema",
    ]);
  });
});

describe("YamlParseError", function() {
  it("carries line number and isYamlParseError flag", function() {
    try {
      parsePromptYaml("    bad\n   bad\n  bad");
    } catch (e) {
      // We don't pin the exact line — just confirm the error shape
      expect(e.isYamlParseError).toBe(true);
      expect(typeof e.line).toBe("number");
    }
  });
});
