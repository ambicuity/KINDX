/**
 * E2E Retrieval Integration Test
 *
 * Validates the FULL retrieval pipeline end-to-end without mocks:
 *   1. Index a corpus of markdown files
 *   2. Run BM25 search and verify results
 *   3. Run get/multi-get and verify document content
 *   4. Validate structured output (JSON, CSV, XML)
 *   5. Validate collection filtering
 *   6. Validate ranking sanity (relevant docs score higher)
 *
 * This test spawns real `kindx` CLI processes with isolated temp databases.
 * It does NOT use mocked LLM calls — only exercises BM25/FTS and get.
 * Vector search (vsearch/query) requires GGUF models and is covered
 * by skipIf-guarded tests in store.test.ts and inference.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const kindxBin = join(projectRoot, "bin", "kindx");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;
let dbPath: string;
let configDir: string;
let corpusDir: string;

async function runKindx(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = opts.cwd ?? corpusDir;
  const proc = spawn(process.execPath, [kindxBin, ...args], {
    cwd,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      KINDX_CONFIG_DIR: configDir,
      PWD: cwd,
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutP = new Promise<string>((resolve, reject) => {
    let d = "";
    proc.stdout?.on("data", (c: Buffer) => { d += c.toString(); });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(d));
  });
  const stderrP = new Promise<string>((resolve, reject) => {
    let d = "";
    proc.stderr?.on("data", (c: Buffer) => { d += c.toString(); });
    proc.once("error", reject);
    proc.stderr?.once("end", () => resolve(d));
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });

  return { stdout: await stdoutP, stderr: await stderrP, exitCode };
}

// ---------------------------------------------------------------------------
// Corpus: deterministic, themed content for ranking validation
// ---------------------------------------------------------------------------

const CORPUS: Record<string, string> = {
  "architecture.md": `# System Architecture

## Overview
The system uses a modular microservices architecture deployed on Kubernetes.

## Components
- **API Gateway**: Handles authentication and rate limiting
- **Search Service**: Full-text and vector retrieval engine
- **Index Service**: Manages document ingestion and chunking
- **Storage Layer**: PostgreSQL for metadata, S3 for raw documents

## Data Flow
Incoming documents are chunked, embedded, and stored in vector indexes.
Queries are expanded, routed to multiple retrieval backends, and results
are fused using reciprocal rank fusion before reranking.
`,

  "deployment.md": `# Deployment Guide

## Prerequisites
- Docker 24+
- Kubernetes 1.28+
- Helm 3.x

## Steps
1. Build container images: \`docker build -t app:latest .\`
2. Push to registry: \`docker push registry.example.com/app:latest\`
3. Apply Helm chart: \`helm install app ./charts/app\`

## Rollback
If deployment fails, run:
\`\`\`bash
helm rollback app 1
\`\`\`

## Monitoring
Use Grafana dashboards for real-time observability.
`,

  "api/authentication.md": `# Authentication API

## Overview
All API requests require a Bearer token obtained via OAuth2.

## Endpoints

### POST /auth/token
Request an access token using client credentials.

### POST /auth/refresh
Refresh an expired access token.

### DELETE /auth/revoke
Revoke an active token.

## Token Format
Tokens are JWT with RS256 signing. Claims include:
- \`sub\`: Subject (user ID)
- \`exp\`: Expiration (Unix timestamp)
- \`scope\`: Granted permissions
`,

  "api/search.md": `# Search API

## Endpoints

### GET /api/search
Full-text search across indexed documents.

Parameters:
- \`q\` (required): Search query string
- \`limit\` (optional): Max results, default 10
- \`collection\` (optional): Filter by collection name

### GET /api/vsearch
Vector similarity search using embeddings.

### POST /api/query
Hybrid search with automatic query expansion and reranking.

## Response Format
\`\`\`json
{
  "results": [
    {"file": "doc.md", "score": 0.95, "snippet": "..."}
  ],
  "timing_ms": 42
}
\`\`\`
`,

  "notes/meeting-2025-01.md": `# January Planning Meeting

## Attendees
- Alice (Engineering Lead)
- Bob (Product Manager)
- Charlie (DevOps)

## Discussion
Reviewed Q1 roadmap. Agreed to prioritize search performance improvements
and authentication hardening. Charlie raised concerns about Kubernetes
resource limits in staging.

## Action Items
1. Alice: Benchmark retrieval latency under load
2. Bob: Finalize feature spec for hybrid search
3. Charlie: Increase staging cluster capacity
`,

  "notes/meeting-2025-02.md": `# February Retrospective

## Attendees
- Alice, Bob, Charlie, Dana

## Highlights
- Search latency improved 40% after index optimization
- Authentication service passed security audit
- Deployed canary release to 5% of traffic

## Issues
- Occasional timeout on large document embeddings
- Need better error messages for expired tokens
`,
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!existsSync(kindxBin)) throw new Error(`Missing: ${kindxBin}`);
  if (!existsSync(join(projectRoot, "dist", "kindx.js")))
    throw new Error("dist/kindx.js missing — run npm run build first");

  testDir = await mkdtemp(join(tmpdir(), "kindx-e2e-"));
  dbPath = join(testDir, "e2e.sqlite");
  configDir = join(testDir, "config");
  corpusDir = join(testDir, "corpus");

  await mkdir(configDir, { recursive: true });
  await mkdir(join(corpusDir, "api"), { recursive: true });
  await mkdir(join(corpusDir, "notes"), { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");

  // Write corpus files
  for (const [relPath, content] of Object.entries(CORPUS)) {
    await writeFile(join(corpusDir, relPath), content);
  }

  // Index the corpus as two collections for filter tests
  const addAll = await runKindx(["collection", "add", ".", "--name", "docs", "--mask", "**/*.md"]);
  if (addAll.exitCode !== 0) throw new Error(`Index failed: ${addAll.stderr}`);

  const addNotes = await runKindx(["collection", "add", ".", "--name", "notes", "--mask", "notes/*.md"]);
  if (addNotes.exitCode !== 0) throw new Error(`Notes index failed: ${addNotes.stderr}`);
}, 30_000);

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E retrieval pipeline", () => {
  // =========================================================================
  // 1. Index verification
  // =========================================================================

  test("status shows indexed documents", async () => {
    const { stdout, exitCode } = await runKindx(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("docs");
    expect(stdout).toContain("notes");
    expect(stdout).toContain("files indexed");
  });

  test("ls lists files in collection", async () => {
    const { stdout, exitCode } = await runKindx(["ls", "docs"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("architecture.md");
    expect(stdout).toContain("deployment.md");
    expect(stdout).toContain("api/authentication.md");
    expect(stdout).toContain("api/search.md");
  });

  // =========================================================================
  // 2. BM25 search correctness
  // =========================================================================

  test("search returns relevant results for 'authentication'", async () => {
    const { stdout, exitCode } = await runKindx(["search", "authentication"]);
    expect(exitCode).toBe(0);
    // authentication.md should rank highest for this query
    expect(stdout.toLowerCase()).toContain("authentication");
    expect(stdout).not.toContain("No results");
  });

  test("search returns relevant results for 'kubernetes deployment'", async () => {
    const { stdout, exitCode } = await runKindx(["search", "kubernetes deployment"]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("deployment");
  });

  test("search returns no results for garbage query", async () => {
    const { stdout, exitCode } = await runKindx(["search", "zzznonexistent999xyz"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results");
  });

  // =========================================================================
  // 3. Ranking sanity: domain-specific terms surface the right doc
  // =========================================================================

  test("ranking: 'JWT token' surfaces authentication doc first in JSON", async () => {
    const { stdout, exitCode } = await runKindx(["search", "JWT token", "--json"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout) as { file: string; score: number }[];
    expect(results.length).toBeGreaterThan(0);
    // The top result should be the authentication doc (contains JWT, token references)
    expect(results[0]!.file).toContain("authentication");
  });

  test("ranking: 'Helm rollback' surfaces deployment doc first in JSON", async () => {
    const { stdout, exitCode } = await runKindx(["search", "Helm rollback", "--json"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout) as { file: string; score: number }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.file).toContain("deployment");
  });

  test("ranking: 'reciprocal rank fusion' surfaces architecture doc first", async () => {
    const { stdout, exitCode } = await runKindx(["search", "reciprocal rank fusion", "--json"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout) as { file: string; score: number }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.file).toContain("architecture");
  });

  // =========================================================================
  // 4. Collection filtering
  // =========================================================================

  test("search with -c filters to notes collection", async () => {
    const { stdout, exitCode } = await runKindx(["search", "meeting", "-c", "notes"]);
    expect(exitCode).toBe(0);
    // Should find meeting notes
    expect(stdout.toLowerCase()).toContain("meeting");
  });

  // =========================================================================
  // 5. Document retrieval (get / multi-get)
  // =========================================================================

  test("get retrieves document content", async () => {
    const { stdout, exitCode } = await runKindx(["get", "architecture.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("System Architecture");
    expect(stdout).toContain("microservices");
  });

  test("get retrieves subdirectory document", async () => {
    const { stdout, exitCode } = await runKindx(["get", "api/authentication.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Bearer token");
  });

  test("get with --from and -l slices lines", async () => {
    const { stdout, exitCode } = await runKindx(["get", "deployment.md", "--from", "3", "-l", "3"]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  test("get with --line-numbers includes line prefixes", async () => {
    const { stdout, exitCode } = await runKindx(["get", "deployment.md", "--line-numbers"]);
    expect(exitCode).toBe(0);
    // Line numbers format: "1: # Deployment Guide"
    expect(stdout).toMatch(/^\d+:/m);
  });

  test("multi-get by glob retrieves multiple files", async () => {
    const { stdout, exitCode } = await runKindx(["multi-get", "notes/*.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("January Planning Meeting");
    expect(stdout).toContain("February Retrospective");
  });

  test("multi-get by comma-separated list", async () => {
    const { stdout, exitCode } = await runKindx(["multi-get", "architecture.md,deployment.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("System Architecture");
    expect(stdout).toContain("Deployment Guide");
  });

  // =========================================================================
  // 6. Structured output formats
  // =========================================================================

  test("--json outputs valid JSON array with required fields", async () => {
    const { stdout, exitCode } = await runKindx(["search", "search API", "--json"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout) as Record<string, unknown>[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    // Verify schema
    const first = results[0]!;
    expect(first).toHaveProperty("file");
    expect(first).toHaveProperty("score");
    expect(first).toHaveProperty("title");
  });

  test("--csv outputs header + data rows", async () => {
    const { stdout, exitCode } = await runKindx(["search", "search API", "--csv"]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + at least 1 result
    expect(lines[0]).toContain("docid");
    expect(lines[0]).toContain("score");
    expect(lines[0]).toContain("file");
  });

  test("--xml outputs well-formed XML with file tags", async () => {
    const { stdout, exitCode } = await runKindx(["search", "authentication", "--xml"]);
    expect(exitCode).toBe(0);
    // XML search format uses <file> tags with docid and name attributes
    expect(stdout).toContain("<file docid=");
    expect(stdout).toContain("</file>");
  });

  test("--md outputs markdown-formatted results", async () => {
    const { stdout, exitCode } = await runKindx(["search", "meeting", "--md"]);
    expect(exitCode).toBe(0);
    // Markdown format includes heading markers
    expect(stdout).toContain("#");
  });

  test("--files outputs bare file paths", async () => {
    const { stdout, exitCode } = await runKindx(["search", "meeting", "--files"]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Each line should be a file path ending in .md
    for (const line of lines) {
      expect(line.trim()).toMatch(/\.md$/);
    }
  });

  // =========================================================================
  // 7. Context management round-trip
  // =========================================================================

  test("context add + list round-trip", async () => {
    const addResult = await runKindx([
      "context", "add", "kindx://docs/api", "REST API reference documentation",
    ]);
    expect(addResult.exitCode).toBe(0);

    const listResult = await runKindx(["context", "list"]);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("REST API reference documentation");
  });

  // =========================================================================
  // 8. Error handling
  // =========================================================================

  test("get non-existent file returns error", async () => {
    const { exitCode } = await runKindx(["get", "does-not-exist.md"]);
    expect(exitCode).toBe(1);
  });

  test("search with empty query returns error", async () => {
    const { exitCode } = await runKindx(["search"]);
    expect(exitCode).toBe(1);
  });
});
