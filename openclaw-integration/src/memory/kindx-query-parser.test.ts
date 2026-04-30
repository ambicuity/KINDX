import { describe, expect, it } from "vitest";
import { parseKindxQueryJson } from "./kindx-query-parser.js";

describe("parseKindxQueryJson", () => {
  it("parses clean kindx JSON output", () => {
    const results = parseKindxQueryJson(
      '[{"docid":"abc","score":1,"snippet":"@@ -1,1\\none"}]',
      "",
    );
    expect(results).toEqual([
      {
        docid: "abc",
        score: 1,
        snippet: "@@ -1,1\none",
      },
    ]);
  });

  it("extracts embedded result arrays from noisy stdout", () => {
    const results = parseKindxQueryJson(
      `initializing
{"payload":"ok"}
[{"docid":"abc","score":0.5}]
complete`,
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 0.5 }]);
  });

  it("treats plain-text no-results from stderr as an empty result set", () => {
    const results = parseKindxQueryJson("", "No results found\n");
    expect(results).toEqual([]);
  });

  it("treats prefixed no-results marker output as an empty result set", () => {
    expect(parseKindxQueryJson("warning: no results found", "")).toEqual([]);
    expect(parseKindxQueryJson("", "[kindx] warning: no results found\n")).toEqual([]);
  });

  it("does not treat arbitrary non-marker text as no-results output", () => {
    expect(() =>
      parseKindxQueryJson("warning: search completed; no results found for this query", ""),
    ).toThrow(/kindx query returned invalid JSON/i);
  });

  it("throws when stdout cannot be interpreted as kindx JSON", () => {
    expect(() => parseKindxQueryJson("this is not json", "")).toThrow(
      /kindx query returned invalid JSON/i,
    );
  });
});
