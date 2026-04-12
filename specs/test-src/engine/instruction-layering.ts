import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type InstructionSource = {
  path: string;
  scope: "global" | "project";
  bytes: number;
  truncated: boolean;
};

export type LayeredInstructionResult = {
  text: string;
  sources: InstructionSource[];
  truncated: boolean;
};

const DEFAULT_FALLBACK_FILES = ["AGENTS.md", "SOUL.md"];
const DEFAULT_MAX_BYTES = 64 * 1024;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function projectChain(cwd: string): string[] {
  const out: string[] = [];
  let cursor = resolve(cwd);
  while (true) {
    out.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return out;
}

function readBounded(path: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const data = readFileSync(path);
  const bytes = data.byteLength;
  if (bytes <= maxBytes) {
    return { text: data.toString("utf-8"), bytes, truncated: false };
  }
  return {
    text: data.subarray(0, maxBytes).toString("utf-8"),
    bytes,
    truncated: true,
  };
}

export function loadLayeredInstructions(params: {
  cwd?: string;
  globalFiles?: string[];
  fallbackFiles?: string[];
  maxTotalBytes?: number;
}): LayeredInstructionResult {
  const cwd = resolve(params.cwd || process.cwd());
  const max = params.maxTotalBytes ?? DEFAULT_MAX_BYTES;
  const fallback = params.fallbackFiles && params.fallbackFiles.length > 0
    ? params.fallbackFiles
    : DEFAULT_FALLBACK_FILES;

  const candidates: Array<{ path: string; scope: "global" | "project" }> = [];
  for (const file of params.globalFiles ?? []) {
    candidates.push({ path: resolve(file), scope: "global" });
  }
  for (const root of projectChain(cwd).reverse()) {
    for (const name of fallback) {
      candidates.push({ path: resolve(root, name), scope: "project" });
    }
  }

  const sources: InstructionSource[] = [];
  const blocks: string[] = [];
  let remaining = max;
  let anyTruncated = false;

  for (const candidate of unique(candidates.map((c) => `${c.scope}::${c.path}`))) {
    const [scopeRaw, path] = candidate.split("::");
    const scope = scopeRaw === "global" ? "global" : "project";
    if (!existsSync(path)) continue;
    if (remaining <= 0) break;
    const read = readBounded(path, remaining);
    remaining -= Buffer.byteLength(read.text, "utf-8");
    anyTruncated = anyTruncated || read.truncated;
    sources.push({
      path,
      scope,
      bytes: read.bytes,
      truncated: read.truncated,
    });
    blocks.push(read.text);
  }

  return {
    text: blocks.join("\n\n"),
    sources,
    truncated: anyTruncated || remaining <= 0,
  };
}

