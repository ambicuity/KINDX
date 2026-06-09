/**
 * specs/render-project-block.test.ts
 *
 * Unit tests for engine/init/render-project-block.ts - Project fence rendering.
 */

import { describe, test, expect } from "vitest";

describe("render-project-block", () => {
  describe("renderProjectFenceBody", () => {
    test("returns non-empty string", async () => {
      const { renderProjectFenceBody } = await import("../engine/init/render-project-block.js");
      
      const result = renderProjectFenceBody();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("contains managed comment", async () => {
      const { renderProjectFenceBody } = await import("../engine/init/render-project-block.js");
      
      const result = renderProjectFenceBody();
      expect(result).toContain("managed by");
    });

    test("contains tool names", async () => {
      const { renderProjectFenceBody } = await import("../engine/init/render-project-block.js");
      
      const result = renderProjectFenceBody();
      expect(result).toContain("query");
      expect(result).toContain("get");
      expect(result).toContain("multi_get");
    });
  });
});
