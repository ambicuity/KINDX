import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArchGraphJson } from "./contracts.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveArchArtifactPaths(artifactRoot: string): {
  graphJsonPath: string;
  reportPath: string;
} {
  const root = resolve(artifactRoot);
  return {
    graphJsonPath: resolve(root, "graph.json"),
    reportPath: resolve(root, "GRAPH_REPORT.md"),
  };
}

export function parseGraphJson(path: string): ArchGraphJson {
  if (!existsSync(path)) {
    throw new Error(`Arch graph.json not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`Failed to parse Arch graph JSON (${path}): ${error}`);
  }

  if (!isObject(parsed)) {
    throw new Error(`Arch graph JSON must be an object: ${path}`);
  }

  const nodes = parsed.nodes;
  const links = parsed.links;
  if (!Array.isArray(nodes) || !Array.isArray(links)) {
    throw new Error(`Arch graph JSON must contain array fields 'nodes' and 'links': ${path}`);
  }

  return {
    nodes: nodes as ArchGraphJson["nodes"],
    links: links as ArchGraphJson["links"],
    hyperedges: Array.isArray(parsed.hyperedges)
      ? (parsed.hyperedges as ArchGraphJson["hyperedges"])
      : undefined,
  };
}

export function readGraphReport(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}
