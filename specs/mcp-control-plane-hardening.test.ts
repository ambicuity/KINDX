import { describe, expect, test } from "vitest";
import { McpToolListCache } from "../engine/mcp-control-plane.js";

describe("cachePath validation", () => {
  test("rejects keys containing forward slash", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("../../../etc/passwd")).toThrow(
      "invalid cache key"
    );
  });

  test("rejects keys containing backslash", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("..\\..\\windows\\system32")).toThrow(
      "invalid cache key"
    );
  });

  test("rejects keys containing dot-dot", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("..")).toThrow("invalid cache key");
    expect(() => (cache as any).cachePath("valid/../escape")).toThrow(
      "invalid cache key"
    );
  });

  test("accepts valid hex keys", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("abc123def456")).not.toThrow();
  });
});
