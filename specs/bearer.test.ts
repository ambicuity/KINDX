/**
 * specs/bearer.test.ts
 *
 * Unit tests for engine/http/bearer.ts - Bearer header parser.
 */

import { describe, test, expect } from "vitest";

describe("bearer", () => {
  describe("parseBearer", () => {
    test("extracts token from valid header", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer("Bearer abc123")).toBe("abc123");
    });

    test("handles case-insensitive bearer prefix", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer("bearer abc123")).toBe("abc123");
      expect(parseBearer("BEARER abc123")).toBe("abc123");
    });

    test("trims whitespace", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer("  Bearer abc123  ")).toBe("abc123");
    });

    test("returns null for null input", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer(null)).toBeNull();
    });

    test("returns null for undefined input", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer(undefined)).toBeNull();
    });

    test("returns null for empty string", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer("")).toBeNull();
    });

    test("returns null for missing token", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer("Bearer")).toBeNull();
    });

    test("returns null for wrong prefix", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer("Token abc123")).toBeNull();
    });

    test("rejects tokens with control characters", async () => {
      const { parseBearer } = await import("../engine/http/bearer.js");
      expect(parseBearer("Bearer abc\x00def")).toBeNull();
      expect(parseBearer("Bearer abc\x1fdef")).toBeNull();
      expect(parseBearer("Bearer abc\x7fdef")).toBeNull();
    });
  });
});
