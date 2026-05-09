// Regression: query-expansion JSON parsing must accept response_format
// json_object (which returns {...}), not only bare arrays.
//
// The previous regex stripped the outer braces of an object response,
// producing JSON.parse failures the inner catch swallowed silently —
// every call burned tokens and silently fell back to no expansion.

import { describe, expect, test } from "vitest";
import { parseExpansionPayload } from "../engine/remote-llm.js";

describe("parseExpansionPayload", () => {
  test("parses a bare JSON array", () => {
    const out = parseExpansionPayload(JSON.stringify([
      { type: "lex", text: "alpha" },
      { type: "vec", text: "beta" },
    ]));
    expect(out).toHaveLength(2);
  });

  test("parses an object with `queries` array (json_object response_format)", () => {
    const out = parseExpansionPayload(JSON.stringify({
      queries: [
        { type: "lex", text: "alpha" },
        { type: "vec", text: "beta" },
        { type: "hyde", text: "a sentence" },
      ],
    }));
    expect(out).toHaveLength(3);
    expect((out[0] as any).type).toBe("lex");
  });

  test("parses an object with arbitrary array-valued first property", () => {
    const out = parseExpansionPayload(JSON.stringify({
      expansions: [{ type: "vec", text: "x" }],
    }));
    expect(out).toHaveLength(1);
  });

  test("parses markdown-fenced JSON array", () => {
    const out = parseExpansionPayload("Here is the result:\n```json\n[{\"type\":\"vec\",\"text\":\"x\"}]\n```\n");
    expect(out).toHaveLength(1);
  });

  test("parses prose-prefixed JSON array (extracts first balanced [...])", () => {
    const out = parseExpansionPayload("Sure: [{\"type\":\"vec\",\"text\":\"x\"}] -- enjoy!");
    expect(out).toHaveLength(1);
  });

  test("parses prose-prefixed JSON object (extracts first balanced {...})", () => {
    const out = parseExpansionPayload("OK: {\"queries\":[{\"type\":\"vec\",\"text\":\"x\"}]} thanks");
    expect(out).toHaveLength(1);
  });

  test("returns [] for empty / null / non-JSON input without throwing", () => {
    expect(parseExpansionPayload("")).toEqual([]);
    expect(parseExpansionPayload("not json at all")).toEqual([]);
    expect(parseExpansionPayload("just some text")).toEqual([]);
  });

  test("returns [] for object with no array-valued property", () => {
    expect(parseExpansionPayload(JSON.stringify({ foo: "bar", n: 1 }))).toEqual([]);
  });

  test("returns [] for malformed JSON without throwing", () => {
    expect(parseExpansionPayload('{"queries": [oops')).toEqual([]);
  });
});
