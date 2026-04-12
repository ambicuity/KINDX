import { describe, expect, it } from "vitest";
import {
  KindxMcpToolResultSchema,
  KindxMemoryMarkInputSchema,
  KindxMemoryPutInputSchema,
  KindxMemorySearchInputSchema,
  KindxQueryInputSchema,
  KindxQueryResponseSchema,
} from "../src/index.js";

describe("kindx schemas", () => {
  it("validates query input", () => {
    const parsed = KindxQueryInputSchema.parse({
      searches: [{ type: "lex", query: "sqlite" }],
      limit: 5,
      minScore: 0.2,
    });

    expect(parsed.searches).toHaveLength(1);
    expect(parsed.limit).toBe(5);
  });

  it("validates query response shape", () => {
    const parsed = KindxQueryResponseSchema.parse({
      results: [{
        docid: "#abc123",
        file: "specs/eval-docs/overview.md",
        title: "Overview",
        score: 0.8,
        context: null,
        snippet: "1: overview",
      }],
    });

    expect(parsed.results[0]?.docid).toBe("#abc123");
  });

  it("accepts MCP text/resource output", () => {
    const parsed = KindxMcpToolResultSchema.parse({
      content: [
        { type: "text", text: "ok" },
        {
          type: "resource",
          resource: {
            uri: "kindx://docs/a.md",
            text: "# hello",
          },
        },
      ],
    });

    expect(parsed.content).toHaveLength(2);
  });

  it("matches memory_put MCP contract", () => {
    const parsed = KindxMemoryPutInputSchema.parse({
      scope: "workspace-alpha",
      key: "owner",
      value: "alice",
      semanticThreshold: 0.9,
      tags: ["people"],
    });
    expect(parsed.scope).toBe("workspace-alpha");
    expect(parsed.value).toBe("alice");
  });

  it("matches memory_search MCP contract", () => {
    const parsed = KindxMemorySearchInputSchema.parse({
      scope: "workspace-alpha",
      query: "owner",
      mode: "semantic",
      threshold: 0.8,
      limit: 5,
    });
    expect(parsed.mode).toBe("semantic");
    expect(parsed.limit).toBe(5);
  });

  it("matches memory_mark_accessed MCP contract", () => {
    const parsed = KindxMemoryMarkInputSchema.parse({
      scope: "workspace-alpha",
      id: 42,
    });
    expect(parsed.id).toBe(42);
  });
});
