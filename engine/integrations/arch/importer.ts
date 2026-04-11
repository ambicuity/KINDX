import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { DistilledArchArtifact } from "./contracts.js";

export type ArchPaths = {
  workspaceRoot: string;
  sidecarOutputDir: string;
  distilledDir: string;
  docsDir: string;
  manifestPath: string;
};

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function resolveArchPaths(artifactRoot: string, sourceRoot: string): ArchPaths {
  const root = resolve(artifactRoot, shortHash(resolve(sourceRoot)));
  return {
    workspaceRoot: root,
    sidecarOutputDir: resolve(root, "sidecar"),
    distilledDir: resolve(root, "distilled"),
    docsDir: resolve(root, "distilled", "docs"),
    manifestPath: resolve(root, "distilled", "manifest.json"),
  };
}

export function readDistilledManifest(path: string): DistilledArchArtifact | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DistilledArchArtifact;
    if (
      typeof parsed !== "object" ||
      !parsed ||
      !Array.isArray(parsed.files) ||
      typeof parsed.hintsPath !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
