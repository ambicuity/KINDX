import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArchStatus } from "../engine/integrations/arch/adapter.js";
import type { ArchConfig } from "../engine/integrations/arch/config.js";

describe("arch adapter", () => {
  test("reports manifest when present", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "kindx-arch-source-"));
    const artifactRoot = mkdtempSync(join(tmpdir(), "kindx-arch-artifacts-"));

    const config: ArchConfig = {
      enabled: true,
      augmentEnabled: true,
      autoRefreshOnUpdate: false,
      pythonBin: "python3",
      repoPath: "/tmp/repo-not-required-for-this-test",
      artifactDir: artifactRoot,
      collectionName: "__arch",
      minConfidence: "INFERRED",
      maxHints: 3,
    };

    const statusBefore = getArchStatus(config, sourceRoot);
    const manifestPath = statusBefore.paths.manifestPath;
    mkdirSync(statusBefore.paths.distilledDir, { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        sourceRoot,
        graphJsonPath: join(sourceRoot, "graph.json"),
        generatedAt: new Date().toISOString(),
        nodeCount: 2,
        edgeCount: 1,
        communityCount: 1,
        files: [],
        hintsPath: join(sourceRoot, "hints.json"),
        confidenceBreakdown: { EXTRACTED: 1, INFERRED: 0, AMBIGUOUS: 0 },
      }),
      "utf-8",
    );

    const statusAfter = getArchStatus(config, sourceRoot);
    expect(statusAfter.manifest).not.toBeNull();
    expect(statusAfter.manifest?.communityCount).toBe(1);
  });
});
