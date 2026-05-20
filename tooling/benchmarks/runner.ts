#!/usr/bin/env tsx
/**
 * KINDX benchmark runner — thin dispatcher over the standalone bench scripts.
 *
 * Why this file exists:
 *   `package.json` has `bench:quality`, `bench:latency`, `bench:regressions`,
 *   `bench:daemon`, `bench:all`, and `bench:full` scripts that all reference
 *   this file. Prior to 2026-05-20 the file was missing — the scripts were
 *   dead links. This runner restores them by dispatching `--track <name>`
 *   to the standalone bench scripts that already exist under `tooling/`.
 *
 * Usage:
 *   tsx tooling/benchmarks/runner.ts --track <name> [--enforce]
 *   tsx tooling/benchmarks/runner.ts --all [--enforce] [--include-optional]
 *
 * Tracks:
 *   bm25-quality      → tooling/benchmarks/section6_bench.ts
 *   latency           → tooling/benchmark_warm_daemon.ts
 *   insert-regression → tooling/benchmark_release_regressions.ts
 *   daemon-load       → tooling/benchmark_concurrent_agents.ts
 *
 * Optional (only included with --include-optional):
 *   release-hardening   → tooling/benchmark_release_hardening.ts
 *   llm-pool-contention → tooling/benchmark_llm_pool_contention.ts
 *
 * Exit codes:
 *   0  success (or non-enforced failure)
 *   1  unknown track or bad arguments
 *   2  enforced track failed
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

type Track = {
  name: string;
  script: string;
  args?: string[];
  optional?: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = pathResolve(dirname(__filename), "..", "..");

const TRACKS: Track[] = [
  { name: "bm25-quality", script: "tooling/benchmarks/section6_bench.ts" },
  { name: "latency", script: "tooling/benchmark_warm_daemon.ts" },
  { name: "insert-regression", script: "tooling/benchmark_release_regressions.ts" },
  { name: "daemon-load", script: "tooling/benchmark_concurrent_agents.ts" },
  { name: "release-hardening", script: "tooling/benchmark_release_hardening.ts", optional: true },
  { name: "llm-pool-contention", script: "tooling/benchmark_llm_pool_contention.ts", optional: true },
];

type Args = {
  tracks: string[];
  enforce: boolean;
  includeOptional: boolean;
  outputDir: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tracks: [],
    enforce: false,
    includeOptional: false,
    outputDir: pathResolve(REPO_ROOT, "tooling/artifacts"),
  };
  let runAll = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--track":
        args.tracks.push(String(argv[++i] ?? ""));
        break;
      case "--all":
        runAll = true;
        break;
      case "--enforce":
        args.enforce = true;
        break;
      case "--include-optional":
        args.includeOptional = true;
        break;
      case "--output-dir":
        args.outputDir = pathResolve(String(argv[++i] ?? args.outputDir));
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (arg && arg.startsWith("--")) {
          console.error(`Unknown flag: ${arg}`);
          process.exit(1);
        }
    }
  }

  if (runAll) {
    args.tracks = TRACKS
      .filter((t) => args.includeOptional || !t.optional)
      .map((t) => t.name);
  }

  if (args.tracks.length === 0) {
    console.error("No tracks specified. Use --track <name> or --all.");
    printHelp();
    process.exit(1);
  }

  return args;
}

function printHelp(): void {
  console.log(`KINDX benchmark runner

  --track <name>      Run a single track. Repeat for multiple.
  --all               Run all enforced tracks.
  --include-optional  Also include optional tracks (only with --all).
  --enforce           Exit 2 if any track fails.
  --output-dir <p>    Where to write JSON artifacts (default: tooling/artifacts).

Tracks:`);
  for (const t of TRACKS) {
    const optMark = t.optional ? " (optional)" : "";
    console.log(`  ${t.name.padEnd(22)} → ${t.script}${optMark}`);
  }
}

type TrackResult = {
  name: string;
  script: string;
  exitCode: number;
  durationMs: number;
  passed: boolean;
};

function runTrack(track: Track, enforce: boolean, outputDir: string): TrackResult {
  const scriptPath = pathResolve(REPO_ROOT, track.script);
  if (!existsSync(scriptPath)) {
    console.error(`\n[runner] track "${track.name}": script not found at ${track.script}`);
    return {
      name: track.name,
      script: track.script,
      exitCode: 127,
      durationMs: 0,
      passed: false,
    };
  }

  console.log(`\n[runner] ▶ ${track.name}  (${track.script})`);
  const start = Date.now();
  const result = spawnSync(
    pathResolve(REPO_ROOT, "node_modules/.bin/tsx"),
    [scriptPath, ...(track.args ?? [])],
    {
      stdio: "inherit",
      cwd: REPO_ROOT,
      env: { ...process.env, KINDX_BENCH_ENFORCE: enforce ? "1" : "0" },
    }
  );
  const durationMs = Date.now() - start;
  const exitCode = result.status ?? 1;
  const passed = exitCode === 0;
  console.log(`[runner] ${passed ? "✓" : "✗"} ${track.name} exited ${exitCode} in ${(durationMs / 1000).toFixed(1)}s`);
  return { name: track.name, script: track.script, exitCode, durationMs, passed };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const trackMap = new Map(TRACKS.map((t) => [t.name, t]));
  const results: TrackResult[] = [];

  for (const name of args.tracks) {
    const track = trackMap.get(name);
    if (!track) {
      console.error(`[runner] unknown track: ${name}`);
      results.push({ name, script: "(unknown)", exitCode: 1, durationMs: 0, passed: false });
      continue;
    }
    results.push(runTrack(track, args.enforce, args.outputDir));
  }

  // Write a summary artifact
  try {
    mkdirSync(args.outputDir, { recursive: true });
    const summaryPath = pathResolve(args.outputDir, "runner-summary.json");
    writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          enforce: args.enforce,
          includeOptional: args.includeOptional,
          results,
        },
        null,
        2
      ),
      "utf-8"
    );
    console.log(`\n[runner] summary written to ${summaryPath}`);
  } catch (err) {
    console.error(`[runner] failed to write summary: ${err}`);
  }

  console.log("\n[runner] Track results:");
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"}  ${r.name.padEnd(22)} exit=${r.exitCode}  ${(r.durationMs / 1000).toFixed(1)}s`);
  }

  const anyFailed = results.some((r) => !r.passed);
  if (anyFailed && args.enforce) {
    process.exit(2);
  }
}

main();
