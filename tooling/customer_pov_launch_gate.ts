#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Phase = "P0" | "P1" | "P2" | "P3";
type Status = "pass" | "fail" | "skip";

type Task = {
  id: string;
  phase: Phase;
  title: string;
  command: string;
  required: boolean;
  reason?: string;
  precheck?: () => { ok: boolean; reason?: string };
};

type Result = {
  id: string;
  phase: Phase;
  title: string;
  required: boolean;
  status: Status;
  code: number | null;
  durationMs: number;
  reason?: string;
};

type Args = {
  phase: Phase | "all";
  output: string;
  stopOnFailure: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const idx = argv.findIndex((token) => token === `--${name}`);
    if (idx < 0) return undefined;
    return argv[idx + 1];
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const phaseRaw = (get("phase") ?? "P0").toUpperCase();
  const phase = (phaseRaw === "ALL" ? "all" : phaseRaw) as Phase | "all";
  if (phase !== "all" && phase !== "P0" && phase !== "P1" && phase !== "P2" && phase !== "P3") {
    throw new Error(`Invalid --phase: ${phaseRaw}. Expected P0|P1|P2|P3|all`);
  }

  return {
    phase,
    output: get("output") ?? "tooling/artifacts/customer-pov-launch-gate.json",
    stopOnFailure: has("stop-on-failure"),
    dryRun: has("dry-run"),
  };
}

function commandExists(cmd: string): boolean {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [cmd] : ["-v", cmd];
  const proc = spawnSync(checker, args, { stdio: "ignore", shell: process.platform !== "win32" });
  return proc.status === 0;
}

