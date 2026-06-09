import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadArchConfig, type ArchConfig } from "./config.js";
import { parseGraphJson, readGraphReport } from "./parser.js";
import { distillArchArtifacts } from "./distill.js";
import { checkArchRepo, runArchBuild } from "./runner.js";
import { readDistilledManifest, resolveArchPaths } from "./importer.js";
import type { DistilledArchArtifact } from "./contracts.js";

export type ArchBuildAndDistillResult = {
  build: Awaited<ReturnType<typeof runArchBuild>>;
  artifact: DistilledArchArtifact;
  paths: ReturnType<typeof resolveArchPaths>;
};

export function getArchConfig(): ArchConfig {
  return loadArchConfig();
}

export function getArchStatus(config: ArchConfig, sourceRoot: string): {
  enabled: boolean;
  augmentEnabled: boolean;
  repoCheck: { ok: boolean; reason?: string };
  paths: ReturnType<typeof resolveArchPaths>;
  manifest: DistilledArchArtifact | null;
} {
  const paths = resolveArchPaths(config.artifactDir, sourceRoot);
  return {
    enabled: config.enabled,
    augmentEnabled: config.augmentEnabled,
    repoCheck: checkArchRepo(config.repoPath),
    paths,
    manifest: readDistilledManifest(paths.manifestPath),
  };
}

export async function buildAndDistillArch(
  sourceRoot: string,
  config: ArchConfig,
): Promise<ArchBuildAndDistillResult> {
  const root = resolve(sourceRoot);
  const paths = resolveArchPaths(config.artifactDir, root);
  mkdirSync(paths.workspaceRoot, { recursive: true });
  mkdirSync(paths.sidecarOutputDir, { recursive: true });
  mkdirSync(paths.distilledDir, { recursive: true });

  const repoCheck = checkArchRepo(config.repoPath);
  if (!repoCheck.ok) {
    throw new Error(repoCheck.reason || "Arch repository is unavailable");
  }

  const build = await runArchBuild({
    pythonBin: config.pythonBin,
    archRepoPath: config.repoPath,
    sourceRoot: root,
    outputDir: paths.sidecarOutputDir,
  });

  if (!build.ok) {
    throw new Error(`Arch build failed (${build.exitCode}): ${build.stderr || build.stdout}`);
  }

  const graphJsonPath = resolve(paths.sidecarOutputDir, "graph.json");
  const reportPath = resolve(paths.sidecarOutputDir, "GRAPH_REPORT.md");
  const graph = parseGraphJson(graphJsonPath);
  const reportText = readGraphReport(reportPath);

  const artifact = distillArchArtifacts({
    sourceRoot: root,
    graphJsonPath,
    reportPath,
    reportText,
    graph,
    outputDir: paths.distilledDir,
    minConfidence: config.minConfidence,
  });

  return { build, artifact, paths };
}
