// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Riadh Ben Abdelhamid

import { describe, it, expect } from "vitest";
import { sanitizeFilename, SanitizeError } from "../backend/sanitize.js";

describe("sanitizeFilename — Audit #7", function() {
  describe("accepts safe names", function() {
    it("accepts plain alphanumeric names", function() {
      expect(sanitizeFilename("module.sv")).toBe("module.sv");
      expect(sanitizeFilename("my_module_tb.sv")).toBe("my_module_tb.sv");
      expect(sanitizeFilename("Counter-v2.sv")).toBe("Counter-v2.sv");
      expect(sanitizeFilename("a.b.c.sv")).toBe("a.b.c.sv");
    });
  });

  describe("rejects unsafe names with descriptive errors", function() {
    it("rejects empty string", function() {
      expect(function() { sanitizeFilename(""); }).toThrow(SanitizeError);
      try { sanitizeFilename(""); }
      catch (e) { expect(e.reason).toMatch(/empty/); }
    });

    it("rejects null/undefined/non-strings", function() {
      expect(function() { sanitizeFilename(null); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename(undefined); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename(42); }).toThrow(SanitizeError);
    });

    it("rejects path separators", function() {
      expect(function() { sanitizeFilename("../etc/passwd"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename("a/b.sv"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename("a\\b.sv"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename("a\0b"); }).toThrow(SanitizeError);
    });

    it("rejects . and ..", function() {
      expect(function() { sanitizeFilename("."); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename(".."); }).toThrow(SanitizeError);
    });

    it("rejects names starting with .", function() {
      expect(function() { sanitizeFilename(".hidden"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename(".env"); }).toThrow(SanitizeError);
    });

    it("rejects unsafe charset", function() {
      // Pre-Audit #7 these were silently rewritten to "_" — now they raise.
      expect(function() { sanitizeFilename("my+module.sv"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename("file with spaces.sv"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename("file;rm -rf.sv"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename("file$name.sv"); }).toThrow(SanitizeError);
      expect(function() { sanitizeFilename("módulo.sv"); }).toThrow(SanitizeError);
    });

    it("rejects names longer than 255 chars", function() {
      const longName = "a".repeat(256) + ".sv";
      expect(function() { sanitizeFilename(longName); }).toThrow(SanitizeError);
    });
  });

  describe("error structure", function() {
    it("SanitizeError carries unsafeName and reason", function() {
      try { sanitizeFilename("foo/bar.sv"); }
      catch (e) {
        expect(e).toBeInstanceOf(SanitizeError);
        expect(e.unsafeName).toBe("foo/bar.sv");
        expect(e.reason).toMatch(/path separators/);
        expect(e.message).toContain("foo/bar.sv");
      }
    });
  });
});
