import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { distillArchArtifacts } from "../engine/integrations/arch/distill.js";
import type { ArchGraphJson } from "../engine/integrations/arch/contracts.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kindx-distill-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const sampleGraph: ArchGraphJson = {
  nodes: [
    { id: "a", label: "ModuleA", source_file: "src/a.ts", community: 0 },
    { id: "b", label: "ModuleB", source_file: "src/b.ts", community: 0 },
    { id: "c", label: "ModuleC", source_file: "src/c.ts", community: 1 },
  ],
  links: [
    { source: "a", target: "b", relation: "imports", confidence: "EXTRACTED" },
    { source: "a", target: "c", relation: "calls", confidence: "INFERRED" },
  ],
};

describe("distillArchArtifacts", () => {
  test("processes simple graph with nodes and links", () => {
    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    expect(result.nodeCount).toBe(3);
    expect(result.edgeCount).toBe(2);
    expect(result.sourceRoot).toBe("/repo");
    expect(result.graphJsonPath).toBe("/repo/graph.json");
    expect(result.generatedAt).toBeTruthy();
  });

  test("detects communities and groups nodes correctly", () => {
    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    expect(result.communityCount).toBe(2);

    const communitiesMd = readFile(join(outputDir, "docs", "communities.md"), "utf-8");
    return communitiesMd.then((content) => {
      expect(content).toContain("Community 0");
      expect(content).toContain("Community 1");
      expect(content).toContain("Members: 2");
    });
  });

  test("identifies high-degree god nodes", () => {
    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    const overviewMd = readFile(join(outputDir, "docs", "overview.md"), "utf-8");
    return overviewMd.then((content) => {
      // Node "a" has 2 edges (highest degree), should be first
      expect(content).toContain("Top Nodes");
      expect(content).toContain("ModuleA");
      expect(content).toContain("2 edges");
    });
  });

  test("filters surprising connections excluding imports", () => {
    const outputDir = join(tmpDir, "out");
    distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    const surprisingMd = readFile(join(outputDir, "docs", "surprising_edges.md"), "utf-8");
    return surprisingMd.then((content) => {
      // "imports" relation is filtered out, but "calls" should remain
      expect(content).not.toContain("--imports-->");
      expect(content).toContain("--calls-->");
    });
  });

  test("counts confidence breakdown correctly", () => {
    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    expect(result.confidenceBreakdown.EXTRACTED).toBe(1);
    expect(result.confidenceBreakdown.INFERRED).toBe(1);
    expect(result.confidenceBreakdown.AMBIGUOUS).toBe(0);
  });

  test("generates report, community, god_node, and surprising_edge hints", async () => {
    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    const hints = JSON.parse(await readFile(result.hintsPath, "utf-8"));
    const kinds = hints.map((h: { kind: string }) => h.kind);

    expect(kinds).toContain("report");
    expect(kinds).toContain("community");
    expect(kinds).toContain("god_node");
    expect(kinds).toContain("surprising_edge");
  });

  test("writes overview.md with correct content", async () => {
    const outputDir = join(tmpDir, "out");
    distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    const content = await readFile(join(outputDir, "docs", "overview.md"), "utf-8");
    expect(content).toContain("# Arch Distilled Overview");
    expect(content).toContain("Nodes: 3");
    expect(content).toContain("Edges: 2");
    expect(content).toContain("Communities: 2");
    expect(content).toContain("EXTRACTED=1, INFERRED=1, AMBIGUOUS=0");
  });

  test("writes communities.md", async () => {
    const outputDir = join(tmpDir, "out");
    distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    const content = await readFile(join(outputDir, "docs", "communities.md"), "utf-8");
    expect(content).toContain("# Arch Communities");
    expect(content).toContain("Community 0");
    expect(content).toContain("Community 1");
  });

  test("writes surprising_edges.md", async () => {
    const outputDir = join(tmpDir, "out");
    distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    const content = await readFile(join(outputDir, "docs", "surprising_edges.md"), "utf-8");
    expect(content).toContain("# Arch Surprising Connections");
    expect(content).toContain("--calls-->");
  });

  test("writes manifest.json with correct structure", async () => {
    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf-8"));
    expect(manifest.sourceRoot).toBe("/repo");
    expect(manifest.graphJsonPath).toBe("/repo/graph.json");
    expect(manifest.nodeCount).toBe(3);
    expect(manifest.edgeCount).toBe(2);
    expect(manifest.communityCount).toBe(2);
    expect(manifest.hintsPath).toBe(result.hintsPath);
    expect(manifest.files).toBeInstanceOf(Array);
    expect(manifest.confidenceBreakdown).toEqual({
      EXTRACTED: 1,
      INFERRED: 1,
      AMBIGUOUS: 0,
    });
  });

  test("writes graph_report.md when reportText is provided", async () => {
    const outputDir = join(tmpDir, "out");
    distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
      reportText: "# Custom Report\nSome analysis here.",
    });

    const content = await readFile(join(outputDir, "docs", "graph_report.md"), "utf-8");
    expect(content).toBe("# Custom Report\nSome analysis here.");
  });

  test("handles empty graph gracefully", () => {
    const outputDir = join(tmpDir, "out");
    const emptyGraph: ArchGraphJson = { nodes: [], links: [] };

    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: emptyGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);
    expect(result.communityCount).toBe(0);
    expect(result.confidenceBreakdown).toEqual({
      EXTRACTED: 0,
      INFERRED: 0,
      AMBIGUOUS: 0,
    });
    expect(existsSync(join(outputDir, "docs", "overview.md"))).toBe(true);
    expect(existsSync(join(outputDir, "docs", "communities.md"))).toBe(true);
    expect(existsSync(join(outputDir, "docs", "surprising_edges.md"))).toBe(true);
    expect(existsSync(join(outputDir, "hints.json"))).toBe(true);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(true);
  });

  test("handles nodes with missing community field", () => {
    const graph: ArchGraphJson = {
      nodes: [
        { id: "x", label: "Orphan", source_file: "src/x.ts" },
        { id: "y", label: "AlsoOrphan" },
      ],
      links: [
        { source: "x", target: "y", relation: "uses", confidence: "EXTRACTED" },
      ],
    };

    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph,
      outputDir,
      minConfidence: "AMBIGUOUS",
    });

    expect(result.communityCount).toBe(0);
    expect(result.nodeCount).toBe(2);
  });

  test("respects minConfidence filter for surprising edges", async () => {
    const graph: ArchGraphJson = {
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      links: [
        { source: "a", target: "b", relation: "calls", confidence: "EXTRACTED" },
        { source: "a", target: "c", relation: "calls", confidence: "AMBIGUOUS" },
      ],
    };

    const outputDir = join(tmpDir, "out");
    distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph,
      outputDir,
      minConfidence: "INFERRED", // AMBIGUOUS should be filtered out
    });

    const content = await readFile(join(outputDir, "docs", "surprising_edges.md"), "utf-8");
    expect(content).toContain("A --calls--> B");
    expect(content).not.toContain("A --calls--> C");
  });

  test("includes reportText in report hint body when provided", async () => {
    const outputDir = join(tmpDir, "out");
    const result = distillArchArtifacts({
      sourceRoot: "/repo",
      graphJsonPath: "/repo/graph.json",
      graph: sampleGraph,
      outputDir,
      minConfidence: "AMBIGUOUS",
      reportText: "Detailed architecture analysis.",
    });

    const hints = JSON.parse(await readFile(result.hintsPath, "utf-8"));
    const reportHint = hints.find((h: { kind: string }) => h.kind === "report");
    expect(reportHint).toBeTruthy();
    expect(reportHint.body).toBe("Detailed architecture analysis.");
  });
});
