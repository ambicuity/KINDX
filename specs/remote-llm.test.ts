/**
 * specs/remote-llm.test.ts
 *
 * Unit tests for engine/remote-llm.ts - Remote LLM API integration.
 */

import { describe, test, expect } from "vitest";
import { parseExpansionPayload } from "../engine/remote-llm.js";

describe("remote-llm", () => {
  describe("parseExpansionPayload", () => {
    test("returns empty array for empty input", () => {
      expect(parseExpansionPayload("")).toEqual([]);
      expect(parseExpansionPayload(null as any)).toEqual([]);
      expect(parseExpansionPayload(undefined as any)).toEqual([]);
    });

    test("parses bare JSON array", () => {
      const input = JSON.stringify([
        { type: "lex", text: "test query" },
        { type: "vec", text: "test query rephrased" },
      ]);
      const result = parseExpansionPayload(input);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: "lex", text: "test query" });
    });

    test("parses JSON object with array property", () => {
      const input = JSON.stringify({
        queries: [
          { type: "lex", text: "test query" },
        ],
      });
      const result = parseExpansionPayload(input);
      expect(result).toHaveLength(1);
    });

    test("parses JSON object with expansions property", () => {
      const input = JSON.stringify({
        expansions: [
          { type: "vec", text: "test query rephrased" },
        ],
      });
      const result = parseExpansionPayload(input);
      expect(result).toHaveLength(1);
    });

    test("parses markdown-fenced JSON", () => {
      const input = '```json\n[{"type": "lex", "text": "test"}]\n```';
      const result = parseExpansionPayload(input);
      expect(result).toHaveLength(1);
    });

    test("returns empty array for invalid JSON", () => {
      expect(parseExpansionPayload("not json")).toEqual([]);
    });

    test("returns empty array for non-string input", () => {
      expect(parseExpansionPayload(123 as any)).toEqual([]);
      expect(parseExpansionPayload({} as any)).toEqual([]);
    });

    test("handles whitespace in input", () => {
      const input = '  \n  [{"type": "lex", "text": "test"}]  \n  ';
      const result = parseExpansionPayload(input);
      expect(result).toHaveLength(1);
    });
  });
});