function runCommand(cmd: string): { code: number | null; durationMs: number } {
  const started = Date.now();
  const proc = spawnSync(cmd, {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  return {
    code: proc.status,
    durationMs: Date.now() - started,
  };
}

function phaseTasks(): Task[] {
  return [
    {
      id: "P0-1",
      phase: "P0",
      title: "Build CLI and runtime artifacts",
      command: "npm run build",
      required: true,
    },
    {
      id: "P0-2",
      phase: "P0",
      title: "Core launch-blocking regression suite (CLI/ops/retrieval/MCP/RBAC)",
      command: "npx vitest run specs/command-line.test.ts specs/ops-cli.test.ts specs/e2e-retrieval.test.ts specs/mcp.test.ts specs/rbac.test.ts --reporter=verbose",
      required: true,
    },
    {
      id: "P0-3",
      phase: "P0",
      title: "Containerized install smoke (build image only)",
      command: "bash specs/smoke-install.sh --build",
      required: false,
      reason: "Optional when docker/podman is unavailable in CI or developer workstation",
      precheck: () => {
        if (commandExists("docker") || commandExists("podman")) {
          return { ok: true };
        }
        return { ok: false, reason: "docker/podman not available" };
      },
    },
    {
      id: "P1-1",
      phase: "P1",
      title: "Outcome E2E suites for retrieval/output/session behavior",
      command: "npx vitest run specs/structured-search.test.ts specs/renderer.test.ts specs/multi-collection-filter.test.ts specs/session.test.ts specs/regression.test.ts --reporter=verbose",
      required: true,
    },
    {
      id: "P1-2",
      phase: "P1",
      title: "Release hardening benchmark sample",
      command: "npx tsx tooling/benchmark_release_hardening.ts --runs 5 --query \"auth token flow\"",
      required: false,
      reason: "Requires indexed corpus and local model/runtime readiness",
    },
    {
      id: "P2-1",
      phase: "P2",
      title: "Resilience and diagnostics suite",
      command: "npx vitest run specs/encryption.test.ts specs/ingestion.test.ts specs/store.test.ts specs/watch-lifecycle-robustness.test.ts specs/mcp-control-plane.test.ts --reporter=verbose",
      required: true,
    },
    {
      id: "P2-2",
      phase: "P2",
      title: "Warm daemon benchmark with thresholds",
      command: "npx tsx tooling/benchmark_warm_daemon.ts --base-url http://127.0.0.1:8181/query --thresholds tooling/perf-thresholds.json",
      required: false,
      reason: "Requires active HTTP daemon and seeded corpus",
    },
    {
      id: "P3-1",
      phase: "P3",
      title: "Scale and parallelism suite",
      command: "npx vitest run specs/llm-pool.test.ts specs/cli-advanced-parallel.test.ts specs/cli-core-parallel.test.ts --reporter=verbose",
      required: true,
    },
    {
      id: "P3-2",
      phase: "P3",
      title: "Cross-client/manual launch blockers",
      command: "echo 'Manual gate: run cross-platform install matrix, MCP client interoperability, privacy trace validation, and 24h soak evidence capture.'",
      required: false,
      reason: "Manual evidence gate by design (cannot be fully automated in a single host run)",
    },
  ];
}

function inScope(task: Task, phase: Phase | "all"): boolean {
  if (phase === "all") return true;
  return task.phase === phase;
}

function evaluate(runPhase: Phase | "all", stopOnFailure: boolean, dryRun: boolean): Result[] {
  const tasks = phaseTasks().filter((task) => inScope(task, runPhase));
  const results: Result[] = [];

  for (const task of tasks) {
    process.stdout.write(`\n==> [${task.phase}] ${task.id} ${task.title}\n`);

    if (task.precheck) {
      const check = task.precheck();
      if (!check.ok) {
        results.push({
          id: task.id,
          phase: task.phase,
          title: task.title,
          required: task.required,
          status: "skip",
          code: null,
          durationMs: 0,
          reason: check.reason ?? task.reason,
        });
        process.stdout.write(`    skipped: ${check.reason ?? "precheck failed"}\n`);
        continue;
      }
    }

    if (dryRun) {
      results.push({
        id: task.id,
        phase: task.phase,
        title: task.title,
        required: task.required,
        status: "skip",
        code: null,
        durationMs: 0,
        reason: "dry-run",
      });
      process.stdout.write(`    skipped: dry-run (${task.command})\n`);
      continue;
    }

    const outcome = runCommand(task.command);
    const pass = outcome.code === 0;
    const status: Status = pass ? "pass" : (task.required ? "fail" : "skip");
    const reason = pass ? undefined : (task.reason ?? "command failed");

    results.push({
      id: task.id,
      phase: task.phase,
      title: task.title,
      required: task.required,
      status,
      code: outcome.code,
      durationMs: outcome.durationMs,
      reason,
    });

    process.stdout.write(`    result: ${status} (code=${String(outcome.code)}, ${outcome.durationMs}ms)\n`);

    if (status === "fail" && stopOnFailure) {
      process.stdout.write("    stopping early due to --stop-on-failure\n");
      break;
    }
  }

  return results;
}

function summarize(results: Result[]): { overall: "pass" | "fail"; requiredFailures: number; requiredPasses: number; skipped: number } {
  let requiredFailures = 0;
  let requiredPasses = 0;
  let skipped = 0;

  for (const result of results) {
    if (result.status === "skip") skipped += 1;
    if (!result.required) continue;
    if (result.status === "pass") requiredPasses += 1;
    if (result.status === "fail") requiredFailures += 1;
  }

  return {
    overall: requiredFailures > 0 ? "fail" : "pass",
    requiredFailures,
    requiredPasses,
    skipped,
  };
}

function writeReport(outputPath: string, payload: unknown): void {
  const absolute = resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(payload, null, 2));
  process.stdout.write(`\nReport written: ${absolute}\n`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const started = new Date().toISOString();

  const results = evaluate(args.phase, args.stopOnFailure, args.dryRun);
  const summary = summarize(results);

  const payload = {
    started_at: started,
    completed_at: new Date().toISOString(),
    phase: args.phase,
    summary,
    results,
    notes: [
      "Manual launch blockers (cross-platform matrix, real MCP client interoperability, privacy network proof, and 24h soak) must be attached separately using the evidence template.",
      "Reference runbook: reference/runbooks/customer-pov-launch-readiness.md",
      "Reference evidence template: reference/runbooks/customer-pov-evidence-template.md",
    ],
  };

  writeReport(args.output, payload);

  process.stdout.write(`\nOverall: ${summary.overall} | required_passes=${summary.requiredPasses} required_failures=${summary.requiredFailures} skipped=${summary.skipped}\n`);
  process.exit(summary.overall === "pass" ? 0 : 2);
}

main();
