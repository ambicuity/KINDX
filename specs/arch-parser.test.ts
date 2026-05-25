/**
 * specs/arch-parser.test.ts
 *
 * Unit tests for engine/integrations/arch/parser.ts - Arch graph JSON parsing and artifact path resolution.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGraphJson, readGraphReport, resolveArchArtifactPaths } from "../engine/integrations/arch/parser.js";

describe("arch/parser", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-arch-parser-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("resolveArchArtifactPaths", () => {
    test("returns graph.json and GRAPH_REPORT.md paths under artifact root", () => {
      const paths = resolveArchArtifactPaths(testDir);

      expect(paths.graphJsonPath).toBe(join(testDir, "graph.json"));
      expect(paths.reportPath).toBe(join(testDir, "GRAPH_REPORT.md"));
    });

    test("resolves relative paths to absolute", () => {
      const paths = resolveArchArtifactPaths("./some/relative/path");

      expect(paths.graphJsonPath).toContain("graph.json");
      expect(paths.reportPath).toContain("GRAPH_REPORT.md");
      // Should be absolute after resolve
      expect(paths.graphJsonPath.startsWith("/")).toBe(true);
      expect(paths.reportPath.startsWith("/")).toBe(true);
    });

    test("returns consistent paths for same input", () => {
      const paths1 = resolveArchArtifactPaths(testDir);
      const paths2 = resolveArchArtifactPaths(testDir);

      expect(paths1.graphJsonPath).toBe(paths2.graphJsonPath);
      expect(paths1.reportPath).toBe(paths2.reportPath);
    });

    test("returns different paths for different roots", () => {
      const dir1 = join(testDir, "a");
      const dir2 = join(testDir, "b");

      const paths1 = resolveArchArtifactPaths(dir1);
      const paths2 = resolveArchArtifactPaths(dir2);

      expect(paths1.graphJsonPath).not.toBe(paths2.graphJsonPath);
      expect(paths1.reportPath).not.toBe(paths2.reportPath);
    });
  });

  describe("parseGraphJson", () => {
    test("parses valid graph.json with nodes and links", async () => {
      const graphData = {
        nodes: [
          { id: "n1", label: "Node 1", file_type: "module" },
          { id: "n2", label: "Node 2", file_type: "class" },
        ],
        links: [
          { source: "n1", target: "n2", relation: "imports", confidence: "EXTRACTED" },
        ],
      };

      const filePath = join(testDir, "graph.json");
      await writeFile(filePath, JSON.stringify(graphData), "utf-8");

      const result = parseGraphJson(filePath);

      expect(result.nodes).toHaveLength(2);
      expect(result.links).toHaveLength(1);
      expect(result.nodes[0].id).toBe("n1");
      expect(result.nodes[0].label).toBe("Node 1");
      expect(result.links[0].source).toBe("n1");
      expect(result.links[0].target).toBe("n2");
      expect(result.links[0].relation).toBe("imports");
    });

    test("parses graph.json with hyperedges", async () => {
      const graphData = {
        nodes: [{ id: "n1" }],
        links: [],
        hyperedges: [
          { id: "h1", label: "Hyper 1", nodes: ["n1"], confidence: "INFERRED" },
        ],
      };

      const filePath = join(testDir, "graph.json");
      await writeFile(filePath, JSON.stringify(graphData), "utf-8");

      const result = parseGraphJson(filePath);

      expect(result.hyperedges).toBeDefined();
      expect(result.hyperedges).toHaveLength(1);
      expect(result.hyperedges![0].id).toBe("h1");
    });

    test("returns undefined hyperedges when not present", async () => {
      const graphData = {
        nodes: [{ id: "n1" }],
        links: [],
      };

      const filePath = join(testDir, "graph.json");
      await writeFile(filePath, JSON.stringify(graphData), "utf-8");

      const result = parseGraphJson(filePath);

      expect(result.hyperedges).toBeUndefined();
    });

    test("throws error for missing file", () => {
      const filePath = join(testDir, "nonexistent.json");

      expect(() => parseGraphJson(filePath)).toThrow("Arch graph.json not found");
    });

    test("throws error for invalid JSON", async () => {
      const filePath = join(testDir, "bad.json");
      await writeFile(filePath, "not valid json {{{", "utf-8");

      expect(() => parseGraphJson(filePath)).toThrow("Failed to parse Arch graph JSON");
    });

    test("throws error when root is not an object", async () => {
      const filePath = join(testDir, "array.json");
      await writeFile(filePath, JSON.stringify([1, 2, 3]), "utf-8");

      expect(() => parseGraphJson(filePath)).toThrow("Arch graph JSON must be an object");
    });

    test("throws error when nodes array is missing", async () => {
      const filePath = join(testDir, "no-nodes.json");
      await writeFile(filePath, JSON.stringify({ links: [] }), "utf-8");

      expect(() => parseGraphJson(filePath)).toThrow("must contain array fields 'nodes' and 'links'");
    });

    test("throws error when links array is missing", async () => {
      const filePath = join(testDir, "no-links.json");
      await writeFile(filePath, JSON.stringify({ nodes: [] }), "utf-8");

      expect(() => parseGraphJson(filePath)).toThrow("must contain array fields 'nodes' and 'links'");
    });

    test("throws error when nodes is not an array", async () => {
      const filePath = join(testDir, "nodes-not-array.json");
      await writeFile(filePath, JSON.stringify({ nodes: "not-array", links: [] }), "utf-8");

      expect(() => parseGraphJson(filePath)).toThrow("must contain array fields 'nodes' and 'links'");
    });

    test("throws error when links is not an array", async () => {
      const filePath = join(testDir, "links-not-array.json");
      await writeFile(filePath, JSON.stringify({ nodes: [], links: "not-array" }), "utf-8");

      expect(() => parseGraphJson(filePath)).toThrow("must contain array fields 'nodes' and 'links'");
    });

    test("handles empty nodes and links arrays", async () => {
      const filePath = join(testDir, "empty.json");
      await writeFile(filePath, JSON.stringify({ nodes: [], links: [] }), "utf-8");

      const result = parseGraphJson(filePath);

      expect(result.nodes).toHaveLength(0);
      expect(result.links).toHaveLength(0);
    });
  });

  describe("readGraphReport", () => {
    test("returns file content for existing file", async () => {
      const filePath = join(testDir, "GRAPH_REPORT.md");
      const content = "# Architecture Report\n\nSome content here.";
      await writeFile(filePath, content, "utf-8");

      const result = readGraphReport(filePath);

      expect(result).toBe(content);
    });

    test("returns null for missing file", () => {
      const filePath = join(testDir, "nonexistent.md");

      const result = readGraphReport(filePath);

      expect(result).toBeNull();
    });

    test("returns empty string for empty file", async () => {
      const filePath = join(testDir, "empty.md");
      await writeFile(filePath, "", "utf-8");

      const result = readGraphReport(filePath);

      expect(result).toBe("");
    });

    test("preserves markdown formatting", async () => {
      const filePath = join(testDir, "GRAPH_REPORT.md");
      const content = [
        "# Title",
        "",
        "## Section 1",
        "",
        "- Item 1",
        "- Item 2",
        "",
        "```typescript",
        "const x = 1;",
        "```",
      ].join("\n");
      await writeFile(filePath, content, "utf-8");

      const result = readGraphReport(filePath);

      expect(result).toBe(content);
    });
  });
});
