/**
 * specs/adapters.test.ts
 *
 * Unit tests for engine/init/adapters.ts - MCP client adapters.
 */

import { describe, test, expect } from "vitest";

describe("adapters", () => {
  describe("ALL_ADAPTERS", () => {
    test("exports array of adapters", async () => {
      const { ALL_ADAPTERS } = await import("../engine/init/adapters.js");
      expect(Array.isArray(ALL_ADAPTERS)).toBe(true);
      expect(ALL_ADAPTERS.length).toBeGreaterThan(0);
    });

    test("each adapter has required properties", async () => {
      const { ALL_ADAPTERS } = await import("../engine/init/adapters.js");
      for (const adapter of ALL_ADAPTERS) {
        expect(typeof adapter.name).toBe("string");
        expect(typeof adapter.label).toBe("string");
        expect(adapter.name.length).toBeGreaterThan(0);
        expect(adapter.label.length).toBeGreaterThan(0);
      }
    });

    test("includes claude-code adapter", async () => {
      const { ALL_ADAPTERS } = await import("../engine/init/adapters.js");
      const claudeCode = ALL_ADAPTERS.find(a => a.name === "claude-code");
      expect(claudeCode).toBeDefined();
      expect(claudeCode?.label).toBe("Claude Code");
    });

    test("includes cursor adapter", async () => {
      const { ALL_ADAPTERS } = await import("../engine/init/adapters.js");
      const cursor = ALL_ADAPTERS.find(a => a.name === "cursor");
      expect(cursor).toBeDefined();
      expect(cursor?.label).toBe("Cursor");
    });
  });

  describe("adapterByName", () => {
    test("returns adapter for valid name", async () => {
      const { adapterByName } = await import("../engine/init/adapters.js");
      const adapter = adapterByName("claude-code");
      expect(adapter).toBeDefined();
      expect(adapter?.name).toBe("claude-code");
    });

    test("returns undefined for invalid name", async () => {
      const { adapterByName } = await import("../engine/init/adapters.js");
      const adapter = adapterByName("nonexistent");
      expect(adapter).toBeUndefined();
    });
  });
});
