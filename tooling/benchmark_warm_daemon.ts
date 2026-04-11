#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Args = {
  baseUrl: string;
  token?: string;
  sessions: number[];
  docEquivalent: number[];
  requestsPerSession: number;
  routingProfile: "fast" | "balanced" | "max_precision";
  thresholdsPath?: string;
  outputPath: string;
  summaryPath?: string;
  enforce: boolean;
};

type ScenarioMetrics = {
  docEquivalent: number;
  sessions: number;
  requests: number;
  p95LatencyMs: number;
  rerankTimeoutRate: number;
  queueSaturationRate: number;
  degradedModeRate: number;
  requestErrorRate: number;
};

type ThresholdSpec = {
  informational?: boolean;
  defaults?: {
    p95QueryLatencyMs?: number;
    maxRerankTimeoutRate?: number;
    maxQueueSaturationRate?: number;
    maxDegradedModeRate?: number;
  };
  scenarios?: Array<{
    sessions: number;
    p95QueryLatencyMs?: number;
    maxRerankTimeoutRate?: number;
    maxQueueSaturationRate?: number;
    maxDegradedModeRate?: number;
  }>;
};

function parseList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw || raw.trim().length === 0) return fallback;
  return raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.floor(v));
}

function parseArgs(argv: string[]): Args {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "Usage: tsx tooling/benchmark_warm_daemon.ts [options]",
        "",
        "Options:",
        "  --base-url <url>                 Query endpoint (default http://127.0.0.1:8788/query)",
        "  --token <bearer-token>           Optional auth token",
        "  --sessions <csv>                 Concurrent session counts (default 10,25,50)",
        "  --doc-equivalent <csv>           Labels for doc-equivalent runs (default 10000,50000,100000)",
        "  --requests-per-session <n>       Requests per session (default 6)",
        "  --routing-profile <profile>      fast|balanced|max_precision (default fast)",
        "  --thresholds <path>              Threshold config json",
        "  --output <path>                  JSON report output path",
        "  --summary <path>                 Markdown summary output path",
        "  --enforce                        Exit non-zero when thresholds are violated",
      ].join("\n") + "\n"
    );
    process.exit(0);
  }
  const get = (name: string): string | undefined => {
    const idx = argv.findIndex((v) => v === `--${name}`);
    if (idx < 0) return undefined;
    return argv[idx + 1];
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const routingRaw = (get("routing-profile") || "fast").toLowerCase();
  const routingProfile = routingRaw === "balanced" || routingRaw === "max_precision" ? routingRaw : "fast";
  return {
    baseUrl: get("base-url") || "http://127.0.0.1:8788/query",
    token: get("token"),
    sessions: parseList(get("sessions"), [10, 25, 50]),
    docEquivalent: parseList(get("doc-equivalent"), [10000, 50000, 100000]),
    requestsPerSession: Math.max(1, Number(get("requests-per-session") || 6)),
    routingProfile,
    thresholdsPath: get("thresholds"),
    outputPath: get("output") || "tooling/artifacts/warm-daemon-benchmark.json",
    summaryPath: get("summary"),
    enforce: has("enforce"),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] || 0;
}

async function runRequest(args: Args, query: string): Promise<{
  latencyMs: number;
  degraded: boolean;
  rerankTimeout: boolean;
  queueSaturated: boolean;
  requestError: boolean;
}> {
  const started = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.token) headers.Authorization = `Bearer ${args.token}`;
  try {
    const res = await fetch(args.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        searches: [{ type: "lex", query }],
        limit: 8,
        routingProfile: args.routingProfile,
      }),
    });
    const body = await res.json().catch(() => ({}));
    const fallbackReasons = Array.isArray(body?.metadata?.fallback_reasons) ? body.metadata.fallback_reasons as string[] : [];
    const degraded = Boolean(body?.metadata?.degraded_mode) || !res.ok;
    return {
      latencyMs: Date.now() - started,
      degraded,
      rerankTimeout: fallbackReasons.includes("rerank_timeout"),
      queueSaturated: fallbackReasons.includes("rerank_queue_saturated"),
      requestError: !res.ok,
    };
  } catch {
    return {
      latencyMs: Date.now() - started,
      degraded: true,
      rerankTimeout: false,
      queueSaturated: false,
      requestError: true,
    };
  }
}

async function runScenario(args: Args, docEquivalent: number, sessions: number): Promise<ScenarioMetrics> {
  const latencies: number[] = [];
  let degradedCount = 0;
  let timeoutCount = 0;
  let saturatedCount = 0;
  let requestErrorCount = 0;
  const requests = sessions * args.requestsPerSession;

  const workers = Array.from({ length: sessions }, (_, sessionIdx) => (async () => {
    for (let i = 0; i < args.requestsPerSession; i++) {
      const query = `delta throughput benchmark doceq${docEquivalent} session${sessionIdx} req${i}`;
      const one = await runRequest(args, query);
      latencies.push(one.latencyMs);
      if (one.degraded) degradedCount += 1;
      if (one.rerankTimeout) timeoutCount += 1;
      if (one.queueSaturated) saturatedCount += 1;
      if (one.requestError) requestErrorCount += 1;
    }
  })());
  await Promise.all(workers);

  return {
    docEquivalent,
    sessions,
    requests,
    p95LatencyMs: Number(percentile(latencies, 95).toFixed(2)),
    rerankTimeoutRate: Number((timeoutCount / Math.max(1, requests)).toFixed(4)),
    queueSaturationRate: Number((saturatedCount / Math.max(1, requests)).toFixed(4)),
    degradedModeRate: Number((degradedCount / Math.max(1, requests)).toFixed(4)),
    requestErrorRate: Number((requestErrorCount / Math.max(1, requests)).toFixed(4)),
  };
}

