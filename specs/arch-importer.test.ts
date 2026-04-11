import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDistilledManifest, resolveArchPaths } from "../engine/integrations/arch/importer.js";

describe("arch importer", () => {
  test("resolves stable arch workspace paths", () => {
    const pathsA = resolveArchPaths("/tmp/kindx-arch", "/repo/alpha");
    const pathsB = resolveArchPaths("/tmp/kindx-arch", "/repo/alpha");
    const pathsC = resolveArchPaths("/tmp/kindx-arch", "/repo/beta");

    expect(pathsA.workspaceRoot).toBe(pathsB.workspaceRoot);
    expect(pathsA.workspaceRoot).not.toBe(pathsC.workspaceRoot);
    expect(pathsA.docsDir.endsWith("/distilled/docs")).toBe(true);
  });

  test("reads distilled manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "kindx-arch-importer-"));
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        sourceRoot: "/repo",
        graphJsonPath: "/repo/graph.json",
        generatedAt: new Date().toISOString(),
        nodeCount: 10,
        edgeCount: 20,
        communityCount: 3,
        files: [],
        hintsPath: "/repo/hints.json",
        confidenceBreakdown: { EXTRACTED: 10, INFERRED: 5, AMBIGUOUS: 2 },
      }),
      "utf-8",
    );

    const manifest = readDistilledManifest(manifestPath);
    expect(manifest).not.toBeNull();
    expect(manifest?.nodeCount).toBe(10);
  });
});
