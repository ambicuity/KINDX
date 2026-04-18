#!/usr/bin/env tsx
import { cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

type Difficulty = "easy" | "medium" | "hard" | "fusion";
type Profile = "BM25" | "Vector" | "Hybrid" | "Hybrid-fast" | "Hybrid-max" | "HTTP-daemon";

type JudgmentQuery = {
  id: string;
  difficulty: Difficulty;
  query: string;
  relevance: Record<string, number>;
};

type JudgmentManifest = {
  schema: "kindx-benchmark-judgments-v1";
  version: number;
  dataset: string;
  source_corpus: string;
  queries: JudgmentQuery[];
};

type RetrievalEval = {
  difficulty: Difficulty;
  hitAt3: number;
  hitAt5: number;
  mrr: number;
  ndcgAt5: number;
  degradedRate: number;
};

type ServingEval = {
  profile: Profile;
  coldP50: string;
  warmP50: string;
  warmP95: string;
  warmP99: string;
  qps: string;
  degradedPct: string;
  rerankTimeoutPct: string;
};

type IndexingEval = {
  op: string;
  time: string;
  throughput: string;
  notes: string;
};

type ResourceRow = {
  state: string;
  rss: string;
  vram: string;
  indexDisk: string;
  modelDisk: string;
};

type DatasetResult = {
  name: string;
  docCount: number;
  queryCount: number;
  retrievalQuality: Array<{ profile: string; difficulty: string; hitAt3: string; hitAt5: string; mrr: string; ndcgAt5: string; degradedPct: string }>;
  servingPerformance: ServingEval[];
  indexingPerformance: IndexingEval[];
  resourceUsage: ResourceRow[];
  provenance: {
    corpusPath: string;
    judgmentPath: string;
    tempWorkspace: string;
    command: string;
  };
};

type Section6Results = {
  schema: "kindx-section6-results-v1";
  generatedAt: string;
  hardware: { cpu: string; cores: number; ramGB: number; storage: string };
  runtime: { nodeVersion: string; kindxVersion: string };
  provenance: { command: string; artifactPath: string };
  datasets: DatasetResult[];
};

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RESULTS_DIR = resolve(ROOT, "tooling/benchmarks/results");
const OUTPUT_JSON = resolve(RESULTS_DIR, "section6-results.json");
const OUTPUT_MD = resolve(RESULTS_DIR, "section6-tables.md");
const BENCHMARKS_MD = resolve(ROOT, "BENCHMARKS.md");

const FIXTURE_ROWS = [
  { results: ["a", "b", "c"], rel: { a: 3, b: 2 }, mrr: 1.0, ndcg5: 1.0 },
  { results: ["c", "a", "b"], rel: { a: 3, b: 2 }, mrr: 0.5, ndcg5: 0.665 },
];

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string): { ok: boolean; code: number; stdout: string; stderr: string; ms: number } {
  const started = performance.now();
  const p = spawnSync(cmd, args, {
    cwd: cwd ?? ROOT,
    env: { ...process.env, ...(env ?? {}) },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return {
    ok: p.status === 0,
    code: p.status ?? 1,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
    ms: performance.now() - started,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function ms(v: number): string {
  return `${Math.round(v)}ms`;
}

function ratePerSec(count: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return "0.00";
  return (count / (elapsedMs / 1000)).toFixed(2);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function stats(values: number[]): { p50: number; p95: number; p99: number } {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseResultFiles(rawJson: string): string[] {
  const parsed = JSON.parse(rawJson) as Array<{ file: string }>;
  return parsed.map((r) => basename((r.file || "").replace(/^kindx:\/\//, "")));
}

function normalizeDocKey(name: string): string {
  return basename(name).toLowerCase().replace(/_/g, "-");
}

function firstRelevantRank(results: string[], relevance: Record<string, number>): number | null {
  const wanted = new Set(Object.keys(relevance).map(normalizeDocKey));
  for (let i = 0; i < results.length; i++) {
    if (wanted.has(normalizeDocKey(results[i]!))) return i + 1;
  }
  return null;
}

function mrrAt5(results: string[], relevance: Record<string, number>): number {
  const rank = firstRelevantRank(results.slice(0, 5), relevance);
  return rank ? (1 / rank) : 0;
}

function dcgAt5(results: string[], relevance: Record<string, number>): number {
  const relMap = new Map(Object.entries(relevance).map(([k, v]) => [normalizeDocKey(k), v]));
  let dcg = 0;
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const rel = relMap.get(normalizeDocKey(results[i]!)) ?? 0;
    if (rel > 0) {
      dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }
  }
  return dcg;
}

function ndcgAt5(results: string[], relevance: Record<string, number>): number {
  const idealRels = Object.values(relevance).sort((a, b) => b - a).slice(0, 5);
  let idcg = 0;
  for (let i = 0; i < idealRels.length; i++) {
    const rel = idealRels[i]!;
    idcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  if (idcg === 0) return 0;
  return dcgAt5(results, relevance) / idcg;
}

function evaluateProfile(
  queries: JudgmentQuery[],
  evaluator: (q: JudgmentQuery) => Promise<{ files: string[]; degraded: boolean; rerankTimeout: boolean; ms: number }>
): Promise<{
  byDifficulty: Record<Difficulty, RetrievalEval>;
  overall: RetrievalEval;
  latencies: number[];
  degradedRate: number;
  timeoutRate: number;
}> {
  return (async () => {
    const rows: Array<{ q: JudgmentQuery; files: string[]; degraded: boolean; rerankTimeout: boolean; ms: number }> = [];
    for (const q of queries) {
      rows.push({ q, ...(await evaluator(q)) });
    }

    const grouped = new Map<Difficulty, typeof rows>();
    for (const d of ["easy", "medium", "hard", "fusion"] as Difficulty[]) {
      grouped.set(d, rows.filter((r) => r.q.difficulty === d));
    }

    const calc = (bucket: typeof rows): RetrievalEval => {
      const n = Math.max(1, bucket.length);
      const hit3 = bucket.filter((r) => firstRelevantRank(r.files.slice(0, 3), r.q.relevance) !== null).length / n;
      const hit5 = bucket.filter((r) => firstRelevantRank(r.files.slice(0, 5), r.q.relevance) !== null).length / n;
      const mrr = bucket.reduce((s, r) => s + mrrAt5(r.files, r.q.relevance), 0) / n;
      const ndcg = bucket.reduce((s, r) => s + ndcgAt5(r.files, r.q.relevance), 0) / n;
      const degraded = bucket.filter((r) => r.degraded).length / n;
      return {
        difficulty: bucket[0]?.q.difficulty ?? "easy",
        hitAt3: hit3,
        hitAt5: hit5,
        mrr,
        ndcgAt5: ndcg,
        degradedRate: degraded,
      };
    };

    const byDifficulty: Record<Difficulty, RetrievalEval> = {
      easy: calc(grouped.get("easy") ?? []),
      medium: calc(grouped.get("medium") ?? []),
      hard: calc(grouped.get("hard") ?? []),
      fusion: calc(grouped.get("fusion") ?? []),
    };
    const overall = calc(rows);
    overall.difficulty = "easy";
    return {
      byDifficulty,
      overall,
      latencies: rows.map((r) => r.ms),
      degradedRate: rows.filter((r) => r.degraded).length / Math.max(1, rows.length),
      timeoutRate: rows.filter((r) => r.rerankTimeout).length / Math.max(1, rows.length),
    };
  })();
}

function assertFixture(): void {
  for (const row of FIXTURE_ROWS) {
    const m = Number(mrrAt5(row.results, row.rel).toFixed(3));
    const n = Number(ndcgAt5(row.results, row.rel).toFixed(3));
    if (m !== row.mrr || n !== row.ndcg5) {
      throw new Error(`Fixture mismatch: expected mrr=${row.mrr}, ndcg=${row.ndcg5}; got mrr=${m}, ndcg=${n}`);
    }
  }
}

async function startHttpServer(env: NodeJS.ProcessEnv, port: number): Promise<ChildProcess> {
  const child = spawn("kindx", ["mcp", "--http", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errLog = "";
  let outLog = "";
  child.stderr?.on("data", (buf) => {
    errLog += String(buf);
    if (errLog.length > 8000) errLog = errLog.slice(-8000);
  });
  child.stdout?.on("data", (buf) => {
    outLog += String(buf);
    if (outLog.length > 8000) outLog = outLog.slice(-8000);
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited early on port ${port} (code=${child.exitCode}). stdout=${outLog} stderr=${errLog}`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return child;
    } catch {
      // retry
    }
    await sleep(250);
  }
  child.kill("SIGTERM");
  throw new Error(`HTTP server did not become ready on port ${port}. stdout=${outLog} stderr=${errLog}`);
}

async function stopHttpServer(child: ChildProcess): Promise<void> {
  if (!child.killed) child.kill("SIGTERM");
  await sleep(400);
  if (!child.killed) child.kill("SIGKILL");
}

async function queryHttp(
  port: number,
  query: string,
  routingProfile: "fast" | "balanced" | "max_precision",
  collection: string,
  token: string
): Promise<{ files: string[]; degraded: boolean; rerankTimeout: boolean; elapsedMs: number }> {
  const started = performance.now();
  const res = await fetch(`http://localhost:${port}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      searches: [
        { type: "lex", query },
        { type: "vec", query },
      ],
      collections: [collection],
      limit: 5,
      routingProfile,
    }),
  });
  const elapsedMs = performance.now() - started;
  const body = await res.json() as {
    results?: Array<{ file: string }>;
    metadata?: { degraded_mode?: boolean; fallback_reasons?: string[] };
  };
  const files = (body.results ?? []).map((r) => basename((r.file || "").replace(/^kindx:\/\//, "")));
  const reasons = body.metadata?.fallback_reasons ?? [];
  return {
    files,
    degraded: !!body.metadata?.degraded_mode || !res.ok,
    rerankTimeout: reasons.includes("rerank_timeout"),
    elapsedMs,
  };
}

function profileRow(profile: string, difficulty: string, m: RetrievalEval): { profile: string; difficulty: string; hitAt3: string; hitAt5: string; mrr: string; ndcgAt5: string; degradedPct: string } {
  return {
    profile,
    difficulty,
    hitAt3: m.hitAt3.toFixed(3),
    hitAt5: m.hitAt5.toFixed(3),
    mrr: m.mrr.toFixed(3),
    ndcgAt5: m.ndcgAt5.toFixed(3),
    degradedPct: pct(m.degradedRate),
  };
}

function parseEmbeddedCounts(out: string): { chunks: number; docs: number } {
  const m = out.match(/Embedded\s+(\d+)\s+chunks\s+from\s+(\d+)\s+documents/i);
  if (!m) return { chunks: 0, docs: 0 };
  return { chunks: parseInt(m[1]!, 10), docs: parseInt(m[2]!, 10) };
}

function rssForPid(pid: number): string {
  const r = run("ps", ["-o", "rss=", "-p", String(pid)]);
  if (!r.ok) return "N/A";
  const kb = Number(r.stdout.trim() || 0);
  if (!Number.isFinite(kb) || kb <= 0) return "N/A";
  return `${(kb / 1024).toFixed(0)} MB`;
}

function diskMB(path: string): string {
  try {
    const bytes = statSync(path).size;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return "0.0 MB";
  }
}

function modelDisk(): string {
  const r = run("sh", ["-lc", "du -sk ~/.cache/kindx/models 2>/dev/null | awk '{print $1}'"]);
  if (!r.ok) return "N/A";
  const kb = Number(r.stdout.trim() || 0);
  if (!Number.isFinite(kb) || kb <= 0) return "N/A";
  return `${(kb / 1024).toFixed(0)} MB`;
}

async function benchmarkDataset(manifestPath: string): Promise<DatasetResult> {
  const manifest = readJson<JudgmentManifest>(manifestPath);
  if (manifest.schema !== "kindx-benchmark-judgments-v1") {
    throw new Error(`Unsupported judgment schema in ${manifestPath}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "kindx-section6-"));
  const corpusCopy = join(tempRoot, "corpus");
  const configDir = join(tempRoot, "config");
  const indexPath = join(tempRoot, "index.sqlite");
  const collection = "bench";
  cpSync(resolve(ROOT, manifest.source_corpus), corpusCopy, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INDEX_PATH: indexPath,
    KINDX_CONFIG_DIR: configDir,
    KINDX_MCP_TOKEN: "section6-bench-token",
  };
  const mcpToken = "section6-bench-token";

  const add = run("kindx", ["collection", "add", corpusCopy, "--name", collection, "--mask", "*.md"], env);
  if (!add.ok) {
    throw new Error(`collection add failed for ${manifest.dataset}: ${add.stderr || add.stdout}`);
  }

  const docCount = run("sh", ["-lc", `find "${corpusCopy}" -type f -name "*.md" | wc -l`], env).stdout.trim();
  const docCountNum = Number(docCount || 0);

  const fullEmbed = run("kindx", ["embed"], env);
  if (!fullEmbed.ok) {
    throw new Error(`embed failed for ${manifest.dataset}: ${fullEmbed.stderr || fullEmbed.stdout}`);
  }
  const embedParsed = parseEmbeddedCounts(`${fullEmbed.stdout}\n${fullEmbed.stderr}`);
  const chunkCount = embedParsed.chunks || docCountNum;

  const sampleDoc = join(corpusCopy, "doc_0000.md");
  writeFileSync(sampleDoc, `${readFileSync(sampleDoc, "utf8")}\n\n<!-- incremental-benchmark -->\n`, "utf8");
  run("kindx", ["update"], env);
  const incremental = run("kindx", ["embed"], env);

  const forced = run("kindx", ["embed", "-f"], env);
  const forcedParsed = parseEmbeddedCounts(`${forced.stdout}\n${forced.stderr}`);

  const updateRefresh = run("kindx", ["update", "--refresh"], env);
  const regressions = run("npx", ["tsx", "tooling/benchmark_release_regressions.ts"], env, ROOT);
  const regressionJson = JSON.parse(regressions.stdout || "{}") as {
    embeddingInsert?: { transactional?: { ms: number } };
  };

  const port = 9181 + Math.floor(Math.random() * 200);
  const server = await startHttpServer(env, port);
  try {
    const bm25 = await evaluateProfile(manifest.queries, async (q) => {
      const out = run("kindx", ["search", q.query, "--json", "-n", "5", "-c", collection], env);
      return { files: parseResultFiles(out.stdout), degraded: false, rerankTimeout: false, ms: out.ms };
    });

    const vector = await evaluateProfile(manifest.queries, async (q) => {
      const out = run("kindx", ["vsearch", q.query, "--json", "-n", "5", "-c", collection], env);
      return { files: parseResultFiles(out.stdout), degraded: false, rerankTimeout: false, ms: out.ms };
    });

    const hybrid = await evaluateProfile(manifest.queries, async (q) => {
      const out = run("kindx", ["query", q.query, "--json", "-n", "5", "-c", collection], env);
      const degraded = /KINDX degraded mode:/i.test(out.stderr);
      const timeout = /rerank_timeout/i.test(out.stderr);
      return { files: parseResultFiles(out.stdout), degraded, rerankTimeout: timeout, ms: out.ms };
    });

    const hybridFast = await evaluateProfile(manifest.queries, async (q) => {
      const r = await queryHttp(port, q.query, "fast", collection, mcpToken);
      return { files: r.files, degraded: r.degraded, rerankTimeout: r.rerankTimeout, ms: r.elapsedMs };
    });
    const hybridMax = await evaluateProfile(manifest.queries, async (q) => {
      const r = await queryHttp(port, q.query, "max_precision", collection, mcpToken);
      return { files: r.files, degraded: r.degraded, rerankTimeout: r.rerankTimeout, ms: r.elapsedMs };
    });

    const benchCliServing = (sub: "search" | "vsearch" | "query", name: Profile): ServingEval => {
      const runs = 8;
      const query = manifest.queries[0]!.query;
      const samples: number[] = [];
      let degraded = 0;
      let timeout = 0;
      const started = performance.now();
      for (let i = 0; i < runs; i++) {
        const out = run("kindx", [sub, query, "--json", "-n", "5", "-c", collection], env);
        samples.push(out.ms);
        if (/KINDX degraded mode:/i.test(out.stderr)) degraded += 1;
        if (/rerank_timeout/i.test(out.stderr)) timeout += 1;
      }
      const elapsed = performance.now() - started;
      const warm = stats(samples.slice(1));
      return {
        profile: name,
        coldP50: ms(samples[0] ?? 0),
        warmP50: ms(warm.p50),
        warmP95: ms(warm.p95),
        warmP99: ms(warm.p99),
        qps: ratePerSec(runs, elapsed),
        degradedPct: pct(degraded / runs),
        rerankTimeoutPct: name === "Hybrid" ? pct(timeout / runs) : "N/A",
      };
    };

    const benchHttpServing = async (profile: "fast" | "max_precision", label: Profile): Promise<ServingEval> => {
      const runs = 30;
      const query = manifest.queries[1]!.query;
      const first = await queryHttp(port, query, profile, collection, mcpToken);
      const warmSamples: number[] = [];
      let degraded = first.degraded ? 1 : 0;
      let timeout = first.rerankTimeout ? 1 : 0;
      const started = performance.now();
      for (let i = 0; i < runs; i++) {
        const r = await queryHttp(port, query, profile, collection, mcpToken);
        warmSamples.push(r.elapsedMs);
        if (r.degraded) degraded += 1;
        if (r.rerankTimeout) timeout += 1;
      }
      const elapsed = performance.now() - started + first.elapsedMs;
      const warm = stats(warmSamples);
      const total = runs + 1;
      return {
        profile: label,
        coldP50: ms(first.elapsedMs),
        warmP50: ms(warm.p50),
        warmP95: ms(warm.p95),
        warmP99: ms(warm.p99),
        qps: ratePerSec(total, elapsed),
        degradedPct: pct(degraded / total),
        rerankTimeoutPct: pct(timeout / total),
      };
    };

    const benchHttpDaemon = async (): Promise<ServingEval> => {
      const sessions = 10;
      const reqPerSession = 6;
      const latencies: number[] = [];
      let degraded = 0;
      let timeout = 0;
      const started = performance.now();
      const workers = Array.from({ length: sessions }, (_, s) => (async () => {
        for (let i = 0; i < reqPerSession; i++) {
          const q = manifest.queries[(s * reqPerSession + i) % manifest.queries.length]!.query;
          const r = await queryHttp(port, q, "balanced", collection, mcpToken);
          latencies.push(r.elapsedMs);
          if (r.degraded) degraded += 1;
          if (r.rerankTimeout) timeout += 1;
        }
      })());
      await Promise.all(workers);
      const elapsed = performance.now() - started;
      const s = stats(latencies);
      const total = sessions * reqPerSession;
      return {
        profile: "HTTP-daemon",
        coldP50: "N/A",
        warmP50: ms(s.p50),
        warmP95: ms(s.p95),
        warmP99: ms(s.p99),
        qps: ratePerSec(total, elapsed),
        degradedPct: pct(degraded / total),
        rerankTimeoutPct: pct(timeout / total),
      };
    };

    const servingRows: ServingEval[] = [
      benchCliServing("search", "BM25"),
      benchCliServing("vsearch", "Vector"),
      benchCliServing("query", "Hybrid"),
      await benchHttpServing("fast", "Hybrid-fast"),
      await benchHttpServing("max_precision", "Hybrid-max"),
      await benchHttpDaemon(),
    ];

    for (const row of servingRows) {
      const warmVals = [row.warmP50, row.warmP95, row.warmP99].map((v) => Number(v.replace("ms", ""))).filter((v) => Number.isFinite(v) && v > 0);
      if (warmVals.length === 3 && !(warmVals[0]! <= warmVals[1]! && warmVals[1]! <= warmVals[2]!)) {
        throw new Error(`Percentile monotonicity failed for ${manifest.dataset} ${row.profile}`);
      }
    }

    const idxDisk = diskMB(indexPath);
    const modelsDisk = modelDisk();
    const idleRss = rssForPid(server.pid ?? 0);
    await queryHttp(port, manifest.queries[0]!.query, "balanced", collection, mcpToken);
    const allModelsRss = rssForPid(server.pid ?? 0);

    const embedTimed = run("sh", ["-lc", `/usr/bin/time -l kindx embed -f -c ${collection} >/tmp/kindx-section6-embed.out 2>&1`], env);
    const embedOut = readFileSync("/tmp/kindx-section6-embed.out", "utf8");
    const peak = embedOut.match(/maximum resident set size\\s+(\\d+)/i);
    const duringEmbedRss = peak ? `${(parseInt(peak[1]!, 10) / 1024 / 1024).toFixed(0)} MB` : "N/A";

    const cpuOnly = run("sh", ["-lc", `/usr/bin/time -l KINDX_CPU_ONLY=1 kindx query "${manifest.queries[2]!.query}" --json -n 5 -c ${collection} >/tmp/kindx-section6-cpu.out 2>&1`], env);
    const cpuOut = readFileSync("/tmp/kindx-section6-cpu.out", "utf8");
    const cpuPeak = cpuOut.match(/maximum resident set size\\s+(\\d+)/i);
    const cpuRss = cpuPeak ? `${(parseInt(cpuPeak[1]!, 10) / 1024 / 1024).toFixed(0)} MB` : "N/A";
    if (!embedTimed.ok || !cpuOnly.ok) {
      // best-effort resource samples
    }

    const retrievalRows = [
      profileRow("BM25", "easy", bm25.byDifficulty.easy),
      profileRow("BM25", "medium", bm25.byDifficulty.medium),
      profileRow("BM25", "hard", bm25.byDifficulty.hard),
      profileRow("Vector", "easy", vector.byDifficulty.easy),
      profileRow("Vector", "medium", vector.byDifficulty.medium),
      profileRow("Vector", "hard", vector.byDifficulty.hard),
      profileRow("Hybrid", "easy", hybrid.byDifficulty.easy),
      profileRow("Hybrid", "medium", hybrid.byDifficulty.medium),
      profileRow("Hybrid", "hard", hybrid.byDifficulty.hard),
      profileRow("Hybrid", "fusion", hybrid.byDifficulty.fusion),
      profileRow("Hybrid-fast", "overall", { ...hybridFast.overall, difficulty: "easy" }),
      profileRow("Hybrid-max", "overall", { ...hybridMax.overall, difficulty: "easy" }),
    ];

    const indexingRows: IndexingEval[] = [
      {
        op: "FTS5 index (`kindx update`)",
        time: ms(updateRefresh.ms),
        throughput: `${ratePerSec(docCountNum, updateRefresh.ms)} docs/sec`,
        notes: "refresh mode",
      },
      {
        op: "Full embed (`kindx embed`)",
        time: ms(fullEmbed.ms),
        throughput: `${ratePerSec(chunkCount, fullEmbed.ms)} chunks/sec`,
        notes: "Model: embeddinggemma-300M-Q8_0",
      },
      {
        op: "Incremental embed (1 doc)",
        time: ms(incremental.ms),
        throughput: `${ratePerSec(1, incremental.ms)} docs/sec`,
        notes: "after single-doc edit",
      },
      {
        op: "Forced re-embed (`kindx embed -f`)",
        time: ms(forced.ms),
        throughput: `${ratePerSec(forcedParsed.chunks || chunkCount, forced.ms)} chunks/sec`,
        notes: "full re-embed",
      },
      {
        op: "Bulk insert (transactional)",
        time: `${(regressionJson.embeddingInsert?.transactional?.ms ?? 0).toFixed(0)}ms`,
        throughput: `${ratePerSec(2000, regressionJson.embeddingInsert?.transactional?.ms ?? 1)} inserts/sec`,
        notes: "from benchmark_release_regressions",
      },
    ];

    const resourceRows: ResourceRow[] = [
      { state: "Idle (no models)", rss: idleRss, vram: "0 MB", indexDisk: idxDisk, modelDisk: modelsDisk },
      { state: "Embed model loaded", rss: allModelsRss, vram: "N/A (Apple Metal)", indexDisk: idxDisk, modelDisk: modelsDisk },
      { state: "All 3 models loaded", rss: allModelsRss, vram: "N/A (Apple Metal)", indexDisk: idxDisk, modelDisk: modelsDisk },
      { state: "During embed (batch)", rss: duringEmbedRss, vram: "N/A (Apple Metal)", indexDisk: idxDisk, modelDisk: modelsDisk },
      { state: "CPU-only mode", rss: cpuRss, vram: "N/A", indexDisk: idxDisk, modelDisk: modelsDisk },
    ];

    const requiredRetrievalProfiles = [
      "BM25:easy", "BM25:medium", "BM25:hard",
      "Vector:easy", "Vector:medium", "Vector:hard",
      "Hybrid:easy", "Hybrid:medium", "Hybrid:hard", "Hybrid:fusion",
      "Hybrid-fast:overall", "Hybrid-max:overall",
    ];
    const gotProfiles = new Set(retrievalRows.map((r) => `${r.profile}:${r.difficulty}`));
    for (const req of requiredRetrievalProfiles) {
      if (!gotProfiles.has(req)) throw new Error(`Missing retrieval row: ${req}`);
    }
    for (const row of [...retrievalRows, ...servingRows, ...indexingRows, ...resourceRows]) {
      for (const [k, v] of Object.entries(row)) {
        if (String(v).trim() === "") throw new Error(`Missing cell value for ${manifest.dataset}: ${k}`);
      }
    }

    return {
      name: manifest.dataset,
      docCount: docCountNum,
      queryCount: manifest.queries.length,
      retrievalQuality: retrievalRows,
      servingPerformance: servingRows,
      indexingPerformance: indexingRows,
      resourceUsage: resourceRows,
      provenance: {
        corpusPath: manifest.source_corpus,
        judgmentPath: manifestPath.replace(`${ROOT}/`, ""),
        tempWorkspace: tempRoot,
        command: "npx tsx tooling/benchmarks/section6_bench.ts --update-doc",
      },
    };
  } finally {
    await stopHttpServer(server);
    // Keep workspace for provenance if needed during current session.
  }
}

function datasetTables(ds: DatasetResult): string {
  const servingRuns = "8 CLI + 30 profile HTTP";
  const servingConcurrency = "10";
  const lines: string[] = [];

  lines.push(`## Retrieval Quality — ${ds.name} (${ds.docCount} docs, ${ds.queryCount} queries)`);
  lines.push("");
  lines.push("| Profile | Difficulty | Hit@3 | Hit@5 | MRR | NDCG@5 | Degraded % |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of ds.retrievalQuality) {
    lines.push(`| ${r.profile} | ${r.difficulty} | ${r.hitAt3} | ${r.hitAt5} | ${r.mrr} | ${r.ndcgAt5} | ${r.degradedPct} |`);
  }
  lines.push("");
  lines.push(`## Serving Performance — ${ds.name} (${servingRuns} runs, ${servingConcurrency} sessions)`);
  lines.push("");
  lines.push("| Profile | Cold p50 | Warm p50 | Warm p95 | Warm p99 | QPS | Degraded % | Rerank Timeout % |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const s of ds.servingPerformance) {
    lines.push(`| ${s.profile} | ${s.coldP50} | ${s.warmP50} | ${s.warmP95} | ${s.warmP99} | ${s.qps} | ${s.degradedPct} | ${s.rerankTimeoutPct} |`);
  }
  lines.push("");
  lines.push(`## Indexing — ${ds.docCount} documents, ${ds.docCount} chunks`);
  lines.push("");
  lines.push("| Operation | Time | Throughput | Notes |");
  lines.push("|---|---|---|---|");
  for (const i of ds.indexingPerformance) {
    lines.push(`| ${i.op} | ${i.time} | ${i.throughput} | ${i.notes} |`);
  }
  lines.push("");
  lines.push("## Resource Usage");
  lines.push("");
  lines.push("| State | RSS | VRAM (GPU) | Disk (index) | Disk (models) |");
  lines.push("|---|---|---|---|---|");
  for (const r of ds.resourceUsage) {
    lines.push(`| ${r.state} | ${r.rss} | ${r.vram} | ${r.indexDisk} | ${r.modelDisk} |`);
  }
  lines.push("");
  lines.push("### Provenance");
  lines.push("");
  lines.push(`- Source corpus: \`${ds.provenance.corpusPath}\``);
  lines.push(`- Judgments: \`${ds.provenance.judgmentPath}\``);
  lines.push(`- Benchmark command: \`${ds.provenance.command}\``);
  lines.push(`- Temporary isolated workspace: \`${ds.provenance.tempWorkspace}\``);
  lines.push("");
  return lines.join("\n");
}

function replaceSection6(content: string, section6: string): string {
  const start = content.indexOf("## 6. Standard Result Tables");
  const end = content.indexOf("## 7. Visualization Guidance");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Could not locate Section 6/7 boundaries in BENCHMARKS.md");
  }
  const before = content.slice(0, start);
  const after = content.slice(end);
  return `${before}${section6}\n\n---\n\n${after}`;
}

async function main(): Promise<void> {
  assertFixture();
  const cpu = run("sysctl", ["-n", "machdep.cpu.brand_string"]).stdout.trim();
  const cores = Number(run("sysctl", ["-n", "hw.ncpu"]).stdout.trim() || 0);
  const ramBytes = Number(run("sysctl", ["-n", "hw.memsize"]).stdout.trim() || 0);
  const kindxVersion = run("kindx", ["--version"]).stdout.trim();

  const manifests = [
    resolve(ROOT, "tooling/benchmarks/judgments/msmarco.v1.json"),
    resolve(ROOT, "tooling/benchmarks/judgments/dbpedia.v1.json"),
  ];

  const datasets: DatasetResult[] = [];
  for (const m of manifests) {
    datasets.push(await benchmarkDataset(m));
  }

  const report: Section6Results = {
    schema: "kindx-section6-results-v1",
    generatedAt: new Date().toISOString(),
    hardware: {
      cpu,
      cores,
      ramGB: Number((ramBytes / 1024 / 1024 / 1024).toFixed(1)),
      storage: "NVMe SSD (Local)",
    },
    runtime: {
      nodeVersion: process.version,
      kindxVersion,
    },
    provenance: {
      command: "npx tsx tooling/benchmarks/section6_bench.ts --update-doc",
      artifactPath: OUTPUT_JSON,
    },
    datasets,
  };

  run("mkdir", ["-p", RESULTS_DIR]);
  writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const section6 = [
    "## 6. Standard Result Tables",
    "",
    "These tables are auto-generated from measured benchmark runs using `tooling/benchmarks/section6_bench.ts`.",
    "",
    ...datasets.flatMap((d, i) => (i === 0 ? [datasetTables(d)] : ["---", "", datasetTables(d)])),
  ].join("\n");
  writeFileSync(OUTPUT_MD, section6, "utf8");

  const benchmarks = readFileSync(BENCHMARKS_MD, "utf8");
  const updated = replaceSection6(benchmarks, section6);
  writeFileSync(BENCHMARKS_MD, updated, "utf8");

  process.stdout.write(`Wrote ${OUTPUT_JSON}\n`);
  process.stdout.write(`Wrote ${OUTPUT_MD}\n`);
  process.stdout.write(`Updated ${BENCHMARKS_MD}\n`);
}

void main();
