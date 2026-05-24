/**
 * specs/flags.test.ts
 *
 * Unit tests for engine/cli/flags.ts - CLI flag definitions and parsing.
 */

import { describe, test, expect } from "vitest";

describe("flags", () => {
  describe("GLOBAL_FLAGS", () => {
    test("exports GLOBAL_FLAGS object", async () => {
      const { GLOBAL_FLAGS } = await import("../engine/cli/flags.js");
      expect(GLOBAL_FLAGS).toBeDefined();
      expect(typeof GLOBAL_FLAGS).toBe("object");
    });

    test("defines format flag as string", async () => {
      const { GLOBAL_FLAGS } = await import("../engine/cli/flags.js");
      expect(GLOBAL_FLAGS.format).toEqual({ type: "string" });
    });

    test("defines plain flag as boolean", async () => {
      const { GLOBAL_FLAGS } = await import("../engine/cli/flags.js");
      expect(GLOBAL_FLAGS.plain).toEqual({ type: "boolean" });
    });

    test("defines yes flag with short alias", async () => {
      const { GLOBAL_FLAGS } = await import("../engine/cli/flags.js");
      expect(GLOBAL_FLAGS.yes).toEqual({ type: "boolean", short: "y" });
    });

    test("defines interactive flag with short alias", async () => {
      const { GLOBAL_FLAGS } = await import("../engine/cli/flags.js");
      expect(GLOBAL_FLAGS.interactive).toEqual({ type: "boolean", short: "i" });
    });

    test("defines all expected flags", async () => {
      const { GLOBAL_FLAGS } = await import("../engine/cli/flags.js");
      const expectedFlags = [
        "format", "plain", "no-color", "color", "verbose", "quiet",
        "debug", "trace", "config", "profile", "timeout", "confirm",
        "yes", "dry-run", "limit", "interactive", "show-scores",
        "show-metadata", "open",
      ];
      for (const flag of expectedFlags) {
        expect(GLOBAL_FLAGS[flag]).toBeDefined();
      }
    });
  });

  describe("parseNumberFlag", () => {
    test("returns fallback for undefined", async () => {
      const { parseNumberFlag } = await import("../engine/cli/flags.js");
      expect(parseNumberFlag(undefined, 10)).toBe(10);
    });

    test("returns fallback for null", async () => {
      const { parseNumberFlag } = await import("../engine/cli/flags.js");
      expect(parseNumberFlag(null, 10)).toBe(10);
    });

    test("parses valid number", async () => {
      const { parseNumberFlag } = await import("../engine/cli/flags.js");
      expect(parseNumberFlag("42", 10)).toBe(42);
    });

    test("parses negative number", async () => {
      const { parseNumberFlag } = await import("../engine/cli/flags.js");
      expect(parseNumberFlag("-5", 10)).toBe(-5);
    });

    test("returns fallback for non-numeric string", async () => {
      const { parseNumberFlag } = await import("../engine/cli/flags.js");
      expect(parseNumberFlag("abc", 10)).toBe(10);
    });

    test("returns fallback for empty string", async () => {
      const { parseNumberFlag } = await import("../engine/cli/flags.js");
      expect(parseNumberFlag("", 10)).toBe(10);
    });

    test("returns fallback for NaN", async () => {
      const { parseNumberFlag } = await import("../engine/cli/flags.js");
      expect(parseNumberFlag(NaN, 10)).toBe(10);
    });
  });
});
