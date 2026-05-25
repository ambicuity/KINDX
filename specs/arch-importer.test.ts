/**
 * specs/arch-importer.test.ts
 *
 * Unit tests for engine/integrations/arch/importer.ts - Arch path resolution and distilled manifest reading.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveArchPaths, readDistilledManifest } from "../engine/integrations/arch/importer.js";

describe("arch/importer", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-arch-importer-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("resolveArchPaths", () => {
    test("returns all expected path keys", () => {
      const paths = resolveArchPaths(testDir, "/some/source");

      expect(paths).toHaveProperty("workspaceRoot");
      expect(paths).toHaveProperty("sidecarOutputDir");
      expect(paths).toHaveProperty("distilledDir");
      expect(paths).toHaveProperty("docsDir");
      expect(paths).toHaveProperty("manifestPath");
      expect(paths).toHaveProperty("hintsPath");
    });

    test("returns consistent paths for same inputs", () => {
      const sourceRoot = join(testDir, "my-project");
      const paths1 = resolveArchPaths(testDir, sourceRoot);
      const paths2 = resolveArchPaths(testDir, sourceRoot);

      expect(paths1.workspaceRoot).toBe(paths2.workspaceRoot);
      expect(paths1.sidecarOutputDir).toBe(paths2.sidecarOutputDir);
      expect(paths1.distilledDir).toBe(paths2.distilledDir);
      expect(paths1.docsDir).toBe(paths2.docsDir);
      expect(paths1.manifestPath).toBe(paths2.manifestPath);
      expect(paths1.hintsPath).toBe(paths2.hintsPath);
    });

    test("returns different paths for different source roots", () => {
      const source1 = join(testDir, "project-a");
      const source2 = join(testDir, "project-b");

      const paths1 = resolveArchPaths(testDir, source1);
      const paths2 = resolveArchPaths(testDir, source2);

      expect(paths1.workspaceRoot).not.toBe(paths2.workspaceRoot);
    });

    test("returns different paths for different artifact roots", () => {
      const artifact1 = join(testDir, "artifacts-a");
      const artifact2 = join(testDir, "artifacts-b");
      const sourceRoot = join(testDir, "my-project");

      const paths1 = resolveArchPaths(artifact1, sourceRoot);
      const paths2 = resolveArchPaths(artifact2, sourceRoot);

      expect(paths1.workspaceRoot).not.toBe(paths2.workspaceRoot);
    });

    test("sidecarOutputDir is under workspaceRoot", () => {
      const paths = resolveArchPaths(testDir, "/some/source");

      expect(paths.sidecarOutputDir).toContain(paths.workspaceRoot);
      expect(paths.sidecarOutputDir).toContain("sidecar");
    });

    test("distilledDir is under workspaceRoot", () => {
      const paths = resolveArchPaths(testDir, "/some/source");

      expect(paths.distilledDir).toContain(paths.workspaceRoot);
      expect(paths.distilledDir).toContain("distilled");
    });

    test("docsDir is under distilledDir", () => {
      const paths = resolveArchPaths(testDir, "/some/source");

      expect(paths.docsDir).toContain(paths.distilledDir);
      expect(paths.docsDir).toContain("docs");
    });

    test("manifestPath is under distilledDir", () => {
      const paths = resolveArchPaths(testDir, "/some/source");

      expect(paths.manifestPath).toContain(paths.distilledDir);
      expect(paths.manifestPath).toContain("manifest.json");
    });

    test("hintsPath is under distilledDir", () => {
      const paths = resolveArchPaths(testDir, "/some/source");

      expect(paths.hintsPath).toContain(paths.distilledDir);
      expect(paths.hintsPath).toContain("hints.json");
    });

    test("workspaceRoot contains a 12-char hash", () => {
      const paths = resolveArchPaths(testDir, "/some/source");

      // The hash is appended to the artifact root
      const relativePath = paths.workspaceRoot.slice(testDir.length + 1);
      expect(relativePath).toHaveLength(12);
      expect(/^[0-9a-f]{12}$/.test(relativePath)).toBe(true);
    });

    test("resolves relative source roots to absolute", () => {
      const paths = resolveArchPaths(testDir, "./relative/path");

      // workspaceRoot should still be under testDir
      expect(paths.workspaceRoot.startsWith(testDir)).toBe(true);
    });
  });

  describe("readDistilledManifest", () => {
    test("returns parsed manifest for valid file", async () => {
      const manifest = {
        sourceRoot: "/some/source",
        graphJsonPath: "/some/graph.json",
        generatedAt: "2026-01-01T00:00:00Z",
        nodeCount: 10,
        edgeCount: 15,
        communityCount: 3,
        files: ["file1.ts", "file2.ts"],
        hintsPath: "/some/hints.json",
        confidenceBreakdown: {
          EXTRACTED: 5,
          INFERRED: 8,
          AMBIGUOUS: 2,
        },
      };

      const filePath = join(testDir, "manifest.json");
      await writeFile(filePath, JSON.stringify(manifest), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).not.toBeNull();
      expect(result!.files).toEqual(["file1.ts", "file2.ts"]);
      expect(result!.hintsPath).toBe("/some/hints.json");
      expect(result!.nodeCount).toBe(10);
      expect(result!.edgeCount).toBe(15);
    });

    test("returns null for missing file", () => {
      const filePath = join(testDir, "nonexistent.json");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("returns null for invalid JSON", async () => {
      const filePath = join(testDir, "bad.json");
      await writeFile(filePath, "not json {{{", "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("returns null when files field is missing", async () => {
      const manifest = {
        sourceRoot: "/some/source",
        graphJsonPath: "/some/graph.json",
        generatedAt: "2026-01-01T00:00:00Z",
        nodeCount: 10,
        edgeCount: 15,
        communityCount: 3,
        hintsPath: "/some/hints.json",
        confidenceBreakdown: { EXTRACTED: 5, INFERRED: 8, AMBIGUOUS: 2 },
      };

      const filePath = join(testDir, "no-files.json");
      await writeFile(filePath, JSON.stringify(manifest), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("returns null when hintsPath field is missing", async () => {
      const manifest = {
        sourceRoot: "/some/source",
        graphJsonPath: "/some/graph.json",
        generatedAt: "2026-01-01T00:00:00Z",
        nodeCount: 10,
        edgeCount: 15,
        communityCount: 3,
        files: ["file1.ts"],
        confidenceBreakdown: { EXTRACTED: 5, INFERRED: 8, AMBIGUOUS: 2 },
      };

      const filePath = join(testDir, "no-hints.json");
      await writeFile(filePath, JSON.stringify(manifest), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("returns null when files is not an array", async () => {
      const manifest = {
        sourceRoot: "/some/source",
        graphJsonPath: "/some/graph.json",
        generatedAt: "2026-01-01T00:00:00Z",
        nodeCount: 10,
        edgeCount: 15,
        communityCount: 3,
        files: "not-an-array",
        hintsPath: "/some/hints.json",
        confidenceBreakdown: { EXTRACTED: 5, INFERRED: 8, AMBIGUOUS: 2 },
      };

      const filePath = join(testDir, "files-not-array.json");
      await writeFile(filePath, JSON.stringify(manifest), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("returns null when hintsPath is not a string", async () => {
      const manifest = {
        sourceRoot: "/some/source",
        graphJsonPath: "/some/graph.json",
        generatedAt: "2026-01-01T00:00:00Z",
        nodeCount: 10,
        edgeCount: 15,
        communityCount: 3,
        files: ["file1.ts"],
        hintsPath: 12345,
        confidenceBreakdown: { EXTRACTED: 5, INFERRED: 8, AMBIGUOUS: 2 },
      };

      const filePath = join(testDir, "hints-not-string.json");
      await writeFile(filePath, JSON.stringify(manifest), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("returns null for non-object root value", async () => {
      const filePath = join(testDir, "array-root.json");
      await writeFile(filePath, JSON.stringify([1, 2, 3]), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("returns null for null root value", async () => {
      const filePath = join(testDir, "null-root.json");
      await writeFile(filePath, JSON.stringify(null), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).toBeNull();
    });

    test("handles manifest with optional reportPath", async () => {
      const manifest = {
        sourceRoot: "/some/source",
        graphJsonPath: "/some/graph.json",
        reportPath: "/some/report.md",
        generatedAt: "2026-01-01T00:00:00Z",
        nodeCount: 5,
        edgeCount: 3,
        communityCount: 1,
        files: ["a.ts"],
        hintsPath: "/some/hints.json",
        confidenceBreakdown: { EXTRACTED: 2, INFERRED: 2, AMBIGUOUS: 1 },
      };

      const filePath = join(testDir, "with-report.json");
      await writeFile(filePath, JSON.stringify(manifest), "utf-8");

      const result = readDistilledManifest(filePath);

      expect(result).not.toBeNull();
      expect(result!.reportPath).toBe("/some/report.md");
    });
  });
});
