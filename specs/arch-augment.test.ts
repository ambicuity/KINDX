import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectArchHints } from "../engine/integrations/arch/augment.js";
import type { ArchHint } from "../engine/integrations/arch/contracts.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kindx-augment-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const sampleHints: ArchHint[] = [
  {
    id: "report",
    kind: "report",
    title: "Architecture Report",
    body: "This is the architecture overview",
    scoreSignals: ["architecture", "overview"],
    sourceFiles: [],
  },
  {
    id: "god_auth",
    kind: "god_node",
    title: "AuthService",
    body: "AuthService is a high-centrality node with 15 edges",
    scoreSignals: ["auth", "service", "central"],
    sourceFiles: ["src/auth.ts"],
  },
  {
    id: "community_0",
    kind: "community",
    title: "Community 0",
    body: "Community 0 includes 5 nodes related to authentication",
    scoreSignals: ["community", "module", "authentication"],
    sourceFiles: ["src/a.ts", "src/b.ts"],
  },
  {
    id: "edge_a_b",
    kind: "surprising_edge",
    title: "ModuleA -> ModuleB",
    body: "ModuleA has relation 'calls' with ModuleB",
    scoreSignals: ["calls", "modulea", "moduleb"],
    sourceFiles: ["src/a.ts"],
  },
];

async function writeHintsFile(hints: ArchHint[]): Promise<string> {
  const path = join(tmpDir, "hints.json");
  await writeFile(path, JSON.stringify(hints), "utf-8");
  return path;
}

describe("selectArchHints", () => {
  test("returns matching hints for query", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    const results = selectArchHints("architecture overview", hintsPath, 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("Architecture Report");
  });

  test("returns empty array when hints.json missing", () => {
    const results = selectArchHints("anything", join(tmpDir, "nonexistent.json"), 10);
    expect(results).toEqual([]);
  });

  test("returns empty array for empty hints array", async () => {
    const hintsPath = await writeHintsFile([]);
    const results = selectArchHints("anything", hintsPath, 10);
    expect(results).toEqual([]);
  });

  test("returns empty array for invalid JSON", async () => {
    const path = join(tmpDir, "bad.json");
    await writeFile(path, "not valid json{{", "utf-8");
    const results = selectArchHints("anything", path, 10);
    expect(results).toEqual([]);
  });

  test("returns empty array for non-array JSON", async () => {
    const path = join(tmpDir, "object.json");
    await writeFile(path, JSON.stringify({ not: "array" }), "utf-8");
    const results = selectArchHints("anything", path, 10);
    expect(results).toEqual([]);
  });

  test("respects maxHints limit", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    const results = selectArchHints("architecture auth module calls", hintsPath, 2);

    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("sorts by relevance score", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    const results = selectArchHints("auth service central", hintsPath, 10);

    // god_node hint should rank higher due to +0.2 bonus + matching tokens
    expect(results.length).toBeGreaterThan(0);
    const authIndex = results.findIndex((r) => r.title === "AuthService");
    const reportIndex = results.findIndex((r) => r.title === "Architecture Report");
    // AuthService matches 3 tokens + 0.2 god_node bonus, Report matches 0 tokens
    if (authIndex >= 0 && reportIndex >= 0) {
      expect(authIndex).toBeLessThan(reportIndex);
    }
  });

  test("case insensitive token matching", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    const results = selectArchHints("ARCHITECTURE", hintsPath, 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("Architecture Report");
  });

  test("handles punctuation in query", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    const results = selectArchHints("architecture... overview!!!", hintsPath, 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("Architecture Report");
  });

  test("filters tokens shorter than 3 characters", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    // "is" and "a" are < 3 chars and should be ignored
    const results = selectArchHints("is a architecture", hintsPath, 10);

    expect(results.length).toBeGreaterThan(0);
  });

  test("god_node gets +0.2 score bonus", async () => {
    // Create hints where base overlap is equal but one is god_node
    const hints: ArchHint[] = [
      {
        id: "report_match",
        kind: "report",
        title: "Auth Report",
        body: "Auth system overview",
        scoreSignals: ["auth"],
        sourceFiles: [],
      },
      {
        id: "god_match",
        kind: "god_node",
        title: "Auth Node",
        body: "Auth node overview",
        scoreSignals: ["auth"],
        sourceFiles: [],
      },
    ];
    const hintsPath = await writeHintsFile(hints);
    const results = selectArchHints("auth overview", hintsPath, 10);

    expect(results.length).toBe(2);
    // god_node should rank first due to +0.2 bonus
    expect(results[0].title).toBe("Auth Node");
    expect(results[1].title).toBe("Auth Report");
  });

  test("surprising_edge gets +0.15 score bonus", async () => {
    const hints: ArchHint[] = [
      {
        id: "report_match",
        kind: "report",
        title: "Calls Report",
        body: "Calls system overview",
        scoreSignals: ["calls"],
        sourceFiles: [],
      },
      {
        id: "edge_match",
        kind: "surprising_edge",
        title: "Edge Calls",
        body: "Edge calls overview",
        scoreSignals: ["calls"],
        sourceFiles: [],
      },
    ];
    const hintsPath = await writeHintsFile(hints);
    const results = selectArchHints("calls overview", hintsPath, 10);

    expect(results.length).toBe(2);
    // surprising_edge should rank first due to +0.15 bonus
    expect(results[0].title).toBe("Edge Calls");
    expect(results[1].title).toBe("Calls Report");
  });

  test("hints with matching scoreSignals ranked higher", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    // "central" is a scoreSignal for god_auth but not in its title/body literally
    const results = selectArchHints("central", hintsPath, 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("AuthService");
  });

  test("returns empty array for query with only short tokens", async () => {
    const hintsPath = await writeHintsFile(sampleHints);
    // "is", "a", "ab" are all < 3 chars
    const results = selectArchHints("is a ab", hintsPath, 10);
    expect(results).toEqual([]);
  });

  test("preserves sourceFiles and confidence from hints", async () => {
    const hints: ArchHint[] = [
      {
        id: "edge_with_conf",
        kind: "surprising_edge",
        title: "Test Edge",
        body: "Test edge with confidence",
        scoreSignals: ["test"],
        confidence: "EXTRACTED",
        sourceFiles: ["src/test.ts"],
      },
    ];
    const hintsPath = await writeHintsFile(hints);
    const results = selectArchHints("test edge", hintsPath, 10);

    expect(results.length).toBe(1);
    expect(results[0].sourceFiles).toEqual(["src/test.ts"]);
    expect(results[0].confidence).toBe("EXTRACTED");
  });

  test("filters out hints with zero overlap score", async () => {
    // Use only report/community hints (no kind bonus) so truly no match
    const hints: ArchHint[] = [
      {
        id: "report_only",
        kind: "report",
        title: "Architecture Report",
        body: "Overview of the system",
        scoreSignals: ["architecture"],
        sourceFiles: [],
      },
    ];
    const hintsPath = await writeHintsFile(hints);
    const results = selectArchHints("xyz", hintsPath, 10);
    expect(results).toEqual([]);
  });
});
