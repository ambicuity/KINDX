import { describe, expect, it } from "vitest";
import {
  KindxMcpToolResultSchema,
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
});
