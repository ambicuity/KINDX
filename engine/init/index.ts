import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_ADAPTERS, adapterByName } from "./adapters.js";
import { upsertFence } from "./fence.js";
import { renderProjectFenceBody } from "./render-project-block.js";
import type { Adapter, InitOptions, WriteResult } from "./types.js";

const PROJECT_FILE_PREFERENCE = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "GEMINI.md"];
const FENCE_MARKER = "kindx:auto-invocation";

interface RunResult {
  clientResults: Array<WriteResult & { name: string; label: string }>;
  projectFile?: { path: string; outcome: "created" | "updated" | "skipped"; backupPath?: string };
}

function selectAdapters(clients: string[]): Adapter[] {
  if (clients.length === 0 || clients.includes("auto")) {
    return ALL_ADAPTERS.filter((a) => a.detect().exists);
  }
  if (clients.includes("all")) return ALL_ADAPTERS;
  const out: Adapter[] = [];
  for (const c of clients) {
    const a = adapterByName(c);
    if (a) out.push(a);
  }
  return out;
}

function pickProjectFile(projectPath: string): string {
  for (const name of PROJECT_FILE_PREFERENCE) {
    const candidate = resolve(projectPath, name);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(projectPath, PROJECT_FILE_PREFERENCE[0]);
}

function writeProjectFile(projectPath: string, opts: { force: boolean; dryRun: boolean }): RunResult["projectFile"] {
  const target = pickProjectFile(projectPath);
  const existed = existsSync(target);
  if (!existed && !opts.force) {
    return { path: target, outcome: "skipped" };
  }
  const before = existed ? readFileSync(target, "utf-8") : "";
  const after = upsertFence(before, FENCE_MARKER, renderProjectFenceBody(), 1);
  if (after === before) return { path: target, outcome: "skipped" };
  if (opts.dryRun) return { path: target, outcome: existed ? "updated" : "created" };

  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${target}.kindx.bak.${Date.now()}`;
    copyFileSync(target, backupPath);
  }
  writeFileSync(target, after);
  return { path: target, outcome: existed ? "updated" : "created", backupPath };
}

export function runInit(opts: InitOptions): RunResult {
  const adapters = selectAdapters(opts.clients);
  const clientResults = adapters.map((a) => ({
    name: a.name,
    label: a.label,
    ...a.write({ force: opts.force, dryRun: opts.dryRun, command: "kindx", args: ["mcp"] }),
  }));
  const projectFile = opts.globalOnly
    ? undefined
    : writeProjectFile(opts.projectPath ?? process.cwd(), { force: opts.force, dryRun: opts.dryRun });
  return { clientResults, projectFile };
}