function loadThresholds(path?: string): ThresholdSpec | null {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ThresholdSpec;
  } catch {
    return null;
  }
}

function evaluateThresholds(metrics: ScenarioMetrics[], thresholds: ThresholdSpec | null): string[] {
  if (!thresholds) return [];
  const violations: string[] = [];
  const defaults = thresholds.defaults || {};
  const bySessions = new Map((thresholds.scenarios || []).map((s) => [s.sessions, s]));

  for (const item of metrics) {
    const scenario = bySessions.get(item.sessions);
    const maxP95 = scenario?.p95QueryLatencyMs ?? defaults.p95QueryLatencyMs;
    const maxTimeoutRate = scenario?.maxRerankTimeoutRate ?? defaults.maxRerankTimeoutRate;
    const maxSaturationRate = scenario?.maxQueueSaturationRate ?? defaults.maxQueueSaturationRate;
    const maxDegradedRate = scenario?.maxDegradedModeRate ?? defaults.maxDegradedModeRate;

    if (typeof maxP95 === "number" && item.p95LatencyMs > maxP95) {
      violations.push(`sessions=${item.sessions} doceq=${item.docEquivalent}: p95 ${item.p95LatencyMs} > ${maxP95}`);
    }
    if (typeof maxTimeoutRate === "number" && item.rerankTimeoutRate > maxTimeoutRate) {
      violations.push(`sessions=${item.sessions} doceq=${item.docEquivalent}: rerank_timeout_rate ${item.rerankTimeoutRate} > ${maxTimeoutRate}`);
    }
    if (typeof maxSaturationRate === "number" && item.queueSaturationRate > maxSaturationRate) {
      violations.push(`sessions=${item.sessions} doceq=${item.docEquivalent}: queue_saturation_rate ${item.queueSaturationRate} > ${maxSaturationRate}`);
    }
    if (typeof maxDegradedRate === "number" && item.degradedModeRate > maxDegradedRate) {
      violations.push(`sessions=${item.sessions} doceq=${item.docEquivalent}: degraded_mode_rate ${item.degradedModeRate} > ${maxDegradedRate}`);
    }
  }
  return violations;
}

function renderSummary(metrics: ScenarioMetrics[], violations: string[], args: Args): string {
  const lines: string[] = [];
  lines.push("# KINDX Warm-Daemon Benchmark (Informational)");
  lines.push("");
  lines.push(`- base_url: \`${args.baseUrl}\``);
  lines.push(`- routing_profile: \`${args.routingProfile}\``);
  lines.push(`- requests_per_session: ${args.requestsPerSession}`);
  lines.push("");
  lines.push("| doc-equivalent | sessions | requests | p95 latency ms | rerank timeout rate | queue saturation rate | degraded mode rate |");
  lines.push("|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of metrics) {
    lines.push(`| ${row.docEquivalent} | ${row.sessions} | ${row.requests} | ${row.p95LatencyMs} | ${row.rerankTimeoutRate} | ${row.queueSaturationRate} | ${row.degradedModeRate} (err=${row.requestErrorRate}) |`);
  }
  lines.push("");
  if (violations.length === 0) {
    lines.push("No threshold violations.");
  } else {
    lines.push("Threshold violations:");
    for (const v of violations) lines.push(`- ${v}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const metrics: ScenarioMetrics[] = [];
  for (const docEq of args.docEquivalent) {
    for (const sessions of args.sessions) {
      metrics.push(await runScenario(args, docEq, sessions));
    }
  }

  const thresholds = loadThresholds(args.thresholdsPath);
  const violations = evaluateThresholds(metrics, thresholds);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    routingProfile: args.routingProfile,
    requestsPerSession: args.requestsPerSession,
    metrics,
    violations,
    informational: true,
  };

  mkdirSync(dirname(resolve(args.outputPath)), { recursive: true });
  writeFileSync(resolve(args.outputPath), JSON.stringify(report, null, 2), "utf-8");
  const summary = renderSummary(metrics, violations, args);
  if (args.summaryPath) {
    mkdirSync(dirname(resolve(args.summaryPath)), { recursive: true });
    writeFileSync(resolve(args.summaryPath), summary, "utf-8");
  }
  process.stdout.write(summary + "\n");

  if (args.enforce && violations.length > 0) {
    process.exit(2);
  }
}

void main();
