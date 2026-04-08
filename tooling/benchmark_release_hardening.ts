#!/usr/bin/env tsx
/**
 * Release hardening benchmark helper.
 *
 * Captures simple before/after-friendly metrics for:
 * - Embed throughput (`kindx embed`)
 * - Query TTFR (`kindx query`)
 *
 * Usage:
 *   tsx tooling/benchmark_release_hardening.ts --collection docs --query "search text" --runs 5
 */

import { spawnSync } from "node:child_process";

type Args = {
  collection?: string;
  query: string;
  runs: number;
};

function parseArgs(argv: string[]): Args {
  let collection: string | undefined;
  let query = "release hardening benchmark";
  let runs = 5;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--collection") {
      collection = argv[++i];
    } else if (token === "--query") {
      query = argv[++i] ?? query;
    } else if (token === "--runs") {
      runs = Number.parseInt(argv[++i] ?? "5", 10);
    }
  }

  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`Invalid --runs value: ${runs}`);
  }

  return { collection, query, runs };
}

function run(cmd: string[], env = process.env): { ok: boolean; stdout: string; stderr: string; ms: number } {
  const started = Date.now();
  const proc = spawnSync(cmd[0]!, cmd.slice(1), {
    env,
    encoding: "utf8",
  });
  return {
    ok: proc.status === 0,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    ms: Date.now() - started,
  };
}

function median(values: number[]): number {
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1]! + arr[mid]!) / 2 : arr[mid]!;
}

function p95(values: number[]): number {
  const arr = [...values].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * 0.95));
  return arr[Math.max(0, idx)]!;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const embed = run(["kindx", "embed"]);
  if (!embed.ok) {
    process.stderr.write(embed.stderr || embed.stdout);
    throw new Error("kindx embed failed");
  }

  const queryTimes: number[] = [];
  for (let i = 0; i < args.runs; i++) {
    const cmd = ["kindx", "query", args.query, "--json", "-n", "5"];
    if (args.collection) {
      cmd.push("-c", args.collection);
    }
    const queryRun = run(cmd);
    if (!queryRun.ok) {
      process.stderr.write(queryRun.stderr || queryRun.stdout);
      throw new Error(`kindx query failed on run ${i + 1}`);
    }
    queryTimes.push(queryRun.ms);
  }

  const report = {
    embed_ms: embed.ms,
    query_runs: args.runs,
    query_median_ms: median(queryTimes),
    query_p95_ms: p95(queryTimes),
    query_samples_ms: queryTimes,
    query: args.query,
    collection: args.collection ?? null,
    generated_at: new Date().toISOString(),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
