/**
 * specs/docid.test.ts
 *
 * Unit tests for engine/repository/docid.ts - Docid normalization and matching.
 */

import { describe, test, expect } from "vitest";

describe("docid", () => {
  describe("levenshtein", () => {
    test("returns 0 for identical strings", async () => {
      const { levenshtein } = await import("../engine/repository/docid.js");
      expect(levenshtein("abc", "abc")).toBe(0);
    });

    test("returns length difference for empty string", async () => {
      const { levenshtein } = await import("../engine/repository/docid.js");
      expect(levenshtein("", "abc")).toBe(3);
      expect(levenshtein("abc", "")).toBe(3);
    });

    test("returns 1 for single character difference", async () => {
      const { levenshtein } = await import("../engine/repository/docid.js");
      expect(levenshtein("abc", "axc")).toBe(1);
    });

    test("returns correct distance for insertion", async () => {
      const { levenshtein } = await import("../engine/repository/docid.js");
      expect(levenshtein("abc", "abcd")).toBe(1);
    });

    test("returns correct distance for deletion", async () => {
      const { levenshtein } = await import("../engine/repository/docid.js");
      expect(levenshtein("abcd", "abc")).toBe(1);
    });

    test("respects maxDistance parameter", async () => {
      const { levenshtein } = await import("../engine/repository/docid.js");
      expect(levenshtein("abc", "xyz", 2)).toBe(3);
    });
  });

  describe("normalizeDocid", () => {
    test("strips leading #", async () => {
      const { normalizeDocid } = await import("../engine/repository/docid.js");
      expect(normalizeDocid("#abc123")).toBe("abc123");
    });

    test("strips surrounding quotes", async () => {
      const { normalizeDocid } = await import("../engine/repository/docid.js");
      expect(normalizeDocid('"abc123"')).toBe("abc123");
      expect(normalizeDocid("'abc123'")).toBe("abc123");
    });

    test("trims whitespace", async () => {
      const { normalizeDocid } = await import("../engine/repository/docid.js");
      expect(normalizeDocid("  abc123  ")).toBe("abc123");
    });
  });

  describe("isDocid", () => {
    test("returns true for valid hex docid", async () => {
      const { isDocid } = await import("../engine/repository/docid.js");
      expect(isDocid("abc123")).toBe(true);
    });

    test("returns false for short input", async () => {
      const { isDocid } = await import("../engine/repository/docid.js");
      expect(isDocid("abc")).toBe(false);
    });

    test("returns false for non-hex characters", async () => {
      const { isDocid } = await import("../engine/repository/docid.js");
      expect(isDocid("xyz123")).toBe(false);
    });
  });
});
