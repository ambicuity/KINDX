/**
 * KINDX MCP Server - Model Context Protocol server for KINDX
 *
 * Exposes KINDX search and document retrieval as MCP tools and resources.
 * Documents are accessible via kindx:// URIs.
 *
 * Follows MCP spec 2025-06-18 for proper response types.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "./utils/atomic-write.js";
import { timingSafeStringEqual } from "./utils/timing-safe.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "url";
import { logger } from "./utils/logger.js";
import { incCounter, observeHistogram, renderPrometheusMetrics } from "./utils/metrics.js";
import { buildOperationalStatus } from "./diagnostics.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildCapabilityManifest, SERVER_VERSION, type ToolRegistration } from "./capability-manifest.js";
export const requestIdentityScope = new AsyncLocalStorage<import("./rbac.js").ResolvedIdentity | null>();
import {
  createStore,
  extractSnippet,
  addLineNumbers,
  structuredSearchWithDiagnostics,
  DEFAULT_MULTI_GET_MAX_BYTES,
  getRerankThroughputSnapshot,
} from "./repository.js";
import type {
  Store,
  StructuredSubSearch,
  SearchRoutingProfile,
  StructuredSearchDiagnostics,
} from "./repository.js";
import { getCollection, getGlobalContext, getDefaultCollectionNames } from "./catalogs.js";
import { disposeDefaultLLM, disposeSensitiveContexts, getDefaultLLM, withLLMScope } from "./inference.js";
import { HealthChecker } from "./health-checker.js";
import {
  upsertMemory,
  semanticSearchMemory,
  textSearchMemory,
  getMemoryHistory,
  getMemoryStats,
  markMemoryAccessed,
  resolveMemoryScope,
  deriveWorkspaceMemoryScope,
  recordFeedback,
  initializeMemoryFeedbackSchema,
} from "./memory.js";
import {
  KindxSession,
  SessionRegistry,
  type SessionScopeContext,
} from "./session.js";
import { getShardHealthSummary } from "./sharding.js";
import { initializeAuditSchema, recordAudit, queryAuditLog, getAuditSummary, purgeOldAuditEntries } from "./audit.js";
import { collectBody, BodyTooLargeError } from "./http/body.js";
import { parseBearer } from "./http/bearer.js";
import { getDocumentVersions } from "./repository/content.js";
import { loadLayeredInstructions } from "./instruction-layering.js";
import {
  CircuitBreaker,
  FixedWindowRateLimiter,
  McpToolListCache,
  ToolQuotaManager,
  applyToolPolicy,
  buildResolvedHttpHeaders,
  buildToolProvenanceRegistry,
  isToolEnabledByPolicy,
  loadMcpControlPlaneConfig,
  resolveMcpServerControl,
} from "./mcp-control-plane.js";
import type {
  CircuitBreakerConfig,
  RateLimiterConfig,
  ResolvedMcpServerControl,
  ToolQuotaConfig,
} from "./mcp-control-plane.js";

// =============================================================================
// Types for structured content
// =============================================================================

type SearchResultItem = {
  docid: string;  // Short docid (#abc123) for quick reference
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
  _index?: string;
};

type StatusResult = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  capabilities: Record<string, string>;
  ann: {
    enabled: boolean;
    mode: "ann" | "exact";
    state: "ready" | "stale" | "missing" | "degraded";
    probeCount: number;
    shortlistLimit: number;
    details: Array<{ collection: string; shard: number; state: "ready" | "stale" | "missing" | "degraded"; reason: string }>;
  };
  encryption: {
    encrypted: boolean;
    keyConfigured: boolean;
    bytes: number;
  };
  ingestion: {
    warnedDocuments: number;
    byFormat: Array<{ format: string; count: number }>;
    byWarning: Array<{ warning: string; count: number }>;
  };
  vector_available: boolean;
  models_ready: boolean;
  db_integrity: "ok" | "failed";
  warnings: string[];
  collections: {
    name: string;
    path: string;
    pattern: string;
    documents: number;
    lastUpdated: string;
  }[];
  shards: {
    enabledCollections: Array<{ collection: string; shardCount: number }>;
    checkpointPath: string;
    checkpointExists: boolean;
    warnings: string[];
  };
  scale: {
    queueDepth: number;
    rerankConcurrency: number;
    queueActive: number;
    queueTimedOutTotal: number;
    queueSaturatedTotal: number;
    shardHealth: {
      status: "ok" | "warn" | "error";
      families: Record<"topology" | "checkpoint" | "read" | "write" | "parity", { count: number; severity: "warn" | "error" }>;
      warnings: string[];
    };
  };
  watchDaemon: "active" | "inactive";
};

type MemoryScopeContext = SessionScopeContext;
const KINDX_MCP_SERVER_ID = "kindx";
const KINDX_MCP_TOOL_NAMES = [
  "query",
  "get",
  "multi_get",
  "memory_put",
  "memory_search",
  "document_history",
  "document_diff",
  "audit_log",
] as const;

type QueryTimings = {
  expand_ms: number;
  embed_ms: number;
  retrieval_ms: number;
  rerank_init_ms: number;
  rerank_ms: number;
  total_ms: number;
  /** Adaptive query classification time (when auto-classification is used) */
  classify_ms: number;
  /**
   * Per-stage trace spans with named stages and wall-clock timing.
   * Inspired by Phoenix/OTEL span hierarchies for pipeline debugging.
   * Each span records the pipeline stage name, start/end timestamps, and duration.
   */
  spans: QueryTraceSpan[];
};

type QueryTraceSpan = {
  stage: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
};

type QueryMetadata = {
  timings: QueryTimings;
  degraded_mode: boolean;
  fallback_reason: string | null;
  fallback_reasons: string[];
  routing_profile: SearchRoutingProfile;
  scope: string;
  dedupe_joined: boolean;
  dedupe_join_hits: boolean;
  replay_artifact: string | null;
  replay_artifact_path: string | null;
  diagnostics: StructuredSearchDiagnostics;
  /** Detected query strategy from auto-classification (when applicable) */
  detected_strategy?: string;
};

function newTimings(): QueryTimings {
  return {
    expand_ms: 0,
    embed_ms: 0,
    retrieval_ms: 0,
    rerank_init_ms: 0,
    rerank_ms: 0,
    total_ms: 0,
    classify_ms: 0,
    spans: [],
  };
}

/** Record a trace span with wall-clock timing relative to query start */
function pushSpan(timings: QueryTimings, stage: string, startMs: number): void {
  const endMs = Date.now();
  timings.spans.push({
    stage,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: endMs - startMs,
  });
}

/**
 * Content-level snippet deduplication.
 *
 * Removes search results whose snippets are near-identical to a higher-scored result.
 * Uses token-set Jaccard similarity for fast comparison.
 * Results are already sorted by score (descending), so we keep the first (best) match.
 *
 * Inspired by LlamaIndex's NodeDedup and Haystack's DeduplicationFilter.
 */
function snippetDedup<T extends { _rawSnippet: string; score: number }>(
  results: T[],
  threshold: number,
): T[] {
  if (results.length <= 1 || threshold <= 0) return results;

  const tokenize = (text: string): Set<string> => {
    const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return new Set(tokens);
  };

  const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    const smaller = a.size <= b.size ? a : b;
    const larger = a.size <= b.size ? b : a;
    for (const token of smaller) {
      if (larger.has(token)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  };

  const kept: T[] = [];
  const keptTokens: Set<string>[] = [];

  for (const result of results) {
    const tokens = tokenize(result._rawSnippet);
    let isDuplicate = false;

    for (const existingTokens of keptTokens) {
      if (jaccardSimilarity(tokens, existingTokens) >= threshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      kept.push(result);
      keptTokens.push(tokens);
    }
  }

  return kept;
}

function parseQueryTimeoutMs(): number {
  const raw = process.env.KINDX_QUERY_TIMEOUT_MS?.trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(`KINDX Warning: invalid KINDX_QUERY_TIMEOUT_MS="${raw}", disabling timeout guard.\n`);
    return 0;
  }
  return parsed;
}

/**
 * Adaptive query strategy auto-classification.
 * Inspired by LangGraph's conditional edge routing and Haystack's pipeline routing.
 *
 * Classifies a raw query string to determine the optimal sub-query strategy:
 * - 'exact': Short terms, snake_case identifiers, quoted phrases → lex only (skip embedding overhead)
 * - 'question': Natural language questions → lex + vec (best recall)
 * - 'analytical': Complex analytical queries → lex + vec + hyde (maximum precision)
 *
 * This is a suggestion, not a gate. Users can always manually specify sub-queries.
 */
type QueryStrategy = 'exact' | 'question' | 'analytical';

function classifyQueryStrategy(query: string): QueryStrategy {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);
  const wordCount = words.length;

  // Exact match indicators: quoted phrases, snake_case, very short
  if (/^".*"$/.test(trimmed)) return 'exact';
  if (wordCount <= 2 && /[_.-]/.test(trimmed)) return 'exact';
  if (wordCount === 1) return 'exact';

  // Question indicators: starts with interrogative, ends with ?
  const questionStarters = /^(what|how|why|when|where|which|who|is|are|does|do|can|could|should|would|will|has|have|explain|describe)\b/i;
  if (questionStarters.test(trimmed) || trimmed.endsWith('?')) return 'question';

  // Analytical indicators: long queries, comparative language, abstract concepts
  if (wordCount >= 15) return 'analytical';
  const analyticalPatterns = /\b(compare|tradeoff|trade-off|versus|vs\.?|difference|relationship|impact|architecture|design|pattern|approach)\b/i;
  if (analyticalPatterns.test(trimmed)) return 'analytical';

  // Default to question for medium-length natural language
  if (wordCount >= 3) return 'question';

  return 'exact';
}

/**
 * Expand a single raw query into appropriate sub-searches based on auto-classification.
 * Returns the classified strategy and the expanded sub-search array.
 */
function autoExpandQuery(query: string): { strategy: QueryStrategy; searches: Array<{ type: string; query: string }> } {
  const strategy = classifyQueryStrategy(query);

  switch (strategy) {
    case 'exact':
      return {
        strategy,
        searches: [{ type: 'lex', query }],
      };
    case 'question':
      return {
        strategy,
        searches: [
          { type: 'lex', query },
          { type: 'vec', query },
        ],
      };
    case 'analytical':
      return {
        strategy,
        searches: [
          { type: 'lex', query },
          { type: 'vec', query },
          { type: 'hyde', query },
        ],
      };
  }
}

function getDedupeMode(): "join" | "off" {
  const raw = process.env.KINDX_INFLIGHT_DEDUPE?.trim().toLowerCase();
  if (!raw || raw === "join") return "join";
  if (raw === "off") return "off";
  process.stderr.write(`KINDX Warning: invalid KINDX_INFLIGHT_DEDUPE="${raw}", using "join".\n`);
  return "join";
}

function normalizeRoutingProfile(raw: unknown): SearchRoutingProfile {
  if (typeof raw !== "string") return "balanced";
  const v = raw.trim().toLowerCase();
  if (v === "fast" || v === "balanced" || v === "max_precision") return v;
  return "balanced";
}

function resolveProfilePolicy(profile: SearchRoutingProfile, candidateLimit?: number): {
  candidateLimit?: number;
  rerankLimit?: number;
} {
  if (profile === "fast") {
    return {
      candidateLimit: candidateLimit ?? 20,
      rerankLimit: 10,
    };
  }
  if (profile === "max_precision") {
    return {
      candidateLimit: candidateLimit ?? 60,
      rerankLimit: 50,
    };
  }
  return {
    candidateLimit,
    rerankLimit: candidateLimit,
  };
}

function resolveTimeoutByProfile(baseTimeoutMs: number, profile: SearchRoutingProfile): number {
  if (profile === "fast") {
    return baseTimeoutMs > 0 ? Math.min(baseTimeoutMs, 5_000) : 5_000;
  }
  if (profile === "max_precision") {
    return baseTimeoutMs > 0 ? Math.max(baseTimeoutMs, 15_000) : 15_000;
  }
  return baseTimeoutMs;
}

function inferAnnRoute(metadata: QueryMetadata): "ann" | "exact_fallback" | "n/a" {
  const declared = metadata.diagnostics?.ann?.route;
  if (declared === "ann" || declared === "exact_fallback" || declared === "n/a") {
    return declared;
  }
  const warnings = metadata.diagnostics?.scaleWarnings || [];
  const hasSharded = warnings.some((w) => w.startsWith("sharded_collection:"));
  const usedFallback = warnings.some((w) =>
    w.startsWith("ann_missing:")
    || w.startsWith("ann_stale:")
    || w.startsWith("ann_failed:")
  );
  if (!hasSharded) return "n/a";
  return usedFallback ? "exact_fallback" : "ann";
}

async function writeReplayArtifact(payload: {
  requestId?: string;
  scope: string;
  routingProfile: SearchRoutingProfile;
  searches: StructuredSubSearch[];
  collections?: string[];
  options: { limit?: number; minScore?: number; candidateLimit?: number };
  metadata: QueryMetadata;
  results: SearchResultItem[];
}): Promise<string | null> {
  const dir = process.env.KINDX_QUERY_REPLAY_DIR?.trim();
  if (!dir) return null;
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key = (payload.requestId && payload.requestId.trim()) || stableHash({
      scope: payload.scope,
      routingProfile: payload.routingProfile,
      searches: payload.searches,
      options: payload.options,
      ts: stamp,
    }).slice(0, 12);
    const abs = resolve(dir, `${stamp}_${key}.json`);
    const trace = {
      normalized_input: {
        scope: payload.scope,
        searches: payload.searches,
        collections: payload.collections ?? [],
        options: payload.options,
      },
      routing_decisions: {
        profile: payload.routingProfile,
        degraded_mode: payload.metadata.degraded_mode,
        fallback_reasons: payload.metadata.fallback_reasons,
      },
      score_trace: payload.results.map((r) => ({ docid: r.docid, score: r.score })),
      timings: payload.metadata.timings,
      fallback_path: payload.metadata.fallback_reason,
      results: payload.results,
    };
    await writeFile(abs, JSON.stringify(trace, null, 2), "utf-8");
    return abs;
  } catch (err) {
    process.stderr.write(`KINDX Warning: failed to write replay artifact. ${err}\n`);
    return null;
  }
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Encode a path for use in kindx:// URIs.
 * Encodes special characters but preserves forward slashes for readability.
 */
function encodeQmdPath(path: string): string {
  // Encode each path segment separately to preserve slashes
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Format search results as human-readable text summary
 */
function formatSearchSummary(results: SearchResultItem[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}"`;
  }
  const lines = [`Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n`];
  for (const r of results) {
    lines.push(`${r.docid} ${Math.round(r.score * 100)}% ${r.file} - ${r.title}`);
  }
  return lines.join('\n');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function extractWorkspaceUriFromInitialize(body: any): string | undefined {
  return firstString(
    body?.params?.rootUri,
    body?.params?.workspaceUri,
    body?.params?.workspace?.rootUri,
    body?.params?.workspace?.uri,
    body?.params?.workspaceFolders?.[0]?.uri,
    body?.params?.workspace?.folders?.[0]?.uri,
  );
}

function extractScopeContextFromInitialize(body: any): MemoryScopeContext {
  const workspaceUri = extractWorkspaceUriFromInitialize(body);
  const sessionScope = firstString(body?.params?.scope, body?.params?.sessionScope);
  const workspaceScope = deriveWorkspaceMemoryScope(workspaceUri);
  return {
    ...(sessionScope ? { sessionScope } : {}),
    ...(workspaceScope ? { workspaceScope } : {}),
    ...(workspaceUri ? { workspaceUri } : {}),
  };
}

function stableHash(value: unknown): string {
  const json = JSON.stringify(value);
  return createHash("sha256").update(json).digest("hex");
}

function raceWithTimeout<T>(
  promiseOrFn: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  code: string,
  sessionSignal?: AbortSignal
): Promise<T> {
  const ac = new AbortController();
  const signals = [ac.signal];
  if (sessionSignal && !sessionSignal.aborted) signals.push(sessionSignal);
  const composed = signals.length > 1 ? AbortSignal.any(signals) : ac.signal;
  const getPromise = () => typeof promiseOrFn === "function" ? promiseOrFn(composed) : promiseOrFn;
  if (timeoutMs <= 0) return getPromise();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ac.abort();
      reject(Object.assign(new Error(`Query timed out after ${timeoutMs}ms`), { code }));
    }, timeoutMs);
    timer.unref?.();
    getPromise().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// =============================================================================
// MCP Server
// =============================================================================

/**
 * Build dynamic server instructions from actual index state.
 * Injected into the LLM's system prompt via MCP initialize response.
 *
 * When a session is provided, surfaces the top 3 most-accessed workspace memories
 * inline so the LLM has immediate context without a separate tool call.
 */
const MEMORY_PREFETCH_LIMIT = 3;
const MEMORY_PREFETCH_LINE_MAX_CHARS = 120;
const MEMORY_PREFETCH_TOTAL_MAX_CHARS = 360;

// =============================================================================
// Auto-invocation contract — appears at top of MCP `initialize.instructions`.
// Rewording this changes how aggressively every MCP-aware agent picks up kindx.
// Snapshot-tested in specs/protocol-instructions.test.ts; update snapshots
// deliberately, with a one-line rationale in the commit message.
// =============================================================================
const AUTO_INVOCATION_CONTRACT = [
  "## When to call KINDX (auto-invocation contract)",
  "",
  "Before answering any user turn that is not a greeting, a pure code-generation request",
  "with no reference to user files, or a trivial yes/no, call `query` first.",
  "Auto-invoke is default-on. Skip only when:",
  "  (a) the user explicitly says \"don't search\",",
  "  (b) you already have results from a query this turn, or",
  "  (c) the request is exclusively about writing new code with no need to consult prior notes.",
  "",
  "Decision table:",
  "  | User turn shape                                          | First call                       |",
  "  |----------------------------------------------------------|----------------------------------|",
  "  | \"what did I write about X\" / \"find …\" / \"show me …\"     | `query` (lex+vec)                |",
  "  | \"open <path>\" / mentions a specific file                 | `get`                            |",
  "  | Question that could be answered by existing notes        | `query` (vec+hyde)               |",
  "  | New code, no file reference                              | skip kindx                       |",
  "  | Greeting / chitchat                                      | skip kindx                       |",
  "  | Memory-related (\"remember\", \"what did we decide\")        | `memory_search` then `memory_put`|",
  "",
  "Cost: default `query` returns top 3 snippets (~600 tokens). Pull bodies with `get`",
  "only for snippets that look relevant. Set `KINDX_AUTO_INVOKE=off` on the server to disable.",
].join("\n");

const MAX_INSTRUCTIONS_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n\n[instructions truncated — see kindx://capabilities]";

function isAutoInvokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.KINDX_AUTO_INVOKE ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

function buildInstructions(store: Store, session?: KindxSession): string {
  const status = store.getStatus();
  const lines: string[] = [];

  // --- Identity (always first) ---
  const collectionNames = status.collections.map((c) => `"${c.name}"`).join(", ");
  const collectionsClause = collectionNames ? ` across collections: ${collectionNames}` : "";
  lines.push(
    `KINDX is your local search index over ${status.totalDocuments} markdown documents${collectionsClause}.`,
  );
  const globalCtx = getGlobalContext();
  if (globalCtx) lines.push(`Context: ${globalCtx}`);

  // --- Auto-invocation contract (load-bearing) ---
  if (status.collections.length === 0) {
    lines.push("");
    lines.push("kindx is installed but has no collections — run `kindx collection add <path>` to enable auto-search.");
  } else if (isAutoInvokeEnabled()) {
    lines.push("");
    lines.push(AUTO_INVOCATION_CONTRACT);
    if (!status.hasVectorIndex) {
      lines.push("");
      lines.push("Note: lex-only mode — vector index not built. Do not call `vec`/`hyde`. Run `kindx embed` to enable semantic search.");
    } else if (status.needsEmbedding > 0) {
      lines.push("");
      lines.push(`Note: ${status.needsEmbedding} documents need re-embedding. Run \`kindx embed\` to update.`);
    }
  } else if (!status.hasVectorIndex) {
    lines.push("");
    lines.push("Note: No vector embeddings yet. Run `kindx embed` to enable semantic search (vec/hyde).");
  } else if (status.needsEmbedding > 0) {
    lines.push("");
    lines.push(`Note: ${status.needsEmbedding} documents need embedding. Run \`kindx embed\` to update.`);
  }

  // --- Layered project instructions (AGENTS.md / SOUL.md / CLAUDE.md) ---
  const layered = loadLayeredInstructions({
    cwd: process.cwd(),
    globalFiles: [resolve(homedir(), ".codex", "AGENTS.md")],
    fallbackFiles: ["AGENTS.md", "SOUL.md", "CLAUDE.md"],
    maxTotalBytes: 16 * 1024,
  });
  if (layered.sources.length > 0) {
    lines.push("");
    lines.push("Instruction layers loaded (global->project):");
    for (const src of layered.sources) {
      const note = src.truncated ? " (truncated)" : "";
      lines.push(`  - ${src.scope}: ${src.path}${note}`);
    }
    lines.push("");
    lines.push("Layered instructions:");
    lines.push(layered.text);
  }

  // --- Collections list (detail) ---
  if (status.collections.length > 0) {
    lines.push("");
    lines.push("Collections (scope with `collection` parameter):");
    for (const col of status.collections) {
      const collConfig = getCollection(col.name);
      const rootCtx = collConfig?.context?.[""] || collConfig?.context?.["/"];
      const desc = rootCtx ? ` — ${rootCtx}` : "";
      lines.push(`  - "${col.name}" (${col.documents} docs)${desc}`);
    }
  }

  // --- Workspace memory prefetch (unchanged behaviour, kept) ---
  const workspaceScope = session?.scopeContext?.workspaceScope;
  if (workspaceScope) {
    try {
      const stats = getMemoryStats(store.db, workspaceScope);
      let topMemories = stats.topAccessed.slice(0, MEMORY_PREFETCH_LIMIT);
      if (topMemories.length === 0) {
        const recentRows = store.db.prepare(`
          SELECT value FROM memories
          WHERE scope = ? AND superseded_by IS NULL
          ORDER BY accessed_count DESC, appeared_count DESC, id DESC
          LIMIT ?
        `).all(workspaceScope, MEMORY_PREFETCH_LIMIT) as { value: string }[];
        topMemories = recentRows.map((r) => ({ key: "", value: String(r.value ?? ""), accessed: 0 }));
      }
      if (topMemories.length > 0) {
        lines.push("");
        lines.push("Workspace memory (top accessed):");
        let remainingChars = MEMORY_PREFETCH_TOTAL_MAX_CHARS;
        for (const m of topMemories) {
          if (remainingChars <= 0) break;
          const normalized = String(m.value ?? "").replace(/\n/g, " ").trim();
          if (!normalized) continue;
          const line = normalized.slice(0, Math.min(MEMORY_PREFETCH_LINE_MAX_CHARS, remainingChars));
          lines.push(`  - ${line}`);
          remainingChars -= line.length;
        }
      }
    } catch { /* best-effort */ }
  }

  // --- Condensed search/retrieval reference (long examples now live in tool descriptions) ---
  if (status.collections.length > 0) {
    lines.push("");
    lines.push("Tools: `query` (lex/vec/hyde sub-queries), `get` (path or #docid), `multi_get` (glob/list). Use `minScore: 0.5` to filter low-confidence results. File paths in results are collection-relative.");
  }

  // --- Hard ceiling (byte-accurate, UTF-8 safe) ---
  let out = lines.join("\n");
  const outBuf = Buffer.from(out, "utf8");
  if (outBuf.length > MAX_INSTRUCTIONS_BYTES) {
    const markerLen = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    let end = MAX_INSTRUCTIONS_BYTES - markerLen;
    // Walk back to a UTF-8 boundary: continuation bytes are 10xxxxxx.
    while (end > 0 && (outBuf[end] & 0xc0) === 0x80) end--;
    out = outBuf.subarray(0, end).toString("utf8") + TRUNCATION_MARKER;
  }
  return out;
}

/**
 * Test hook: generate initialize instructions with optional session context.
 * Keeps production callsites unchanged while allowing deterministic unit tests.
 */
export function buildInstructionsForTest(store: Store, session?: KindxSession): string {
  return buildInstructions(store, session);
}

/**
 * Test hook: enumerate every tool that createMcpServer registers, together
 * with its description and raw zod inputSchema (not JSON-Schema-converted).
 *
 * Uses a minimal stub Store so no real SQLite database is required. The stub
 * is only used during server/tool registration — tool handlers are never
 * invoked by this helper.
 *
 * Call sites should set KINDX_ENABLE_MAINTENANCE_TOOLS=1 before invoking if
 * they want maintenance tools (status, memory_stats, etc.) to appear in the
 * returned list.
 */
export function listRegisteredToolsForTest(): Array<{
  name: string;
  description: string;
  inputSchema: any;
}> {
  // Minimal stub Store — buildInstructions only needs getStatus() (for
  // collections-length check) and store.db (for memory prefetch, which is
  // skipped when no session is provided). Tool handlers are not invoked
  // during registration, so nothing else needs to be real.
  const stubStore = {
    db: { prepare: () => ({ all: () => [], get: () => null }) } as any,
    dbPath: ":memory:",
    indexName: "test",
    getStatus: () => ({
      totalDocuments: 0,
      needsEmbedding: 0,
      hasVectorIndex: false,
      capabilities: {},
      ann: { enabled: false, mode: "exact" as const, state: "missing" as const, probeCount: 0, shortlistLimit: 0, details: [] },
      encryption: { encrypted: false, keyConfigured: false, bytes: 0 },
      ingestion: { warnedDocuments: 0, byFormat: [], byWarning: [] },
      collections: [],
      shards: { enabledCollections: [], checkpointPath: "", checkpointExists: false, warnings: [] },
    }),
  } as unknown as Store;

  const defs: Array<{ name: string; description: string; inputSchema: any }> = [];
  createMcpServer(stubStore, undefined, undefined, {
    onRegister: (name: string, def: any) => {
      defs.push({ name, description: def.description, inputSchema: def.inputSchema });
    },
  });
  return defs;
}

/**
 * Test hook: spin up a real McpServer backed by the given on-disk SQLite DB.
 * Designed for in-process pairing with InMemoryTransport so tests can exercise
 * the full initialize handshake without stdio.
 *
 * @param opts.dbPath   - Path to an existing KINDX SQLite database.
 * @param opts.indexName - Index name (must match the catalog YAML file name).
 */
export function startMcpServerForTest(opts?: { dbPath?: string; indexName?: string }): McpServer {
  const store = createStore(opts?.dbPath, opts?.indexName);
  return createMcpServer(store);
}

/**
 * Create an MCP server with all KINDX tools, resources, and prompts registered.
 * Shared by both stdio and HTTP transports.
 *
 * @param store - The shared KINDX database store
 * @param getScopeContext - Returns the current request-scoped MemoryScopeContext
 * @param getSession - Returns the current KindxSession (null for stdio single-session)
 */
function createMcpServer(
  store: Store,
  getScopeContext?: () => MemoryScopeContext | undefined,
  getSession?: () => KindxSession | null,
  options?: {
    mcpControl?: ResolvedMcpServerControl;
    /** Test-only hook: called after every successful tool registration. */
    onRegister?: (name: string, def: any) => void;
  },
): McpServer {
  const mcpControl = options?.mcpControl;
  const onRegister = options?.onRegister;
  const registeredToolDefs: ToolRegistration[] = [];
  const server = new McpServer(
    { name: "kindx", version: SERVER_VERSION },
    { instructions: buildInstructions(store, getSession?.() ?? undefined) },
  );
  const maybeRegisterTool = (
    name: string,
    def: any,
    handler: any,
  ): void => {
    if (mcpControl && !isToolEnabledByPolicy(mcpControl, name, {
      audit: (entry) => { try { recordAudit(store.db, { ...entry, action: entry.action as any }); } catch {} }
    })) {
      return;
    }

    // Dynamic Tool Scoping: Prune maintenance tools to save token overhead unless explicitly requested.
    const maintenanceTools = [
      "status",
      "memory_stats",
      "memory_bulk",
      "memory_delete",
      "memory_mark_accessed",
      "memory_history"
    ];
    if (maintenanceTools.includes(name) && !process.env.KINDX_ENABLE_MAINTENANCE_TOOLS) {
      return;
    }

    registeredToolDefs.push({
      name,
      description: def.description,
      readOnly: def.annotations?.readOnlyHint ?? false,
      inputSchema: def.inputSchema ?? {},
    });
    server.registerTool(name, def, handler);
    // Notify test hook after successful registration.
    onRegister?.(name, def);
  };

  function resolveToolScope(args: any): { scope?: string; errorText?: string } {
    const context = getScopeContext?.();
    const resolved = resolveMemoryScope({
      explicitScope: args?.scope,
      sessionScope: context?.sessionScope,
      workspaceScope: context?.workspaceScope,
      strictIsolation: true,
    });
    if (resolved.error) {
      return { errorText: `${resolved.error.code}: ${resolved.error.message}` };
    }
    return { scope: resolved.scope };
  }

  // ---------------------------------------------------------------------------
  // Resource: kindx://{path} - read-only access to documents by path
  // Note: No list() - documents are discovered via search tools
  // ---------------------------------------------------------------------------

  server.registerResource(
    "document",
    new ResourceTemplate("kindx://{+path}", { list: undefined }),
    {
      title: "KINDX Document",
      description: "A markdown document from your KINDX knowledge base. Use search tools to discover documents.",
      mimeType: "text/markdown",
    },
    async (uri: any, { path }: any) => {
      // Decode URL-encoded path (MCP clients send encoded URIs)
      const pathStr = Array.isArray(path) ? path.join('/') : (path || '');
      const decodedPath = decodeURIComponent(pathStr);

      // Parse virtual path: collection/relative/path
      const parts = decodedPath.split('/');
      const collection = parts[0] || '';
      const relativePath = parts.slice(1).join('/');

      // Find document by collection and path, join with content table
      let doc = store.db.prepare(`
        SELECT d.collection, d.path, d.title, c.doc as body
        FROM documents d
        JOIN content c ON c.hash = d.hash
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
      `).get(collection, relativePath) as { collection: string; path: string; title: string; body: string } | null;

      // Try suffix match if exact match fails
      if (!doc) {
        doc = store.db.prepare(`
          SELECT d.collection, d.path, d.title, c.doc as body
          FROM documents d
          JOIN content c ON c.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${relativePath}`) as { collection: string; path: string; title: string; body: string } | null;
      }

      if (!doc) {
        return { contents: [{ uri: uri.href, text: `Document not found: ${decodedPath}` }] };
      }

      // Construct virtual path for context lookup
      const virtualPath = `kindx://${doc.collection}/${doc.path}`;
      const context = store.getContextForFile(virtualPath);

      let text = addLineNumbers(doc.body);  // Default to line numbers
      if (context) {
        text = `<!-- Context: ${context} -->\n\n` + text;
      }

      const displayName = `${doc.collection}/${doc.path}`;
      return {
        contents: [{
          uri: uri.href,
          name: displayName,
          title: doc.title || doc.path,
          mimeType: "text/markdown",
          text,
        }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Resource: kindx://capabilities - machine-readable capability manifest
  // ---------------------------------------------------------------------------

  server.registerResource(
    "capabilities",
    "kindx://capabilities",
    {
      title: "KINDX Capabilities",
      description: "Machine-readable manifest of available tools, query types, collections, and runtime state.",
      mimeType: "application/json",
    },
    async (uri: any) => {
      try {
        const manifest = buildCapabilityManifest(store, registeredToolDefs);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(manifest, null, 2),
          }],
        };
      } catch (err) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              version: "1.0",
              error: err instanceof Error ? err.message : String(err),
            }, null, 2),
          }],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: query (Primary search tool)
  // ---------------------------------------------------------------------------

  const subSearchSchema = z.object({
    type: z.enum(['lex', 'vec', 'hyde']).describe(
      "lex = BM25 keywords (supports \"phrase\" and -negation); " +
      "vec = semantic question; hyde = hypothetical answer passage"
    ),
    query: z.string().describe(
      "The query text. For lex: use keywords, \"quoted phrases\", and -negation. " +
      "For vec: natural language question. For hyde: 50-100 word answer passage."
    ),
  });

  maybeRegisterTool(
    "query",
    {
      title: "Query",
      description: `Call this first whenever the user asks a question, references their notes/docs/codebase, or you need context grounded in the user's local knowledge.

## When to use
- User asks "what did I write about ...", "find ...", "show me ..."
- User asks a factual question whose answer might live in their notes
- You need background context before answering or editing
- Skip: greetings, pure code-generation with no file reference, trivial yes/no

## How to call
One or more typed sub-queries combined for best recall.

**lex** — BM25 keyword search. Fast, exact, no LLM needed.
- \`term\` — prefix match ("perf" matches "performance")
- \`"exact phrase"\` — phrase must appear verbatim
- \`-term\` or \`-"phrase"\` — exclude documents

**vec** — Semantic vector search. Write a natural-language question.

**hyde** — Hypothetical document. Write 50–100 words that look like the answer. Often the most powerful for nuanced topics.

| Goal | Approach |
|------|----------|
| Know exact term/name | \`lex\` only |
| Concept search | \`vec\` only |
| Best recall | \`lex\` + \`vec\` |
| Complex/nuanced | \`lex\` + \`vec\` + \`hyde\` |

Defaults to top 3 snippets (~600 tokens). Pull bodies with \`get\` for any snippet that looks relevant. First sub-query gets 2× weight — put your strongest signal first.

Example:
\`\`\`json
[
  { "type": "lex", "query": "\\"connection pool\\" timeout" },
  { "type": "vec", "query": "why do database connections time out under load" }
]
\`\`\``,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        searches: z.array(subSearchSchema).min(1).max(10).describe(
          "Typed sub-queries to execute (lex/vec/hyde). First gets 2x weight."
        ),
        limit: z.number().max(200).optional().default(3).describe("Max results (default: 3 for tight triage, max: 200). Use `get` to expand a snippet rather than raising this."),
        minScore: z.number().optional().default(0).describe("Min relevance 0-1 (default: 0)"),
        candidateLimit: z.number().optional().describe(
          "Maximum candidates to rerank (default: 40, lower = faster but may miss results)"
        ),
        maxRerankCandidates: z.number().optional().describe(
          "Hard cap for rerank candidates after profile policy."
        ),
        rerankTimeoutMs: z.number().optional().describe(
          "Timeout budget in milliseconds for reranking before fallback."
        ),
        rerankQueueLimit: z.number().optional().describe(
          "Maximum queued rerank jobs before saturation fallback."
        ),
        rerankConcurrency: z.number().optional().describe(
          "Rerank worker concurrency (default 1)."
        ),
        rerankDropPolicy: z.enum(["timeout_fallback", "wait"]).optional().describe(
          "Queue backpressure behavior."
        ),
        vectorFanoutWorkers: z.number().optional().describe(
          "Parallel worker cap for vector fanout."
        ),
        routingProfile: z.enum(["fast", "balanced", "max_precision"]).optional().default("balanced").describe(
          "Retrieval routing profile: fast (lower latency), balanced (default), max_precision (higher recall/precision)."
        ),
        collections: z.array(z.string()).optional().describe("Filter to collections (OR match)"),
        maxSnippetLines: z.number().optional().default(4).describe(
          "Maximum lines per result snippet (default: 4). Reduces token usage; use `get` to read the full body of a promising result."
        ),
        indexes: z.array(z.string()).optional().describe(
          "Named indexes to query (cross-index federation). Omit to use current index."
        ),
      },
    },
    async ({ searches, limit, minScore, candidateLimit, maxRerankCandidates, rerankTimeoutMs, rerankQueueLimit, rerankConcurrency, rerankDropPolicy, vectorFanoutWorkers, routingProfile, collections, maxSnippetLines, indexes }: any) => {
      try {
      const totalStart = Date.now();
      const timings = newTimings();
      const timeoutMs = parseQueryTimeoutMs();
      const profile = normalizeRoutingProfile(routingProfile);
      const profilePolicy = resolveProfilePolicy(profile, candidateLimit);
      const scopeContext = getScopeContext?.();
      const scopeKey = scopeContext?.sessionScope || scopeContext?.workspaceScope || scopeContext?.workspaceUri || "mcp-default";
      // Map to internal format
      const subSearches: StructuredSubSearch[] = searches.map((s: any) => ({
        type: s.type,
        query: s.query,
      }));

      // Log query to session for context enrichment
      const session = getSession?.();
      if (session) {
        const primaryQ = searches.find((s: any) => s.type === 'lex')?.query
          || searches.find((s: any) => s.type === 'vec')?.query
          || searches[0]?.query || "";
        if (primaryQ) session.logQuery(primaryQ);
      }

      // Use default collections if none specified
      const effectiveCollections = collections ?? getDefaultCollectionNames();
      logger.info(JSON.stringify({
        event: "kindx.query.start",
        routing_profile: profile,
        scope: scopeKey,
        searches: subSearches.length,
        collections: effectiveCollections.length,
        encryption_mode: store.getStatus().encryption.encrypted ? "encrypted" : "plaintext",
      }));

      let results;
      if (indexes && indexes.length > 0) {
        const identity = requestIdentityScope.getStore();
        const primaryQ = subSearches.find((s: any) => s.type === 'lex')?.query
          || subSearches.find((s: any) => s.type === 'vec')?.query
          || subSearches[0]?.query || "";
        const { federatedQuery } = await import("./repository.js");
        const { enforce } = await import("./rbac.js");
        // RBAC filter: only query indexes the identity has access to
        const authorizedIndexes = indexes.filter((idx: string) => {
          if (!identity) return true;
          try { enforce(identity, "query", idx); return true; }
          catch { return false; }
        });
        const fedResults = federatedQuery(authorizedIndexes, primaryQ, { limit });

        results = {
          results: fedResults.matches.map(m => ({
            docid: m.docid,
            displayPath: m.file,
            title: m.title || "",
            score: m.score,
            context: m.context || "",
            bestChunk: m.snippet || "",
            _index: m._index,
          })),
          diagnostics: {
            degradedMode: fedResults.indexes_skipped.length > 0,
            fallbackReasons: fedResults.indexes_skipped.length > 0
              ? [`skipped indexes: ${fedResults.indexes_skipped.join(", ")}`]
              : [],
          },
        };
      } else {
        results = await withLLMScope(
          scopeKey,
          () => raceWithTimeout(
            (signal) => structuredSearchWithDiagnostics(store, subSearches, {
              collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
              limit,
              minScore,
              candidateLimit: profilePolicy.candidateLimit,
              maxRerankCandidates,
              rerankTimeoutMs,
              rerankQueueLimit,
              rerankConcurrency,
              rerankDropPolicy,
              vectorFanoutWorkers,
              rerankLimit: profilePolicy.rerankLimit,
              disableRerank: profile === "fast",
              routingProfile: profile,
              signal,
              hooks: {
                onExpand: (_original, _expanded, elapsedMs) => {
                  timings.expand_ms += elapsedMs;
                  pushSpan(timings, "expand", Date.now() - elapsedMs);
                },
                onEmbedDone: (elapsedMs) => {
                  timings.embed_ms += elapsedMs;
                  pushSpan(timings, "embed", Date.now() - elapsedMs);
                },
                onRetrievalDone: (elapsedMs) => {
                  timings.retrieval_ms = elapsedMs;
                  pushSpan(timings, "retrieve", Date.now() - elapsedMs);
                },
                onRerankInitDone: (elapsedMs) => {
                  timings.rerank_init_ms += elapsedMs;
                  pushSpan(timings, "rerank_init", Date.now() - elapsedMs);
                },
                onRerankDone: (elapsedMs) => {
                  timings.rerank_ms += elapsedMs;
                  pushSpan(timings, "rerank", Date.now() - elapsedMs);
                },
              },
            }),
            resolveTimeoutByProfile(timeoutMs, profile),
            "query_timeout"
          )
        );
      }
      timings.total_ms = Date.now() - totalStart;
      pushSpan(timings, "total", totalStart);

      // Use first lex or vec query for snippet extraction
      const primaryQuery = searches.find((s: any) => s.type === 'lex')?.query
        || searches.find((s: any) => s.type === 'vec')?.query
        || searches[0]?.query || "";

      const filtered = results.results.map(r => {
        const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300);
        let finalSnippet = snippet;
        // Context compression: truncate snippets when maxSnippetLines is set
        if (maxSnippetLines && Number.isFinite(maxSnippetLines) && maxSnippetLines > 0) {
          const lines = finalSnippet.split('\n');
          if (lines.length > maxSnippetLines) {
            finalSnippet = lines.slice(0, maxSnippetLines).join('\n') + `\n[... ${lines.length - maxSnippetLines} more lines]`;
          }
        }
        return {
          _index: (r as any)._index || undefined,
          docid: `#${r.docid}`,
          file: r.displayPath,
          title: r.title,
          score: Math.round(r.score * 100) / 100,
          context: r.context,
          snippet: addLineNumbers(finalSnippet, line),
          _rawSnippet: finalSnippet,
        };
      });

      // Content-level snippet dedup: remove results with near-identical snippets.
      // Inspired by LlamaIndex node dedup and Haystack dedup filter.
      // Keeps the higher-scored result when two snippets share >80% token overlap.
      const deduped = snippetDedup(filtered, 0.8);
      // Strip internal _rawSnippet field before returning
      const cleanResults: SearchResultItem[] = deduped.map(({ _rawSnippet: _, ...rest }) => rest);

      const metadata: QueryMetadata = {
        timings,
        degraded_mode: results.diagnostics.degradedMode,
        fallback_reason: results.diagnostics.fallbackReasons[0] ?? null,
        fallback_reasons: results.diagnostics.fallbackReasons,
        routing_profile: profile,
        scope: scopeKey,
        dedupe_joined: false,
        dedupe_join_hits: false,
        replay_artifact: null,
        replay_artifact_path: null,
        diagnostics: results.diagnostics as any,
      };
      metadata.replay_artifact = await writeReplayArtifact({
        requestId: stableHash({
          scope: scopeKey,
          profile,
          searches: subSearches,
          collections: effectiveCollections,
        }).slice(0, 12),
        scope: scopeKey,
        routingProfile: profile,
        searches: subSearches,
        collections: effectiveCollections,
        options: { limit, minScore, candidateLimit: profilePolicy.candidateLimit },
        metadata,
        results: cleanResults,
      });
      metadata.replay_artifact_path = metadata.replay_artifact;
      const annRoute = inferAnnRoute(metadata);
      incCounter("kindx_query_requests_total", 1, {
        profile,
        degraded: String(metadata.degraded_mode === true),
        route: annRoute,
      });
      for (const reason of metadata.fallback_reasons) {
        incCounter("kindx_query_degraded_total", 1, { reason });
      }
      incCounter("kindx_query_route_total", 1, { route: annRoute });
      observeHistogram(
        "kindx_query_total_ms",
        metadata.timings.total_ms,
        [100, 250, 500, 1000, 2500, 5000, 10000, 30000],
        { profile, degraded: String(metadata.degraded_mode === true), route: annRoute }
      );
      logger.info(JSON.stringify({
        event: "kindx.query.end",
        routing_profile: profile,
        degraded_mode: metadata.degraded_mode,
        fallback_reasons: metadata.fallback_reasons,
        ann_route: annRoute,
        encryption_mode: store.getStatus().encryption.encrypted ? "encrypted" : "plaintext",
        total_ms: metadata.timings.total_ms,
      }));

      // Audit logging (fire-and-forget, never fails the query)
      recordAudit(store.db, {
        action: "query",
        scope: scopeKey,
        detail: `results=${cleanResults.length} profile=${profile} degraded=${metadata.degraded_mode}`,
        durationMs: metadata.timings.total_ms,
        success: true,
      });

      return {
        content: [{ type: "text", text: formatSearchSummary(cleanResults, primaryQuery) }],
        structuredContent: { results: cleanResults, metadata, timings },
      };
      } catch (error) {
        return {
          content: [{ type: "text", text: `query_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get (Retrieve document)
  // ---------------------------------------------------------------------------

  maybeRegisterTool(
    "get",
    {
      title: "Get Document",
      description: `Call after \`query\` to read the full body of a result that looked promising in a snippet. Also call when the user mentions a specific file path or docid.

Use paths or docids (#abc123) from search results. Supports line offset via "file.md:100" or the \`fromLine\` param. Suggests similar files if not found.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results (e.g., 'pages/meeting.md', '#abc123', or 'pages/meeting.md:100' to start at line 100)"),
        fromLine: z.number().optional().describe("Start from this line number (1-indexed)"),
        maxLines: z.number().optional().describe("Maximum number of lines to return"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
        indexes: z.array(z.string()).optional().describe(
          "Named indexes to search for the document. Omit to use current index."
        ),
      },
    },
    async ({ file, fromLine, maxLines, lineNumbers, indexes }: any) => {
      try {
      // Support :line suffix in `file` (e.g. "foo.md:120") when fromLine isn't provided
      let parsedFromLine = fromLine;
      let lookup = file;
      const colonMatch = lookup.match(/:(\d+)$/);
      if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
        parsedFromLine = parseInt(colonMatch[1], 10);
        lookup = lookup.slice(0, -colonMatch[0].length);
      }

      let result = store.findDocument(lookup, { includeBody: false });

      if (!("error" in result)) {
        const { filterAllowedCollections } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        if (identity && identity.allowedCollections !== "*") {
          const allowed = filterAllowedCollections(identity, [result.collectionName]);
          if (allowed.length === 0) {
            return {
              content: [{ type: "text", text: `RBAC denied: access to collection '${result.collectionName}' forbidden.` }],
              isError: true,
            };
          }
        }
      }

      // If not found in current index, try named indexes
      if ("error" in result && indexes && indexes.length > 0) {
        const { createStoreForIndex } = await import("./repository.js");
        const { enforce } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        for (const idxName of indexes) {
          try {
            if (identity) enforce(identity, "get", idxName);
            const idxStore = createStoreForIndex(idxName);
            try {
              const idxDoc = idxStore.findDocument(lookup, { includeBody: true });
              if (idxDoc && !("error" in idxDoc)) {
                result = idxDoc as any;
                break;
              }
            } finally { idxStore.close(); }
          } catch { continue; }
        }
      }

      if ("error" in result) {
        let msg = `Document not found: ${file}`;
        if (result.similarFiles.length > 0) {
          msg += `\n\nDid you mean one of these?\n${result.similarFiles.map(s => `  - ${s}`).join('\n')}`;
        }
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }

      let text = store.getDocumentBody(result, parsedFromLine, maxLines) ?? "";
            
      const { filterAllowedCollections } = await import("./rbac.js");
      const identity = requestIdentityScope.getStore();
      if (identity && identity.allowedCollections !== "*") {
        const allowed = filterAllowedCollections(identity, [result.collectionName]);
        if (allowed.length === 0) {
           return {
              content: [{ type: "text", text: `RBAC denied: access to collection '${result.collectionName}' forbidden.` }],
              isError: true,
           };
        }
      }

      if (lineNumbers) {
        const startLine = parsedFromLine || 1;
        text = addLineNumbers(text, startLine);
      }
      if (result.context) {
        text = `<!-- Context: ${result.context} -->\n\n` + text;
      }

      return {
        content: [{
          type: "resource",
          resource: {
            uri: `kindx://${encodeQmdPath(result.displayPath)}`,
            name: result.displayPath,
            title: result.title,
            mimeType: "text/markdown",
            text,
          },
        }],
      };
      } catch (error) {
        return {
          content: [{ type: "text", text: `get_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: multi_get (Retrieve multiple documents)
  // ---------------------------------------------------------------------------

  maybeRegisterTool(
    "multi_get",
    {
      title: "Multi-Get Documents",
      description: `Call when you need multiple related docs at once — e.g., a glob like 'journals/2025-05*.md' or a comma-separated list of paths returned by a prior \`query\`. Skips files larger than maxBytes (default 10 KB).`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated list of file paths"),
        maxLines: z.number().optional().describe("Maximum lines per file"),
        maxBytes: z.number().optional().default(10240).describe("Skip files larger than this (default: 10240 = 10KB)"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
        indexes: z.array(z.string()).optional().describe(
          "Named indexes to search for documents. Omit to use current index."
        ),
      },
    },
    async ({ pattern, maxLines, maxBytes, lineNumbers, indexes }: any) => {
      try {
      const { docs, errors } = store.findDocuments(pattern, { includeBody: true, maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES });

      // Cross-index federation: also search named indexes
      if (indexes && indexes.length > 0) {
        const seenFiles = new Set(docs.map((d: any) => d.doc?.displayPath));
        const { createStoreForIndex } = await import("./repository.js");
        const { enforce } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        for (const idxName of indexes) {
          try {
            if (identity) enforce(identity, "multi_get", idxName);
            const idxStore = createStoreForIndex(idxName);
            try {
              const idxResult = idxStore.findDocuments(pattern, { includeBody: true, maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES });
              for (const d of idxResult.docs) {
                const path = d.doc?.displayPath;
                if (path && !seenFiles.has(path)) {
                  seenFiles.add(path);
                  docs.push(d);
                }
              }
              errors.push(...idxResult.errors);
            } finally { idxStore.close(); }
          } catch { continue; }
        }
      }

      if (docs.length === 0 && errors.length === 0) {
        return {
          content: [{ type: "text", text: `No files matched pattern: ${pattern}` }],
          isError: true,
        };
      }

      const content: ({ type: "text"; text: string } | { type: "resource"; resource: { uri: string; name: string; title?: string; mimeType: string; text: string } })[] = [];

      if (errors.length > 0) {
        content.push({ type: "text", text: `Errors:\n${errors.join('\n')}` });
      }

      for (const result of docs) {
        if (result.skipped) {
          content.push({
            type: "text",
            text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}. Use 'get' with file="${result.doc.displayPath}" to retrieve.]`,
          });
          continue;
        }

        // RBAC check — only for non-skipped results where collectionName is available
        const { filterAllowedCollections } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        if (identity && identity.allowedCollections !== "*") {
          const allowed = filterAllowedCollections(identity, [result.doc.collectionName]);
          if (allowed.length === 0) {
            content.push({ type: "text", text: `[SKIPPED: ${result.doc.displayPath} - RBAC denied access to collection '${result.doc.collectionName}' ]`});
            continue;
          }
        }

        let text = result.doc.body || "";
        if (maxLines !== undefined) {
          const lines = text.split("\n");
          text = lines.slice(0, maxLines).join("\n");
          if (lines.length > maxLines) {
            text += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
          }
        }
        if (lineNumbers) {
          text = addLineNumbers(text);
        }
        if (result.doc.context) {
          text = `<!-- Context: ${result.doc.context} -->\n\n` + text;
        }

        content.push({
          type: "resource",
          resource: {
            uri: `kindx://${encodeQmdPath(result.doc.displayPath)}`,
            name: result.doc.displayPath,
            title: result.doc.title,
            mimeType: "text/markdown",
            text,
          },
        });
      }

      return { content };
      } catch (error) {
        return {
          content: [{ type: "text", text: `multi_get_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: status (Index status)
  // ---------------------------------------------------------------------------

  maybeRegisterTool(
    "status",
    {
      title: "Index Status",
      description: `Call once per session if \`instructions\` did not list collections — surfaces what's actually indexed, vector readiness, and scale metrics. Rarely needed mid-turn.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const status = store.getStatus();
      const ops = buildOperationalStatus(store.db, store.dbPath, status.hasVectorIndex);
      const throughput = getRerankThroughputSnapshot();
      const shardHealth = getShardHealthSummary(store.db, store.dbPath, 16);

      let watchDaemon: "active" | "inactive" = "inactive";
      try {
        const { resolve } = await import("path");
        const { homedir } = await import("os");
        const { readFileSync, existsSync, unlinkSync } = await import("fs");
        const cacheDir = process.env.XDG_CACHE_HOME
          ? resolve(process.env.XDG_CACHE_HOME, "kindx")
          : resolve(homedir(), ".cache", "kindx");
        const watchPidPath = resolve(cacheDir, "watch.pid");
        if (existsSync(watchPidPath)) {
          const watchPid = parseInt(readFileSync(watchPidPath, "utf-8").trim());
          process.kill(watchPid, 0);
          watchDaemon = "active";
        }
      } catch (err) {
        try {
          const { resolve } = await import("path");
          const { homedir } = await import("os");
          const { unlinkSync } = await import("fs");
          const cacheDir = process.env.XDG_CACHE_HOME
            ? resolve(process.env.XDG_CACHE_HOME, "kindx")
            : resolve(homedir(), ".cache", "kindx");
          unlinkSync(resolve(cacheDir, "watch.pid"));
        } catch (e) {}
      }

      const fullStatus: StatusResult = {
        ...status,
        watchDaemon,
        ...ops,
        scale: {
          queueDepth: throughput.depth,
          rerankConcurrency: throughput.concurrency,
          queueActive: throughput.active,
          queueTimedOutTotal: throughput.fairness.timedOut,
          queueSaturatedTotal: throughput.fairness.saturated,
          shardHealth,
        },
      };

      const summary = [
        `KINDX Index Status:`,
        `  Total documents: ${status.totalDocuments}`,
        `  Needs embedding: ${status.needsEmbedding}`,
        `  Vector index: ${status.hasVectorIndex ? 'yes' : 'no'}`,
        `  Vector capability: ${ops.vector_available ? "available" : "unavailable"}`,
        `  Models ready: ${ops.models_ready ? "yes" : "no"}`,
        `  DB integrity: ${ops.db_integrity}`,
        `  Collections: ${status.collections.length}`,
        `  Watch Daemon: ${watchDaemon === "active" ? "active" : "inactive"}`,
        `  Capability flags: ${Object.entries(status.capabilities || {}).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        `  Encryption: ${status.encryption.encrypted ? "encrypted" : "plaintext"} (key=${status.encryption.keyConfigured ? "set" : "unset"})`,
        `  ANN route: ${status.ann.mode} (${status.ann.state})`,
        `  Ingestion warnings: ${status.ingestion?.warnedDocuments ?? 0}`,
      ];
      if (status.shards) {
        summary.push(`  Shards configured: ${status.shards.enabledCollections.length}`);
        summary.push(`  Shard checkpoint: ${status.shards.checkpointExists ? "present" : "missing"}`);
      }
      summary.push(`  Queue depth: ${throughput.depth}`);
      summary.push(`  Rerank concurrency: ${throughput.concurrency}`);
      summary.push(`  Queue timed-out total: ${throughput.fairness.timedOut}`);
      summary.push(`  Queue saturated total: ${throughput.fairness.saturated}`);
      summary.push(`  Shard health: ${shardHealth.status}`);
      summary.push(`  Metrics endpoint: /metrics`);
      if ((status.ingestion?.byWarning?.length ?? 0) > 0) {
        summary.push(`  Ingestion warning taxonomy:`);
        for (const item of status.ingestion.byWarning.slice(0, 10)) {
          summary.push(`    - ${item.warning}: ${item.count}`);
        }
      }

      for (const col of status.collections) {
        summary.push(`    - ${col.path} (${col.documents} docs)`);
      }
      if (ops.warnings.length > 0) {
        summary.push(`  Warnings:`);
        for (const warning of ops.warnings) {
          summary.push(`    - ${warning}`);
        }
      }
      if (status.shards?.warnings?.length) {
        summary.push(`  Scale warnings:`);
        for (const warning of status.shards.warnings) {
          summary.push(`    - ${warning}`);
        }
      }

      return {
        content: [{ type: "text", text: summary.join('\n') }],
        structuredContent: fullStatus,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tools: memory_* (Scoped memory subsystem)
  // ---------------------------------------------------------------------------

  maybeRegisterTool(
    "memory_put",
    {
      title: "Memory Put",
      description: "Call after the user states a preference, decision, or fact you'll need next session. Do not echo memory back; just persist with the smallest appropriate scope (session > workspace > global).",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Memory scope. Resolved as explicit > session > workspace > default."),
        key: z.string().describe("Memory key"),
        value: z.string().describe("Memory value"),
        tags: z.array(z.string()).optional().describe("Optional memory tags"),
        source: z.string().optional().describe("Optional source attribution"),
        confidence: z.number().optional().describe("Optional confidence value"),
        semanticThreshold: z.number().optional().describe("Optional semantic supersession threshold"),
        ttl: z.number().optional().describe("Time-to-live in seconds. Memory expires after this duration. Omit for permanent storage."),
      },
    },
    async ({ scope, key, value, tags, source, confidence, semanticThreshold, ttl }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }

      const memory = await upsertMemory(store.db, {
        scope: resolved.scope,
        key,
        value,
        tags,
        source,
        confidence,
        semanticThreshold,
        ttl,
      });
      recordAudit(store.db, {
        action: "memory_put",
        scope: resolved.scope,
        detail: `key=${key} id=${memory.id}${ttl ? ` ttl=${ttl}s` : ""}`,
        success: true,
      });
      return {
        content: [{ type: "text", text: `stored memory #${memory.id} in scope '${resolved.scope}'` }],
        structuredContent: { scope: resolved.scope, memory },
      };
    }
  );

  maybeRegisterTool(
    "memory_search",
    {
      title: "Memory Search",
      description: `Call at the start of any turn that says "we", "earlier", "you remember", "the project", or that resumes ongoing work. Searches workspace and session memory; returns ranked entries with their scope.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Memory scope. Resolved as explicit > session > workspace > default."),
        query: z.string().describe("Search query"),
        mode: z.enum(["semantic", "text"]).optional().default("semantic").describe("Search mode"),
        limit: z.number().optional().default(20).describe("Max number of results"),
        threshold: z.number().optional().default(0.3).describe("Semantic threshold (semantic mode)"),
      },
    },
    async ({ scope, query, mode, limit, threshold }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }

      const effectiveMode = mode === "text" ? "text" : "semantic";
      const results = effectiveMode === "text"
        ? textSearchMemory(store.db, resolved.scope, query, limit)
        : await semanticSearchMemory(store.db, resolved.scope, query, limit, threshold);
      return {
        content: [{ type: "text", text: `found ${results.length} memory result(s)` }],
        structuredContent: { scope: resolved.scope, mode: effectiveMode, query, results },
      };
    }
  );

  maybeRegisterTool(
    "memory_history",
    {
      title: "Memory History",
      description: "Diagnostic — only call when the user asks about memory itself, not in normal answer flow. Show historical values for a key in one scope.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Memory scope. Resolved as explicit > session > workspace > default."),
        key: z.string().describe("Memory key"),
      },
    },
    async ({ scope, key }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }

      const history = getMemoryHistory(store.db, resolved.scope, key);
      return {
        content: [{ type: "text", text: `found ${history.length} history item(s) for '${key}'` }],
        structuredContent: { scope: resolved.scope, key, history },
      };
    }
  );

  maybeRegisterTool(
    "memory_stats",
    {
      title: "Memory Stats",
      description: "Diagnostic — only call when the user asks about memory itself, not in normal answer flow. Get memory statistics for a scope.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Memory scope. Resolved as explicit > session > workspace > default."),
      },
    },
    async ({ scope }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }

      const stats = getMemoryStats(store.db, resolved.scope);
      return {
        content: [{ type: "text", text: `memory stats for scope '${resolved.scope}'` }],
        structuredContent: stats,
      };
    }
  );

  maybeRegisterTool(
    "memory_mark_accessed",
    {
      title: "Memory Mark Accessed",
      description: "Diagnostic — only call when the user asks about memory itself, not in normal answer flow. Increment accessed counter for a scoped memory id.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Memory scope. Resolved as explicit > session > workspace > default."),
        id: z.number().int().positive().describe("Memory id"),
      },
    },
    async ({ scope, id }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }

      const ok = markMemoryAccessed(store.db, resolved.scope, id);
      if (!ok) {
        return {
          content: [{ type: "text", text: `memory #${id} not found in scope '${resolved.scope}'` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `marked memory #${id} accessed` }],
        structuredContent: { scope: resolved.scope, id, marked: true },
      };
    }
  );

  maybeRegisterTool(
    "memory_delete",
    {
      title: "Memory Delete",
      description: "Diagnostic — only call when the user asks about memory itself, not in normal answer flow. Delete a memory record by its ID. Removes associated tags, embeddings, and links.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Memory scope. Resolved as explicit > session > workspace > default."),
        id: z.number().int().positive().describe("Memory id to delete"),
      },
    },
    async ({ scope, id }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }

      const { deleteMemory } = await import("./memory.js");
      const deleted = deleteMemory(store.db, resolved.scope, id);
      if (!deleted) {
        recordAudit(store.db, {
          action: "memory_delete",
          scope: resolved.scope,
          detail: `id=${id} not_found`,
          success: false,
        });
        return {
          content: [{ type: "text", text: `memory #${id} not found in scope '${resolved.scope}'` }],
          isError: true,
        };
      }
      recordAudit(store.db, {
        action: "memory_delete",
        scope: resolved.scope,
        detail: `id=${id}`,
        success: true,
      });
      return {
        content: [{ type: "text", text: `deleted memory #${id} from scope '${resolved.scope}'` }],
        structuredContent: { scope: resolved.scope, id, deleted: true },
      };
    }
  );

  maybeRegisterTool(
    "memory_bulk",
    {
      title: "Memory Bulk Operations",
      description: "Diagnostic — only call when the user asks about memory itself, not in normal answer flow. Batch execute multiple memory insertions and deletions efficiently. Highly recommended when summarizing blocks or migrating multiple related facts at once.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Fallback memory scope if not specified per item. Resolved as explicit > session > workspace > default."),
        operations: z.array(z.object({
           action: z.enum(["put", "delete"]),
           id: z.number().int().positive().optional().describe("Required for 'delete'. The memory ID to delete."),
           input: z.object({
             key: z.string(),
             value: z.string(),
             tags: z.array(z.string()).optional(),
             source: z.string().optional(),
             confidence: z.number().optional(),
             ttl: z.number().optional(),
             disableSemanticDedup: z.boolean().optional(),
           }).optional().describe("Required for 'put'. The item to upsert.")
        })).describe("List of operations to perform batched. Max 50."),
      },
    },
    async ({ scope, operations }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }
      
      if (!Array.isArray(operations) || operations.length === 0) {
        return {
           content: [{ type: "text", text: "operations array is empty or missing" }],
           isError: true,
        };
      }
      if (operations.length > 50) {
        return {
           content: [{ type: "text", text: "Too many operations in one batch (max 50)" }],
           isError: true,
        };
      }

      const { processBulkMemories } = await import("./memory.js");
      const result = await processBulkMemories(store.db, resolved.scope, operations);
      
      recordAudit(store.db, {
        action: "memory_bulk",
        scope: resolved.scope,
        detail: `success=\${result.successful} failed=\${result.failed}`,
        success: result.failed === 0,
      });

      return {
        content: [{ type: "text", text: `Bulk operation complete. Successful: \${result.successful}, Failed: \${result.failed}.` }],
        structuredContent: result,
        isError: result.failed > 0,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_list
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_list",
    {
      title: "List Indexes",
      description: "List all named indexes. Returns index name, description, creation date, and whether it is the default.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      try {
        const { enforce } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        if (identity) enforce(identity, "index_list");
        const { ensureDefaultIndexRegistered, listIndexes, getDefaultIndexName } = await import("./index-manager.js");
        ensureDefaultIndexRegistered();
        const indexes = listIndexes();
        const defaultName = getDefaultIndexName();

        return {
          content: [{ type: "text", text: `${indexes.length} index(es) found. Default: ${defaultName}` }],
          structuredContent: {
            indexes: indexes.map(i => ({
              name: i.name,
              description: i.description || null,
              created_at: i.created_at,
              is_default: i.name === defaultName,
            })),
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_list_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_create
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_create",
    {
      title: "Create Index",
      description: "Create a new named index with its own SQLite database. Admin only.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        name: z.string().describe("Index name (lowercase, 2-64 chars, alphanumeric + hyphens)"),
        description: z.string().optional().describe("Human-readable description"),
      },
    },
    async ({ name, description }: any) => {
      try {
        const { enforce } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        if (identity) enforce(identity, "index_create");
        const { registerIndex } = await import("./index-manager.js");
        const { getDefaultDbPath } = await import("./repository/paths.js");
        const { openDatabase } = await import("./runtime.js");
        const { initializeDatabase } = await import("./repository/store-init.js");

        const entry = registerIndex(name, description);
        const dbPath = getDefaultDbPath(name);
        const db = openDatabase(dbPath);
        initializeDatabase(db);
        db.close();

        return {
          content: [{ type: "text", text: `Created index '${name}' at ${dbPath}` }],
          structuredContent: { name, db_path: dbPath, created_at: entry.created_at },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_create_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_delete
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_delete",
    {
      title: "Delete Index",
      description: "Permanently delete a named index and all its data. Admin only. Requires force=true to confirm.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      inputSchema: {
        name: z.string().describe("Index name to delete"),
        force: z.boolean().default(false).describe("Must be true to confirm deletion"),
      },
    },
    async ({ name, force }: any) => {
      try {
        const { enforce } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        if (identity) enforce(identity, "index_delete");
        if (!force) {
          return {
            content: [{ type: "text", text: `Deletion of index '${name}' requires force=true to confirm.` }],
            isError: true,
          };
        }

        const { unregisterIndex, getDefaultIndexName } = await import("./index-manager.js");
        const { getDefaultDbPath } = await import("./repository/paths.js");
        const { existsSync, unlinkSync } = await import("node:fs");

        if (name === getDefaultIndexName()) {
          return {
            content: [{ type: "text", text: `Cannot delete the default index '${name}'.` }],
            isError: true,
          };
        }

        unregisterIndex(name);
        const dbPath = getDefaultDbPath(name);
        for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try { if (existsSync(p)) unlinkSync(p); } catch {}
        }

        return {
          content: [{ type: "text", text: `Deleted index '${name}'.` }],
          structuredContent: { deleted: true, name },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_delete_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_migrate
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_migrate",
    {
      title: "Migrate Collection",
      description: "Copy a collection and its data from one index to another. Admin only.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        collection: z.string().describe("Collection name to migrate"),
        from_index: z.string().describe("Source index name"),
        to_index: z.string().describe("Destination index name"),
      },
    },
    async ({ collection, from_index, to_index }: any) => {
      try {
        const { enforce } = await import("./rbac.js");
        const identity = requestIdentityScope.getStore();
        if (identity) enforce(identity, "index_migrate");
        const { getDefaultDbPath } = await import("./repository/paths.js");
        const { openDatabase } = await import("./runtime.js");
        const srcDbPath = getDefaultDbPath(from_index);
        const dstDbPath = getDefaultDbPath(to_index);

        const srcDb = openDatabase(srcDbPath);
        const dstDb = openDatabase(dstDbPath);

        const count = (srcDb.prepare(
          `SELECT COUNT(*) as c FROM content WHERE collection = ?`
        ).get(collection) as any)?.c || 0;

        if (count === 0) {
          srcDb.close();
          dstDb.close();
          return {
            content: [{ type: "text", text: `Collection '${collection}' is empty in source index '${from_index}'.` }],
          };
        }

        dstDb.prepare(`ATTACH DATABASE ? AS src`).run(srcDbPath);
        dstDb.prepare(`INSERT OR IGNORE INTO main.content SELECT * FROM src.content WHERE collection = ?`).run(collection);
        dstDb.prepare(`INSERT OR IGNORE INTO main.documents SELECT * FROM src.documents WHERE collection = ?`).run(collection);
        dstDb.prepare(
          `INSERT OR IGNORE INTO main.content_vectors SELECT cv.* FROM src.content_vectors cv WHERE EXISTS (SELECT 1 FROM src.content c WHERE c.hash = cv.hash AND c.collection = ?)`
        ).run(collection);
        dstDb.prepare(
          `INSERT OR IGNORE INTO main.document_links SELECT dl.* FROM src.document_links dl WHERE EXISTS (SELECT 1 FROM src.content c WHERE c.hash = dl.hash AND c.collection = ?)`
        ).run(collection);
        dstDb.prepare(
          `INSERT OR IGNORE INTO main.document_ingest SELECT di.* FROM src.document_ingest di WHERE EXISTS (SELECT 1 FROM src.documents d WHERE d.docid = di.docid AND d.collection = ?)`
        ).run(collection);
        dstDb.prepare(`DETACH DATABASE src`).run();

        srcDb.close();
        dstDb.close();

        return {
          content: [{ type: "text", text: `Migrated ${count} documents from '${from_index}' to '${to_index}' collection '${collection}'.` }],
          structuredContent: { collection, from_index, to_index, documents_migrated: count },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_migrate_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: memory_feedback
  // ---------------------------------------------------------------------------
    maybeRegisterTool(
    "memory_feedback",
    {
      title: "Memory Feedback",
      description: "Diagnostic — only call when the user asks about memory itself, not in normal answer flow. Record satisfaction feedback on memory search results.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        scope: z.string().optional().describe("Memory scope. Resolved as explicit > session > workspace > default."),
        query: z.string().describe("The search query that produced these results"),
        results: z.array(z.object({
          id: z.number().int().positive().describe("Memory ID that received feedback"),
          satisfaction: z.enum(["positive", "negative", "neutral"]).describe("Satisfaction signal"),
        })).describe("Feedback entries per result"),
        source: z.string().optional().describe("Optional attribution source"),
      },
    },
    async ({ scope, query, results, source }: any) => {
      const resolved = resolveToolScope({ scope });
      if (!resolved.scope) {
        return {
          content: [{ type: "text", text: resolved.errorText || "scope_resolution_failed" }],
          isError: true,
        };
      }

      if (!Array.isArray(results) || results.length === 0) {
        return {
          content: [{ type: "text", text: "results array is empty or missing" }],
          isError: true,
        };
      }

      // Validate result IDs exist in scope
      const validIds = new Set(
        (store.db.prepare(`SELECT id FROM memories WHERE scope = ?`).all(resolved.scope) as any[])
          .map(r => r.id)
      );
      const invalidIds = results.map((r: any) => r.id).filter((id: number) => !validIds.has(id));
      if (invalidIds.length > 0) {
        return {
          content: [{ type: "text", text: `Invalid result IDs: ${invalidIds.join(", ")}` }],
          isError: true,
        };
      }

      const recorded = recordFeedback(store.db, resolved.scope, query, results, source);
      recordAudit(store.db, {
        action: "memory_feedback",
        scope: resolved.scope,
        detail: `query_hash=${createHash("sha256").update(query.trim().toLowerCase()).digest("hex").slice(0, 16)} recorded=${recorded}`,
        success: true,
      });
      return {
        content: [{ type: "text", text: `recorded ${recorded} feedback entries in scope '${resolved.scope}'` }],
        structuredContent: { scope: resolved.scope, recorded },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: document_history
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "document_history",
    {
      title: "Document History",
      description: "Show version history of a document with timestamps and hashes.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path, docid, or virtual path (kindx://collection/path)"),
        limit: z.number().int().positive().optional().describe("Max versions to return"),
      },
    },
    async ({ file, limit }: any) => {
      try {
        const found = store.findDocument(file, { includeBody: false });
        if ("error" in found) {
          return {
            content: [{ type: "text", text: `Document not found: ${file}` }],
            isError: true,
          };
        }
        const versions = getDocumentVersions(store.db, found.collectionName, found.filepath);
        const limited = limit ? versions.slice(0, limit) : versions;
        return {
          content: [{ type: "text", text: JSON.stringify(limited, null, 2) }],
          structuredContent: { versions: limited, total: versions.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `document_history_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: document_diff
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "document_diff",
    {
      title: "Document Diff",
      description: "Show what changed between two versions of a document.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path, docid, or virtual path"),
        from: z.number().int().positive().optional().describe("From version number (1-based, default: 2 = previous)"),
        to: z.number().int().positive().optional().describe("To version number (1-based, default: 1 = current)"),
      },
    },
    async ({ file, from, to }: any) => {
      try {
        const found = store.findDocument(file, { includeBody: false });
        if ("error" in found) {
          return {
            content: [{ type: "text", text: `Document not found: ${file}` }],
            isError: true,
          };
        }
        const versions = getDocumentVersions(store.db, found.collectionName, found.filepath);
        if (versions.length < 2) {
          return {
            content: [{ type: "text", text: "Document has fewer than 2 versions, cannot diff." }],
            isError: true,
          };
        }
        const fromIdx = (from ? from - 1 : 1);
        const toIdx = (to ? to - 1 : 0);
        if (fromIdx < 0 || fromIdx >= versions.length || toIdx < 0 || toIdx >= versions.length) {
          return {
            content: [{ type: "text", text: `Invalid version numbers. Document has ${versions.length} versions (1-based).` }],
            isError: true,
          };
        }
        const fromVer = versions[fromIdx];
        const toVer = versions[toIdx];
        const fromBody = store.db.prepare(`SELECT content FROM content WHERE hash = ?`).get(fromVer.hash) as any;
        const toBody = store.db.prepare(`SELECT content FROM content WHERE hash = ?`).get(toVer.hash) as any;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              from: { version: fromIdx + 1, hash: fromVer.hash, createdAt: fromVer.createdAt },
              to: { version: toIdx + 1, hash: toVer.hash, createdAt: toVer.createdAt },
              fromContent: fromBody?.content || null,
              toContent: toBody?.content || null,
            }, null, 2)
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `document_diff_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: audit_log
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "audit_log",
    {
      title: "Audit Log",
      description: "Query the audit log for security and operations events.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        action: z.string().optional().describe("Filter by action type (e.g. query, auth_failure, tool_denied)"),
        since: z.string().optional().describe("ISO timestamp start (e.g. 2026-01-01T00:00:00Z)"),
        until: z.string().optional().describe("ISO timestamp end"),
        limit: z.number().int().positive().optional().describe("Max entries (default 100, max 1000)"),
      },
    },
    async ({ action, since, until, limit }: any) => {
      try {
        const entries = queryAuditLog(store.db, {
          action,
          since,
          until,
          limit: limit || 100,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
          structuredContent: { entries, count: entries.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `audit_log_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// =============================================================================
// Resilient Store Wrapper
// =============================================================================

export function createResilientStore(dbPath?: string): Store {
  let innerStore = createStore(dbPath);

  function checkError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("disk image is malformed") || msg.includes("SQLITE_CORRUPT") || msg.includes("readonly database")) {
      logger.warn(`KINDX Recovery: Database connection stale (${msg}), recycling connection...`);
      try { innerStore.close(); } catch {}
      innerStore = createStore(dbPath);
      return true;
    }
    return false;
  }

  const dbProxy = new Proxy({} as any, {
    get(target, prop) {
      if (prop === "transaction") {
         return function(fn: any) {
           return function(...tArgs: any[]) {
              try {
                return (innerStore.db.transaction(fn) as any)(...tArgs);
              } catch (e) {
                 if (checkError(e)) {
                    return (innerStore.db.transaction(fn) as any)(...tArgs);
                 }
                 throw e;
              }
           }
         }
      }

      const dbVal = (innerStore.db as any)[prop];
      if (typeof dbVal === "function") {
        return function(...args: any[]) {
          try {
            const res = dbVal.apply(innerStore.db, args);
            if (prop === "prepare") {
               return new Proxy(res, {
                 get(sTarget, sProp) {
                   const sVal = res[sProp];
                   if (typeof sVal === "function") {
                     return function(...sArgs: any[]) {
                        try {
                          return sVal.apply(res, sArgs);
                        } catch (e) {
                          if (checkError(e)) {
                             const newStmt = innerStore.db.prepare(args[0]);
                             return (newStmt as any)[sProp].apply(newStmt, sArgs);
                          }
                          throw e;
                        }
                     }
                   }
                   return sVal;
                 }
               });
            }
            return res;
          } catch (e) {
             if (checkError(e)) {
               return (innerStore.db as any)[prop].apply(innerStore.db, args);
             }
             throw e;
          }
        };
      }
      return dbVal;
    }
  });

  return new Proxy({} as Store, {
    get(target, prop) {
      if (prop === "db") return dbProxy;
      const val = (innerStore as any)[prop];
      if (typeof val === "function") {
        return function(...args: any[]) {
          try {
            return val.apply(innerStore, args);
          } catch (e) {
            if (checkError(e)) {
               return (innerStore as any)[prop].apply(innerStore, args);
            }
            throw e;
          }
        }
      }
      return val;
    }
  });
}

// =============================================================================
// Transport: stdio (default)
// =============================================================================

export async function startMcpServer(dbPath?: string): Promise<void> {
  const store = createResilientStore(dbPath);
  const loadedControl = loadMcpControlPlaneConfig();
  const mcpControl = resolveMcpServerControl(KINDX_MCP_SERVER_ID, loadedControl);
  if (mcpControl.project_scoped && !mcpControl.trusted_project) {
    throw Object.assign(new Error("project_scoped MCP config requires trusted project"), {
      code: "PROJECT_NOT_TRUSTED",
    });
  }

  // Create a single scoped session for the lifetime of the stdio connection.
  // Stdio transport is one-client-per-process, so sessionId = process PID.
  const session = SessionRegistry.create(`stdio-${process.pid}`, {});

  const server = createMcpServer(store, undefined, () => session, { mcpControl });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Abort session on process signals (cooperative cancellation for in-flight ops)
  const cleanup = () => {
    session.dispose();
    SessionRegistry.disposeAll().catch(() => {});
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
}

// =============================================================================
// Transport: Streamable HTTP
// =============================================================================

export type HttpServerHandle = {
  httpServer: import("http").Server;
  port: number;
  host: string;
  url: string;
  stop: () => Promise<void>;
  controlPlane: {
    rateLimiter: InstanceType<typeof FixedWindowRateLimiter>;
    initRateLimiter: InstanceType<typeof FixedWindowRateLimiter>;
    quotaManager: InstanceType<typeof ToolQuotaManager>;
    circuitBreaker: InstanceType<typeof CircuitBreaker>;
  };
};

function isHostBindRetryableError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "EADDRNOTAVAIL" || code === "ENOTFOUND" || code === "EACCES" || code === "EPERM";
}

async function listenOnHost(
  httpServer: import("http").Server,
  port: number,
  host: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      httpServer.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });
}

export async function bindHttpServerWithFallback(
  httpServer: import("http").Server,
  port: number
): Promise<string> {
  try {
    await listenOnHost(httpServer, port, "localhost");
    return "localhost";
  } catch (error) {
    if (!isHostBindRetryableError(error)) {
      throw error;
    }
    await listenOnHost(httpServer, port, "127.0.0.1");
    return "127.0.0.1";
  }
}



/**
 * Start MCP server over Streamable HTTP (JSON responses, no SSE).
 * Binds to localhost first, then falls back to 127.0.0.1 if needed.
 * Returns a handle for shutdown and port discovery.
 */
export async function startMcpHttpServer(port: number, options?: { quiet?: boolean; dbPath?: string }): Promise<HttpServerHandle> {
  const quiet = options?.quiet ?? false;
  const store = createResilientStore(options?.dbPath);
  const loadedControl = loadMcpControlPlaneConfig();
  const mcpControl = resolveMcpServerControl(KINDX_MCP_SERVER_ID, loadedControl);
  const controlHeaders = buildResolvedHttpHeaders(mcpControl);
  const toolProvenance = buildToolProvenanceRegistry(KINDX_MCP_SERVER_ID, [...KINDX_MCP_TOOL_NAMES]);
  const toolListCache = new McpToolListCache();
  const requestScopeContext = new AsyncLocalStorage<MemoryScopeContext | undefined>();

  function parseEnvInt(value: string | undefined, fallback: number): number {
    const raw = parseInt(value ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
    maxRequests: parseEnvInt(process.env.KINDX_RATE_LIMIT_MAX, 100),
    windowMs: parseEnvInt(process.env.KINDX_RATE_LIMIT_WINDOW_MS, 60000),
  };

  const DEFAULT_QUOTA_CONFIG: ToolQuotaConfig = {
    defaultQuota: parseEnvInt(process.env.KINDX_TOOL_QUOTA_DEFAULT, 1000),
    resetIntervalMs: parseEnvInt(process.env.KINDX_QUOTA_RESET_MS, 3600000),
  };

  const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
    failureThreshold: parseEnvInt(process.env.KINDX_CIRCUIT_BREAKER_THRESHOLD, 5),
    resetTimeoutMs: parseEnvInt(process.env.KINDX_CIRCUIT_BREAKER_RESET_MS, 30000),
  };

  const rateLimiter = new FixedWindowRateLimiter(DEFAULT_RATE_LIMITER_CONFIG);
  const quotaManager = new ToolQuotaManager(DEFAULT_QUOTA_CONFIG);
  const circuitBreaker = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  // IP-based rate limiter for initialize requests to prevent session creation spam
  const initRateLimiter = new FixedWindowRateLimiter({
    maxRequests: parseEnvInt(process.env.KINDX_INIT_RATE_LIMIT_MAX, 100),
    windowMs: parseEnvInt(process.env.KINDX_INIT_RATE_LIMIT_WINDOW_MS, 60000),
  });
  const queryTimeoutMs = parseQueryTimeoutMs();
  const dedupeMode = getDedupeMode();
  const inFlightBySession = new Map<string, Map<string, Promise<{ results: SearchResultItem[]; metadata: QueryMetadata }>>>();
  const inFlightMcpBySession = new Map<string, Map<string, Promise<{ status: number; headers: Record<string, string>; body: string }>>>();

  const normalizeAuthToken = (raw: string | null | undefined): string | null => {
    if (typeof raw !== "string") return null;
    const token = raw.replace(/^Bearer\s+/i, "").trim();
    return token.length > 0 ? token : null;
  };

  // Read token once at startup and fail closed on bootstrap errors.
  const configDir = resolve(homedir(), ".config", "kindx");
  const tokenFile = resolve(configDir, "mcp_token");
  let mcpToken = normalizeAuthToken(controlHeaders.Authorization)
    ?? normalizeAuthToken(process.env.KINDX_MCP_TOKEN);

  if (!mcpToken && existsSync(tokenFile)) {
    try {
      mcpToken = normalizeAuthToken(readFileSync(tokenFile, "utf-8"));
    } catch (err) {
      throw new Error(
        `Failed to read MCP auth token from ${tokenFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Enforce auth: Auto-generate and persist a token if none is configured.
  // Empty/whitespace token files are treated as missing and regenerated.
  if (!mcpToken) {
    try {
      mcpToken = randomBytes(32).toString("hex");
      // Tier-0-10: atomicWriteFile gives us tmp-write -> fsync -> rename ->
      // dir-fsync, AND opens the temp with mode 0o600 from the start so
      // there is no TOCTOU window where the bearer token sits at 0o644
      // between writeFileSync and chmodSync. Concurrent server starts also
      // race-cleanly via the random temp suffix.
      atomicWriteFile(tokenFile, mcpToken, { mode: 0o600 });
      if (!quiet) {
        logger.info(`KINDX: Generated new MCP authorization token at ${tokenFile}`);
      }
    } catch (err) {
      throw new Error(
        `Failed to initialize MCP auth token at ${tokenFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Session map: each client gets its own McpServer + Transport pair (MCP spec requirement).
  // The store is shared — it's stateless SQLite, safe for concurrent access.
  // kindxSession is stored alongside the transport for per-session embedding cache access.
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; context: MemoryScopeContext; kindxSession: KindxSession | null }>();

  function getSessionInflight(sessionKey: string): Map<string, Promise<{ results: SearchResultItem[]; metadata: QueryMetadata }>> {
    let map = inFlightBySession.get(sessionKey);
    if (!map) {
      map = new Map();
      inFlightBySession.set(sessionKey, map);
    }
    return map;
  }

  function getMcpSessionInflight(sessionKey: string): Map<string, Promise<{ status: number; headers: Record<string, string>; body: string }>> {
    let map = inFlightMcpBySession.get(sessionKey);
    if (!map) {
      map = new Map();
      inFlightMcpBySession.set(sessionKey, map);
    }
    return map;
  }

  function patchJsonRpcId(body: string, id: unknown): string {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && "id" in parsed) {
        parsed.id = id ?? null;
        return JSON.stringify(parsed);
      }
      return body;
    } catch {
      return body;
    }
  }

  async function runStructuredSearchWithTelemetry(
    subSearches: StructuredSubSearch[],
    effectiveCollections: string[] | undefined,
    scopeKey: string | undefined,
    options: {
      limit?: number;
      minScore?: number;
      candidateLimit?: number;
      maxRerankCandidates?: number;
      rerankTimeoutMs?: number;
      rerankQueueLimit?: number;
      rerankConcurrency?: number;
      rerankDropPolicy?: "timeout_fallback" | "wait";
      vectorFanoutWorkers?: number;
      routingProfile: SearchRoutingProfile;
    },
  ): Promise<{ results: SearchResultItem[]; metadata: QueryMetadata }> {
    const timings = newTimings();
    const started = Date.now();
    const profilePolicy = resolveProfilePolicy(options.routingProfile, options.candidateLimit);
    const effectiveTimeout = resolveTimeoutByProfile(queryTimeoutMs, options.routingProfile);

    const rawResults = await withLLMScope(
      scopeKey,
      () => raceWithTimeout(
        (signal) => structuredSearchWithDiagnostics(store, subSearches, {
          collections: effectiveCollections && effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit: options.limit,
          minScore: options.minScore,
          candidateLimit: profilePolicy.candidateLimit,
          maxRerankCandidates: options.maxRerankCandidates,
          rerankTimeoutMs: options.rerankTimeoutMs,
          rerankQueueLimit: options.rerankQueueLimit,
          rerankConcurrency: options.rerankConcurrency,
          rerankDropPolicy: options.rerankDropPolicy,
          vectorFanoutWorkers: options.vectorFanoutWorkers,
          rerankLimit: profilePolicy.rerankLimit,
          disableRerank: options.routingProfile === "fast",
          routingProfile: options.routingProfile,
          signal,
          hooks: {
            onExpand: (_original, _expanded, elapsedMs) => { timings.expand_ms += elapsedMs; },
            onEmbedDone: (elapsedMs) => { timings.embed_ms += elapsedMs; },
            onRetrievalDone: (elapsedMs) => { timings.retrieval_ms = elapsedMs; },
            onRerankInitDone: (elapsedMs) => { timings.rerank_init_ms += elapsedMs; },
            onRerankDone: (elapsedMs) => { timings.rerank_ms += elapsedMs; },
          },
        }),
        effectiveTimeout,
        "query_timeout"
      )
    );

    const primaryQuery = subSearches.find((s) => s.type === "lex")?.query
      || subSearches.find((s) => s.type === "vec")?.query
      || subSearches[0]?.query
      || "";

    const formatted: SearchResultItem[] = rawResults.results.map(r => {
      const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300);
      return {
        docid: `#${r.docid}`,
        file: r.displayPath,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        context: r.context,
        snippet: addLineNumbers(snippet, line),
      };
    });
    timings.total_ms = Date.now() - started;
    const metadata: QueryMetadata = {
      timings,
      degraded_mode: rawResults.diagnostics.degradedMode,
      fallback_reason: rawResults.diagnostics.fallbackReasons[0] ?? null,
      fallback_reasons: rawResults.diagnostics.fallbackReasons,
      routing_profile: options.routingProfile,
      scope: scopeKey || "mcp-default",
      dedupe_joined: false,
      dedupe_join_hits: false,
      replay_artifact: null,
      replay_artifact_path: null,
      diagnostics: rawResults.diagnostics,
    };
    metadata.replay_artifact = await writeReplayArtifact({
      requestId: stableHash({
        scope: metadata.scope,
        profile: options.routingProfile,
        searches: subSearches,
        collections: effectiveCollections,
      }).slice(0, 12),
      scope: metadata.scope,
      routingProfile: options.routingProfile,
      searches: subSearches,
      collections: effectiveCollections,
      options: {
        limit: options.limit,
        minScore: options.minScore,
        candidateLimit: profilePolicy.candidateLimit,
      },
      metadata,
      results: formatted,
    });
    metadata.replay_artifact_path = metadata.replay_artifact;
    return { results: formatted, metadata };
  }

  async function runStructuredSearchDeduped(
    sessionKey: string,
    dedupeKey: string,
    run: () => Promise<{ results: SearchResultItem[]; metadata: QueryMetadata }>
  ): Promise<{ payload: { results: SearchResultItem[]; metadata: QueryMetadata }; dedupeJoined: boolean }> {
    if (dedupeMode !== "join") {
      return { payload: await run(), dedupeJoined: false };
    }
    const sessionMap = getSessionInflight(sessionKey);
    const existing = sessionMap.get(dedupeKey);
    if (existing) {
      const payload = await existing;
      return { payload, dedupeJoined: true };
    }
    const promise = run().finally(() => {
      const latest = sessionMap.get(dedupeKey);
      if (latest === promise) {
        sessionMap.delete(dedupeKey);
      }
    });
    sessionMap.set(dedupeKey, promise);
    return { payload: await promise, dedupeJoined: false };
  }

  async function createSession(initialContext?: MemoryScopeContext): Promise<WebStandardStreamableHTTPServerTransport> {
    const context: MemoryScopeContext = initialContext ?? {};
    // Pre-seed a temporary session so initialize instructions can include
    // scope-aware memory prefetch before MCP assigns the canonical session ID.
    let kindxSession: KindxSession | null = new KindxSession(context);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        kindxSession?.dispose();
        // Create a KindxSession in the registry with the transport-assigned session ID.
        // This gives tool handlers access to per-session embedding cache + abort signal.
        kindxSession = SessionRegistry.create(sessionId, context);
        sessions.set(sessionId, { transport, context, kindxSession });
        logger.info(`New session ${sessionId} (${sessions.size} active)`);
      },
    });
    const server = createMcpServer(
      store,
      () => requestScopeContext.getStore(),
      () => kindxSession,
      { mcpControl },
    );
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) {
        const sid = transport.sessionId;
        const sess = sessions.get(transport.sessionId);
        // Abort any in-flight operations (e.g. long embedding or rerank calls)
        sess?.kindxSession?.dispose();
        sessions.delete(transport.sessionId);
        inFlightBySession.delete(transport.sessionId);
        inFlightMcpBySession.delete(transport.sessionId);

        // Guardrail: verify registry cleanup so stale sessions do not accumulate.
        if (SessionRegistry.get(sid)) {
          SessionRegistry.delete(sid);
          logger.warn(`stale KindxSession detected during onclose cleanup for ${sid} (force-deleted)`);
        } else {
          logger.info(`Session ${sid} cleaned up`);
        }
      }
      // Tier-2: surface a sensitive-context cleanup failure as a quietWarn
      // counter rather than silently dropping it. A failure here means
      // session-scoped secrets may still be in memory.
      void disposeSensitiveContexts().catch((err) => {
        try {
          const { quietWarn } = require("./utils/quiet-warn.js");
          quietWarn("session.dispose_sensitive_contexts_failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        } catch { /* metrics module load failure shouldn't crash teardown */ }
      });
    };

    return transport;
  }

  const startTime = Date.now();

  /** Extract a human-readable label from a JSON-RPC body */
  function describeRequest(body: any): string {
    const method = body?.method ?? "unknown";
    if (method === "tools/call") {
      const tool = body.params?.name ?? "?";
      const args = body.params?.arguments;
      // Show query string if present, truncated
      if (args?.query) {
        const q = String(args.query).slice(0, 80);
        return `tools/call ${tool} "${q}"`;
      }
      if (args?.path) return `tools/call ${tool} ${args.path}`;
      if (args?.pattern) return `tools/call ${tool} ${args.pattern}`;
      return `tools/call ${tool}`;
    }
    return method;
  }

  function emitStartupEvent(
    type: "mcp_startup_update" | "mcp_startup_complete" | "mcp_startup_failure",
    payload: Record<string, unknown>
  ): void {
    const event = { type, ts: new Date().toISOString(), ...payload };
    logger.info(JSON.stringify(event));
  }

  // Helper to collect request body. Tier-0-7: enforce a hard byte cap so a
  // single multi-GB POST cannot OOM the daemon. Default 16 MiB; override via
  // KINDX_HTTP_MAX_BODY_BYTES. Throws BodyTooLargeError, which the request
  // handler maps to a 413 response.
  const HTTP_MAX_BODY_BYTES = (() => {
    const raw = parseInt(process.env.KINDX_HTTP_MAX_BODY_BYTES || "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 16 * 1024 * 1024;
  })();

  function parseTimeout(raw: string | undefined, fallbackMs: number): number {
    const v = parseInt(raw || "", 10);
    return Number.isFinite(v) && v >= 0 ? v : fallbackMs;
  }

  function accountAndWorkspace(headers: Record<string, string>, scope?: MemoryScopeContext): {
    accountId: string | null;
    workspaceId: string | null;
  } {
    const accountId = headers["x-account-id"] ?? headers["x-workspace-account"] ?? null;
    const workspaceId = scope?.workspaceScope ?? scope?.workspaceUri ?? headers["x-workspace-id"] ?? null;
    return { accountId, workspaceId };
  }

  function applyToolListResponsePolicy(rawJson: any): any {
    if (!rawJson || typeof rawJson !== "object") return rawJson;
    const tools = rawJson?.result?.tools;
    if (!Array.isArray(tools)) return rawJson;
    const allowedNames = new Set(applyToolPolicy(mcpControl, tools.map((t: any) => String(t?.name || ""))));
    const filtered = tools.filter((t: any) => allowedNames.has(String(t?.name || "")));
    return {
      ...rawJson,
      result: {
        ...rawJson.result,
        tools: filtered,
      },
    };
  }

  function injectToolProvenance(rawJson: any, toolName: string): any {
    if (!rawJson || typeof rawJson !== "object") return rawJson;
    if (!rawJson.result || typeof rawJson.result !== "object") return rawJson;
    const provenance = toolProvenance[toolName];
    if (!provenance) return rawJson;
    return {
      ...rawJson,
      result: {
        ...rawJson.result,
        _kindx_tool_provenance: provenance,
      },
    };
  }

  const MAX_HTTP_CONCURRENCY = parseInt(process.env.KINDX_HTTP_CONCURRENCY || "150", 10);
  let activeHttpRequests = 0;
  const activeHttpRequestsByTenant = new Map<string, number>();
  // F-CONC-1: Configurable per-tenant concurrency limit (was hardcoded at 10)
  const MAX_CONCURRENCY_PER_TENANT = (() => {
    const raw = parseInt(process.env.KINDX_MAX_CONCURRENCY_PER_TENANT || "10", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 10;
  })();

  class ConcurrencyLimitError extends Error {
    constructor(public message: string) { super(message); }
  }

  async function withConcurrencyPolicy<T>(
    identity: import("./rbac.js").ResolvedIdentity | null,
    fn: () => Promise<T>
  ): Promise<T> {
    if (activeHttpRequests >= MAX_HTTP_CONCURRENCY) {
      throw new ConcurrencyLimitError("Too Many Requests: Server is at capacity.");
    }
    if (identity) {
      const tenantConcur = activeHttpRequestsByTenant.get(identity.tenantId) || 0;
      if (tenantConcur >= MAX_CONCURRENCY_PER_TENANT) {
        throw new ConcurrencyLimitError("Too Many Requests: Tenant concurrency limit exceeded.");
      }
      activeHttpRequestsByTenant.set(identity.tenantId, tenantConcur + 1);
    }
    activeHttpRequests++;
    try {
      return await fn();
    } finally {
      activeHttpRequests--;
      if (identity) {
        const current = activeHttpRequestsByTenant.get(identity.tenantId) || 0;
        if (current <= 1) {
          activeHttpRequestsByTenant.delete(identity.tenantId);
        } else {
          activeHttpRequestsByTenant.set(identity.tenantId, current - 1);
        }
      }
    }
  }

  const httpServer = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const reqStart = Date.now();
    const pathname = nodeReq.url || "/";
    const method = nodeReq.method || "UNKNOWN";
    const metricRoute = pathname.startsWith("/mcp")
      ? "/mcp"
      : (pathname === "/search" ? "/query" : (pathname === "/query/stream" ? "/query/stream" : pathname));
    const recordHttpMetrics = (statusCode: number): void => {
      const elapsed = Date.now() - reqStart;
      incCounter("kindx_http_requests_total", 1, { route: metricRoute, method, status: String(statusCode) });
      observeHistogram(
        "kindx_http_request_duration_ms",
        elapsed,
        [5, 10, 25, 50, 100, 250, 500, 1000, 3000, 10000],
        { route: metricRoute, method }
      );
    };

    try {
      if (pathname === "/health" && nodeReq.method === "GET") {
        const body = JSON.stringify({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(body);
        recordHttpMetrics(200);
        logger.info(`GET /health (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/ready" && nodeReq.method === "GET") {
        const status = store.getStatus();
        const ops = buildOperationalStatus(store.db, store.dbPath, status.hasVectorIndex);
        const checker = new HealthChecker({
          getModelsStatus: () => ({
            embed: ops.models_ready,
            rerank: ops.models_ready,
            generate: ops.models_ready,
          }),
          getGpuStatus: () => ({
            available: ops.models_ready,
            vramFree: 0,
          }),
          getAnnStatus: () => ({
            mode: status.ann.mode,
            state: status.ann.state,
          }),
          getDatabaseStatus: () => ({
            accessible: ops.db_integrity === "ok",
          }),
        });

        const readiness = await checker.checkReadiness();
        const statusCode = readiness.status === "ready" ? 200 : 503;
        const body = JSON.stringify(readiness);
        nodeRes.writeHead(statusCode, { "Content-Type": "application/json" });
        nodeRes.end(body);
        recordHttpMetrics(statusCode);
        logger.info(`GET /ready (${Date.now() - reqStart}ms) ${readiness.status}`);
        return;
      }

      if (pathname === "/metrics" && nodeReq.method === "GET") {
        const throughput = getRerankThroughputSnapshot(undefined);
        // LLM pool metrics for concurrency observability
        let poolMetrics: { name: string; value: number }[] = [];
        try {
          const { getDefaultLLMPool } = await import("./llm-pool.js");
          const poolState = getDefaultLLMPool().getMetrics();
          poolMetrics = [
            { name: "kindx_llm_pool_size", value: poolState.size },
            { name: "kindx_llm_pool_active", value: poolState.active },
            { name: "kindx_llm_pool_waiting", value: poolState.waiting },
            { name: "kindx_llm_pool_acquired_total", value: poolState.totalAcquired },
            { name: "kindx_llm_pool_timed_out_total", value: poolState.totalTimedOut },
          ];
        } catch { /* pool not available — skip silently */ }
        const body = renderPrometheusMetrics([
          { name: "kindx_rerank_queue_depth", value: throughput.depth },
          { name: "kindx_rerank_queue_active", value: throughput.active },
          { name: "kindx_rerank_queue_concurrency", value: throughput.concurrency },
          { name: "kindx_rerank_queue_timed_out_total", value: throughput.fairness.timedOut },
          { name: "kindx_rerank_queue_saturated_total", value: throughput.fairness.saturated },
          ...poolMetrics,
        ]);
        nodeRes.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        nodeRes.end(body);
        recordHttpMetrics(200);
        return;
      }

      // -----------------------------------------------------------------------
      // Authentication & RBAC
      // -----------------------------------------------------------------------
      // Two modes:
      //  1. Single-tenant (legacy): KINDX_MCP_TOKEN or auto-generated token.
      //     No tenants.yml — all tokens get admin access.
      //  2. Multi-tenant: tenants.yml exists. Each bearer token resolves to a
      //     tenant with role + collection ACL. Unknown tokens are rejected.
      //
      // /health, /ready, and /metrics are intentionally unauthenticated for monitoring.
      // -----------------------------------------------------------------------
      let requestIdentity: import("./rbac.js").ResolvedIdentity | null = null;
      {
        const authHeader = nodeReq.headers["authorization"];
        const bearerToken = parseBearer(authHeader ?? null);
        const { isMultiTenantEnabled, resolveTokenToIdentity } = await import("./rbac.js");

        if (isMultiTenantEnabled()) {
          // Multi-tenant RBAC mode
          if (!bearerToken) {
            nodeRes.writeHead(401, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({ error: "Unauthorized: Bearer token required (multi-tenant RBAC enabled)" }));
            recordHttpMetrics(401);
            logger.info(`401 Unauthorized ${nodeReq.method} ${pathname} (no token)`);
            return;
          }
          requestIdentity = resolveTokenToIdentity(bearerToken);
          if (!requestIdentity) {
            nodeRes.writeHead(403, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({ error: "Forbidden: token does not match any active tenant" }));
            recordHttpMetrics(403);
            logger.info(`403 Forbidden ${nodeReq.method} ${pathname} (unknown/disabled tenant)`);
            return;
          }
          logger.info(`RBAC: tenant=${requestIdentity.tenantId} role=${requestIdentity.role} ${nodeReq.method} ${pathname}`);
        } else if (mcpToken) {
          // Single-tenant legacy mode — constant-time token match
          if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${mcpToken}`)) {
            nodeRes.writeHead(401, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({ error: "Unauthorized: set Authorization: Bearer <KINDX_MCP_TOKEN>" }));
            recordHttpMetrics(401);
            logger.info(`401 Unauthorized ${nodeReq.method} ${pathname}`);
            return;
          }
          // Single-tenant → admin identity
          requestIdentity = { tenantId: "__default", role: "admin", allowedCollections: "*", allowedIndexes: ["*"] };
        } else {
          // No auth configured — restrict to loopback connections only
          const remoteAddr = nodeReq.socket.remoteAddress || "";
          const isLoopback = remoteAddr === "127.0.0.1" || remoteAddr === "::1"
            || remoteAddr === "::ffff:127.0.0.1" || remoteAddr === ""
            || remoteAddr.startsWith("::ffff:127.");
          if (!isLoopback) {
            nodeRes.writeHead(403, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              error: "Forbidden: KINDX_MCP_TOKEN must be configured for non-localhost access"
            }));
            recordHttpMetrics(403);
            logger.info(`403 Forbidden ${nodeReq.method} ${pathname} (no-auth requires loopback)`);
            return;
          }
          requestIdentity = { tenantId: "__default", role: "admin", allowedCollections: "*", allowedIndexes: ["*"] };
        }
      }

      if (requestIdentity) {
        try {
          const { enforceRateLimit, RateLimitExceededError } = await import("./rbac.js");
          enforceRateLimit(requestIdentity.tenantId);
        } catch (err: any) {
          if (err.name === "RateLimitExceededError") {
            nodeRes.writeHead(429, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({ error: err.message }));
            recordHttpMetrics(429);
            logger.info(`429 Too Many Requests: tenant=${requestIdentity.tenantId}`);
            return;
          }
          throw err;
        }
      }

      // REST endpoint: POST /search — structured search without MCP protocol
      // REST endpoint: POST /query (alias: /search) — structured search without MCP protocol
      if ((pathname === "/query" || pathname === "/search") && nodeReq.method === "POST") {
        await withConcurrencyPolicy(requestIdentity, async () => {
          const rawBody = await collectBody(nodeReq, HTTP_MAX_BODY_BYTES);
          const params = JSON.parse(rawBody);

        // RBAC: enforce query permission
        if (requestIdentity) {
          const { isPermitted, filterAllowedCollections } = await import("./rbac.js");
          if (!isPermitted(requestIdentity, "query")) {
            nodeRes.writeHead(403, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({ error: `Forbidden: tenant '${requestIdentity.tenantId}' cannot perform queries` }));
            recordHttpMetrics(403);
            return;
          }
        }

        // Validate required fields
        if (!params.searches || !Array.isArray(params.searches)) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({ error: "Missing required field: searches (array)" }));
          recordHttpMetrics(400);
          return;
        }

        // Map to internal format
        const subSearches: StructuredSubSearch[] = params.searches.map((s: any) => ({
          type: s.type as 'lex' | 'vec' | 'hyde',
          query: String(s.query || ""),
        }));

        // Use default collections if none specified, then filter by RBAC ACL
        let effectiveCollections: string[] = params.collections ?? getDefaultCollectionNames();
        if (requestIdentity && requestIdentity.allowedCollections !== "*") {
          const { filterAllowedCollections } = await import("./rbac.js");
          effectiveCollections = filterAllowedCollections(requestIdentity, effectiveCollections);
          if (effectiveCollections.length === 0) {
            nodeRes.writeHead(403, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              error: `Forbidden: tenant '${requestIdentity.tenantId}' has no access to the requested collections`,
            }));
            recordHttpMetrics(403);
            return;
          }
        }
        const routingProfile = normalizeRoutingProfile(params.routingProfile);
        logger.info(JSON.stringify({
          event: "kindx.query.start",
          route: "http",
          routing_profile: routingProfile,
          searches: subSearches.length,
          collections: effectiveCollections.length,
          encryption_mode: store.getStatus().encryption.encrypted ? "encrypted" : "plaintext",
        }));
        // Tier-1: when no MCP session ID is present, use a per-request UUID
        // rather than the socket remoteAddress. Behind a reverse proxy all
        // anonymous traffic shares one bucket, and request dedupe coalescing
        // could return one client's results to another.
        const sessionKey = String(nodeReq.headers["mcp-session-id"] || `anon-${randomUUID()}`);
        const dedupeKey = stableHash({
          searches: subSearches,
          collections: effectiveCollections,
          limit: params.limit ?? 3,
          minScore: params.minScore ?? 0,
          candidateLimit: params.candidateLimit,
          maxRerankCandidates: params.maxRerankCandidates,
          rerankTimeoutMs: params.rerankTimeoutMs,
          rerankQueueLimit: params.rerankQueueLimit,
          rerankConcurrency: params.rerankConcurrency,
          rerankDropPolicy: params.rerankDropPolicy,
          vectorFanoutWorkers: params.vectorFanoutWorkers,
          routingProfile,
        });
        const { payload, dedupeJoined } = await runStructuredSearchDeduped(
          sessionKey,
          dedupeKey,
          () => runStructuredSearchWithTelemetry(
            subSearches,
            effectiveCollections,
            sessionKey,
            {
              limit: params.limit ?? 3,
              minScore: params.minScore ?? 0,
              candidateLimit: params.candidateLimit,
              maxRerankCandidates: params.maxRerankCandidates,
              rerankTimeoutMs: params.rerankTimeoutMs,
              rerankQueueLimit: params.rerankQueueLimit,
              rerankConcurrency: params.rerankConcurrency,
              rerankDropPolicy: params.rerankDropPolicy,
              vectorFanoutWorkers: params.vectorFanoutWorkers,
              routingProfile,
            }
          )
        );
        const metadata: QueryMetadata = {
          ...payload.metadata,
          dedupe_joined: dedupeJoined,
          dedupe_join_hits: dedupeJoined,
        };

        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(JSON.stringify({ results: payload.results, metadata }));
        recordHttpMetrics(200);
        const annRoute = inferAnnRoute(metadata);
        incCounter("kindx_query_requests_total", 1, {
          profile: routingProfile,
          degraded: String(metadata.degraded_mode === true),
          route: annRoute,
        });
        for (const reason of metadata.fallback_reasons) {
          incCounter("kindx_query_degraded_total", 1, { reason });
        }
        incCounter("kindx_query_route_total", 1, { route: annRoute });
        observeHistogram(
          "kindx_query_total_ms",
          metadata.timings.total_ms,
          [100, 250, 500, 1000, 2500, 5000, 10000, 30000],
          { profile: routingProfile, degraded: String(metadata.degraded_mode === true), route: annRoute }
        );
        logger.info(JSON.stringify({
          event: "kindx.query.end",
          route: "http",
          routing_profile: routingProfile,
          degraded_mode: metadata.degraded_mode,
          fallback_reasons: metadata.fallback_reasons,
          ann_route: annRoute,
          encryption_mode: store.getStatus().encryption.encrypted ? "encrypted" : "plaintext",
          total_ms: metadata.timings.total_ms,
        }));
        logger.info(`POST /query ${params.searches.length} queries (${Date.now() - reqStart}ms)`);
        });
        return;
      }

      // -----------------------------------------------------------------------
      // SSE Streaming endpoint: POST /query/stream
      // Streams search progress events as Server-Sent Events, reducing
      // agent-perceived latency by surfacing pipeline phase transitions.
      // -----------------------------------------------------------------------
      if (pathname === "/query/stream" && nodeReq.method === "POST") {
        await withConcurrencyPolicy(requestIdentity, async () => {
          const rawBody = await collectBody(nodeReq, HTTP_MAX_BODY_BYTES);
          const params = JSON.parse(rawBody);

          // RBAC: enforce query permission
          if (requestIdentity) {
            const { isPermitted } = await import("./rbac.js");
            if (!isPermitted(requestIdentity, "query")) {
              nodeRes.writeHead(403, { "Content-Type": "application/json" });
              nodeRes.end(JSON.stringify({ error: `Forbidden: tenant '${requestIdentity.tenantId}' cannot perform queries` }));
              recordHttpMetrics(403);
              return;
            }
          }

          if (!params.searches || !Array.isArray(params.searches)) {
            nodeRes.writeHead(400, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({ error: "Missing required field: searches (array)" }));
            recordHttpMetrics(400);
            return;
          }

          const subSearches: StructuredSubSearch[] = params.searches.map((s: any) => ({
            type: s.type as 'lex' | 'vec' | 'hyde',
            query: String(s.query || ""),
          }));

          let effectiveCollections: string[] = params.collections ?? getDefaultCollectionNames();
          if (requestIdentity && requestIdentity.allowedCollections !== "*") {
            const { filterAllowedCollections } = await import("./rbac.js");
            effectiveCollections = filterAllowedCollections(requestIdentity, effectiveCollections);
            if (effectiveCollections.length === 0) {
              nodeRes.writeHead(403, { "Content-Type": "application/json" });
              nodeRes.end(JSON.stringify({ error: `Forbidden: tenant '${requestIdentity.tenantId}' has no access to the requested collections` }));
              recordHttpMetrics(403);
              return;
            }
          }

          const routingProfile = normalizeRoutingProfile(params.routingProfile);

          // Begin SSE response
          nodeRes.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  // Disable nginx buffering
          });

          const sendSSE = (event: string, data: Record<string, unknown>) => {
            if (nodeRes.destroyed) return;
            nodeRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          sendSSE("phase", { phase: "started", routing_profile: routingProfile, searches: subSearches.length });

          const timings = newTimings();
          const started = Date.now();
          const profilePolicy = resolveProfilePolicy(routingProfile, params.candidateLimit);
          const effectiveTimeout = resolveTimeoutByProfile(queryTimeoutMs, routingProfile);
          // Tier-1: per-request UUID instead of socket remoteAddress for
          // anonymous traffic — same reasoning as the /query dedupe key.
          const scopeKey = String(nodeReq.headers["mcp-session-id"] || `anon-${randomUUID()}`);

          try {
            const rawResults = await withLLMScope(
              scopeKey,
              () => raceWithTimeout(
                (signal) => structuredSearchWithDiagnostics(store, subSearches, {
                  collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
                  limit: params.limit ?? 3,
                  minScore: params.minScore ?? 0,
                  candidateLimit: profilePolicy.candidateLimit,
                  maxRerankCandidates: params.maxRerankCandidates,
                  rerankTimeoutMs: params.rerankTimeoutMs,
                  rerankQueueLimit: params.rerankQueueLimit,
                  rerankConcurrency: params.rerankConcurrency,
                  rerankDropPolicy: params.rerankDropPolicy,
                  vectorFanoutWorkers: params.vectorFanoutWorkers,
                  rerankLimit: profilePolicy.rerankLimit,
                  disableRerank: routingProfile === "fast",
                  routingProfile,
                  signal,
                  hooks: {
                    onExpandStart: () => { sendSSE("phase", { phase: "expand_start" }); },
                    onExpand: (_original, _expanded, elapsedMs) => {
                      timings.expand_ms += elapsedMs;
                      sendSSE("phase", { phase: "expand_done", elapsed_ms: elapsedMs });
                    },
                    onEmbedStart: (count) => { sendSSE("phase", { phase: "embed_start", count }); },
                    onEmbedDone: (elapsedMs) => {
                      timings.embed_ms += elapsedMs;
                      sendSSE("phase", { phase: "embed_done", elapsed_ms: elapsedMs });
                    },
                    onRetrievalDone: (elapsedMs) => {
                      timings.retrieval_ms = elapsedMs;
                      sendSSE("phase", { phase: "retrieval_done", elapsed_ms: elapsedMs });
                    },
                    onRerankStart: (chunkCount) => { sendSSE("phase", { phase: "rerank_start", chunk_count: chunkCount }); },
                    onRerankInitDone: (elapsedMs) => {
                      timings.rerank_init_ms += elapsedMs;
                      sendSSE("phase", { phase: "rerank_init_done", elapsed_ms: elapsedMs });
                    },
                    onRerankDone: (elapsedMs) => {
                      timings.rerank_ms += elapsedMs;
                      sendSSE("phase", { phase: "rerank_done", elapsed_ms: elapsedMs });
                    },
                    onDegradedMode: (reason) => { sendSSE("phase", { phase: "degraded", reason }); },
                  },
                }),
                effectiveTimeout,
                "query_timeout"
              )
            );

            const primaryQuery = subSearches.find((s) => s.type === "lex")?.query
              || subSearches.find((s) => s.type === "vec")?.query
              || subSearches[0]?.query
              || "";

            const formatted: SearchResultItem[] = rawResults.results.map(r => {
              const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300);
              return {
                docid: `#${r.docid}`,
                file: r.displayPath,
                title: r.title,
                score: Math.round(r.score * 100) / 100,
                context: r.context,
                snippet: addLineNumbers(snippet, line),
              };
            });

            timings.total_ms = Date.now() - started;
            const metadata: QueryMetadata = {
              timings,
              degraded_mode: rawResults.diagnostics.degradedMode,
              fallback_reason: rawResults.diagnostics.fallbackReasons[0] ?? null,
              fallback_reasons: rawResults.diagnostics.fallbackReasons,
              routing_profile: routingProfile,
              scope: scopeKey,
              dedupe_joined: false,
              dedupe_join_hits: false,
              replay_artifact: null,
              replay_artifact_path: null,
              diagnostics: rawResults.diagnostics,
            };

            sendSSE("result", { results: formatted, metadata });
            sendSSE("done", {});
            recordHttpMetrics(200);
            logger.info(`POST /query/stream ${subSearches.length} queries (${Date.now() - reqStart}ms)`);
          } catch (err: any) {
            const message = err instanceof Error ? err.message : "Internal Server Error";
            sendSSE("error", { error: message, code: err?.code || "internal_error" });
            recordHttpMetrics(err?.code === "query_timeout" ? 408 : 500);
          }

          nodeRes.end();
        });
        return;
      }

      if (pathname === "/mcp" && nodeReq.method === "POST") {
        // Circuit breaker gate — reject requests when breaker is open
        if (!circuitBreaker.allow()) {
          nodeRes.writeHead(503, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32004, message: "Service unavailable: circuit breaker open" },
            id: null,
          }));
          recordHttpMetrics(503);
          logger.warn("503 Circuit breaker open, rejecting /mcp request");
          // Audit log circuit breaker open event
          try {
            recordAudit(store.db, {
              action: "circuit_open",
              scope: "mcp",
              detail: "circuit breaker open, rejecting request",
              success: false,
            });
          } catch { /* audit logging must never fail the request */ }
          return;
        }

        const rawBody = await collectBody(nodeReq, HTTP_MAX_BODY_BYTES);
        const body = JSON.parse(rawBody);
        const label = describeRequest(body);
        const url = `http://localhost:${port}${pathname}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        // Route to existing session or create new one on initialize
        const sessionId = headers["mcp-session-id"];
        let transport: WebStandardStreamableHTTPServerTransport;
        let activeContext: MemoryScopeContext | undefined;

        if (sessionId) {
          const existingSession = sessions.get(sessionId);
          if (!existingSession) {
            nodeRes.writeHead(404, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: body?.id ?? null,
            }));
            recordHttpMetrics(404);
            return;
          }
          transport = existingSession.transport;
          activeContext = existingSession.context;
        } else if (isInitializeRequest(body)) {
          // IP-based rate limiting for initialize requests to prevent session creation spam
          const clientIp = nodeReq.socket.remoteAddress || "unknown";
          if (!initRateLimiter.check(clientIp)) {
            nodeRes.writeHead(429, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32005, message: "Rate limit exceeded for initialize requests" },
              id: (body as Record<string, unknown>)?.id ?? null,
            }));
            recordHttpMetrics(429);
            logger.warn(`429 Rate limit exceeded for initialize requests from ip=${clientIp}`);
            // Audit log rate limit event for initialize
            try {
              recordAudit(store.db, {
                action: "rate_limited",
                scope: `init:${clientIp}`,
                detail: `rate limit exceeded for initialize requests from ip=${clientIp}`,
                success: false,
              });
            } catch { /* audit logging must never fail the request */ }
            return;
          }
          const initialContext = extractScopeContextFromInitialize(body);
          transport = await createSession(initialContext);
          activeContext = initialContext;
        } else {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: body?.id ?? null,
          }));
          recordHttpMetrics(400);
          return;
        }

        // Session-based rate limiting — skip for initialize (no session yet)
        if (sessionId && !rateLimiter.check(sessionId)) {
          nodeRes.writeHead(429, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32005, message: "Rate limit exceeded for this session" },
            id: body?.id ?? null,
          }));
          recordHttpMetrics(429);
          logger.warn(`429 Rate limit exceeded for session=${sessionId}`);
          // Audit log rate limit event
          try {
            recordAudit(store.db, {
              action: "rate_limited",
              scope: sessionId,
              detail: `rate limit exceeded for session=${sessionId}`,
              success: false,
            });
          } catch { /* audit logging must never fail the request */ }
          return;
        }

        if (body?.method === "tools/call") {
          const toolName = typeof body?.params?.name === "string" ? body.params.name : "";
          if (!toolName || !isToolEnabledByPolicy(mcpControl, toolName, {
            audit: (entry) => { try { recordAudit(store.db, { ...entry, action: entry.action as any }); } catch {} }
          })) {
            nodeRes.writeHead(403, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32003,
                message: `Tool disabled by MCP policy: ${toolName || "unknown"}`,
              },
              id: body?.id ?? null,
            }));
            recordHttpMetrics(403);
            return;
          }

          // Per-session tool quota enforcement
          if (sessionId && !quotaManager.check(sessionId, toolName)) {
            nodeRes.writeHead(429, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32006,
                message: `Tool quota exceeded for '${toolName}' in this session`,
              },
              id: body?.id ?? null,
            }));
            recordHttpMetrics(429);
            logger.warn(`429 Tool quota exceeded: session=${sessionId} tool=${toolName}`);
            // Audit log quota exceeded event
            try {
              recordAudit(store.db, {
                action: "quota_exceeded",
                scope: `${sessionId}/${toolName}`,
                detail: `tool quota exceeded for '${toolName}' in session=${sessionId}`,
                success: false,
              });
            } catch { /* audit logging must never fail the request */ }
            return;
          }

          // RBAC enforcement on MCP tool calls
          if (requestIdentity) {
            const { isPermitted, filterAllowedCollections, RBACDeniedError } = await import("./rbac.js");
            // Map MCP tool names to RBAC operations
            const toolToOp: Record<string, import("./rbac.js").RBACOperation> = {
              query: "query",
              get: "get",
              multi_get: "multi_get",
              status: "status",
              memory_put: "memory_put",
              memory_search: "memory_search",
              memory_history: "memory_history",
              memory_stats: "memory_stats",
              memory_mark_accessed: "memory_mark_accessed",
              memory_delete: "memory_delete" as import("./rbac.js").RBACOperation,
              memory_bulk: "memory_bulk" as import("./rbac.js").RBACOperation,
              memory_feedback: "memory_feedback" as import("./rbac.js").RBACOperation,
            };
            const op = toolToOp[toolName];
            if (op === undefined || (op && !isPermitted(requestIdentity, op))) {
              nodeRes.writeHead(403, { "Content-Type": "application/json" });
              nodeRes.end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32003,
                  message: `RBAC denied: tenant '${requestIdentity.tenantId}' (${requestIdentity.role}) cannot call '${toolName}'`,
                },
                id: body?.id ?? null,
              }));
              recordHttpMetrics(403);
              logger.info(`RBAC denied: tenant=${requestIdentity.tenantId} tool=${toolName}`);
              return;
            }

            // Filter collections for query tool
            if (toolName === "query" && requestIdentity.allowedCollections !== "*") {
              const toolArgs = (body?.params?.arguments && typeof body.params.arguments === "object")
                ? body.params.arguments
                : {};
              const requestedCollections = Array.isArray(toolArgs.collections)
                ? toolArgs.collections
                : getDefaultCollectionNames();
              const effectiveCollections = filterAllowedCollections(requestIdentity, requestedCollections);
              if (effectiveCollections.length === 0) {
                nodeRes.writeHead(403, { "Content-Type": "application/json" });
                nodeRes.end(JSON.stringify({
                  jsonrpc: "2.0",
                  error: {
                    code: -32003,
                    message: `RBAC denied: tenant '${requestIdentity.tenantId}' has no access to the requested collections`,
                  },
                  id: body?.id ?? null,
                }));
                recordHttpMetrics(403);
                logger.info(`RBAC denied: tenant=${requestIdentity.tenantId} query collections=${JSON.stringify(requestedCollections)}`);
                return;
              }
              toolArgs.collections = effectiveCollections;
              body.params.arguments = toolArgs;
            }
          }
        }

        const isToolsList = body?.method === "tools/list";
        const cacheLookup = accountAndWorkspace(headers, activeContext);
        // Tier-1: include the requesting tenant's role + a stable hash of the
        // allowedCollections set in the cache key. The previous key omitted
        // both, so two tenants on the same workspace with different
        // permissions saw each other's filtered tool list — a cross-role
        // tool-visibility leak.
        const allowedCollectionsKey = !requestIdentity
          ? "anon"
          : requestIdentity.allowedCollections === "*"
            ? "*"
            : createHash("sha256")
                .update([...requestIdentity.allowedCollections].sort().join("\n"))
                .digest("hex").slice(0, 16);
        const toolListCacheKey = toolListCache.buildKey({
          accountId: cacheLookup.accountId,
          workspaceId: cacheLookup.workspaceId,
          projectHash: mcpControl.project_hash,
          serverFingerprint: mcpControl.config_hash,
          role: requestIdentity?.role ?? "anon",
          allowedCollections: allowedCollectionsKey,
        });
        if (isToolsList) {
          const cached = toolListCache.get(toolListCacheKey);
          if (cached && typeof cached === "object") {
            const cachedBody = patchJsonRpcId(JSON.stringify(cached), body?.id ?? null);
            nodeRes.writeHead(200, { "Content-Type": "application/json" });
            nodeRes.end(cachedBody);
            recordHttpMetrics(200);
            logger.info(`POST /mcp tools/list (cache-hit ${Date.now() - reqStart}ms)`);
            return;
          }
        }

        const execute = async (signal?: AbortSignal) => {
          const request = new Request(url, { method: "POST", headers, body: rawBody, signal });
          const response = await requestScopeContext.run(
            activeContext,
            () => requestIdentityScope.run(
              requestIdentity,
              async () => transport.handleRequest(request, { parsedBody: body })
            )
          );
          const responseBody = Buffer.from(await response.arrayBuffer()).toString("utf-8");
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: responseBody,
          };
        };
        const executeWithPolicy = async () => {
          return await withConcurrencyPolicy(requestIdentity, async () => {
            if (body?.method === "tools/call") {
              return await raceWithTimeout(
                (signal) => execute(signal),
                mcpControl.tool_timeout_sec * 1000,
                "TOOL_TIMEOUT"
              );
            }
            return await execute();
          });
        };

        let buffered: { status: number; headers: Record<string, string>; body: string };
        const isSearchLikeToolCall = body?.method === "tools/call"
          && typeof body?.params?.name === "string"
          && (body.params.name === "query" || body.params.name === "search" || body.params.name === "structured_search");
        if (dedupeMode === "join" && sessionId && isSearchLikeToolCall) {
          const dedupeKey = stableHash({
            method: body?.method,
            tool: body?.params?.name,
            arguments: body?.params?.arguments,
          });
          const sessionInflight = getMcpSessionInflight(sessionId);
          const existing = sessionInflight.get(dedupeKey);
          if (existing) {
            buffered = await existing;
          } else {
            const promise = executeWithPolicy().finally(() => {
              const latest = sessionInflight.get(dedupeKey);
              if (latest === promise) sessionInflight.delete(dedupeKey);
            });
            sessionInflight.set(dedupeKey, promise);
            buffered = await promise;
          }
          buffered = {
            ...buffered,
            body: patchJsonRpcId(buffered.body, body?.id ?? null),
          };
        } else {
          buffered = await executeWithPolicy();
        }

        if (body?.method === "tools/list") {
          try {
            const parsed = JSON.parse(buffered.body);
            const filtered = applyToolListResponsePolicy(parsed);
            toolListCache.set(toolListCacheKey, filtered);
            buffered = {
              ...buffered,
              body: patchJsonRpcId(JSON.stringify(filtered), body?.id ?? null),
            };
          } catch {
            // preserve original response on parse issues
          }
        } else if (body?.method === "tools/call") {
          try {
            const toolName = typeof body?.params?.name === "string" ? body.params.name : "";
            const parsed = JSON.parse(buffered.body);
            if (
              toolName.startsWith("memory_") &&
              parsed?.result &&
              typeof parsed.result === "object" &&
              !parsed.result.isError &&
              (parsed.result.structuredContent == null || typeof parsed.result.structuredContent !== "object")
            ) {
              logger.warn(`memory_tool_missing_structured_content: ${toolName}`);
            }
            const patched = injectToolProvenance(parsed, toolName);
            buffered = {
              ...buffered,
              body: patchJsonRpcId(JSON.stringify(patched), body?.id ?? null),
            };
          } catch {
            // keep original response
          }
        }

        // Record circuit breaker state based on response
        if (buffered.status >= 500) {
          circuitBreaker.recordFailure();
        } else {
          circuitBreaker.recordSuccess();
        }

        nodeRes.writeHead(buffered.status, buffered.headers);
        nodeRes.end(buffered.body);
        recordHttpMetrics(buffered.status);
        logger.info(`POST /mcp ${label} (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/mcp") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        // GET/DELETE must have a valid session
        const sessionId = headers["mcp-session-id"];
        if (!sessionId) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: null,
          }));
          recordHttpMetrics(400);
          return;
        }
        const existingSession = sessions.get(sessionId);
        if (!existingSession) {
          nodeRes.writeHead(404, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
          recordHttpMetrics(404);
          return;
        }

        const url = `http://localhost:${port}${pathname}`;
        const rawBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? await collectBody(nodeReq, HTTP_MAX_BODY_BYTES) : undefined;
        const request = new Request(url, { method: nodeReq.method || "GET", headers, ...(rawBody ? { body: rawBody } : {}) });
        const response = await requestScopeContext.run(
          existingSession.context,
          async () => existingSession.transport.handleRequest(request),
        );
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        recordHttpMetrics(response.status);
        return;
      }

      nodeRes.writeHead(404);
      nodeRes.end("Not Found");
      recordHttpMetrics(404);
    } catch (err: any) {
      if (err instanceof ConcurrencyLimitError) {
        nodeRes.writeHead(429, { "Content-Type": "application/json" });
        nodeRes.end(JSON.stringify({ error: err.message }));
        recordHttpMetrics(429);
        return;
      }
      if (err instanceof BodyTooLargeError) {
        // Tier-0-7: cap on request size — return 413 then drop the connection
        // so the (possibly multi-GB) remaining body is not drained.
        try {
          nodeRes.writeHead(413, {
            "Content-Type": "application/json",
            "Connection": "close",
          });
          nodeRes.end(JSON.stringify({ error: err.message, code: "payload_too_large" }));
        } catch { /* socket may already be destroyed */ }
        try { nodeReq.destroy(); } catch { /* noop */ }
        recordHttpMetrics(413);
        return;
      }
      logger.error("HTTP handler error:", { error: err?.message || String(err) });
      const code = (err as any)?.code as string | undefined;
      const message = err instanceof Error ? err.message : "Internal Server Error";
      const status = code === "query_timeout" ? 408 : 500;
      // Record circuit breaker failure on unhandled errors
      if (status >= 500) {
        circuitBreaker.recordFailure();
      }
      nodeRes.writeHead(status, { "Content-Type": "application/json" });
      nodeRes.end(JSON.stringify({
        error: message,
        code: code || "internal_error",
      }));
      recordHttpMetrics(status);
    }
  });

  // Tier-0-8: server-level timeouts. Without these, a slowloris-style client
  // (slow header trickling) holds connections open indefinitely and SSE
  // sessions never time out idle, exhausting socket / FD limits.
  // Defaults match Node 18+ defaults but are made explicit + tunable.
  httpServer.requestTimeout = parseTimeout(process.env.KINDX_HTTP_REQUEST_TIMEOUT_MS, 30_000);
  httpServer.headersTimeout = parseTimeout(process.env.KINDX_HTTP_HEADERS_TIMEOUT_MS, 10_000);
  httpServer.keepAliveTimeout = parseTimeout(process.env.KINDX_HTTP_KEEPALIVE_TIMEOUT_MS, 65_000);

  emitStartupEvent("mcp_startup_update", { phase: "binding", port });
  const exposedTools = applyToolPolicy(mcpControl, [...KINDX_MCP_TOOL_NAMES]);
  emitStartupEvent("mcp_startup_update", {
    phase: "tools",
    server_id: KINDX_MCP_SERVER_ID,
    exposed_tools: exposedTools,
    config_source: mcpControl.source,
    startup_timeout_sec: mcpControl.startup_timeout_sec,
    tool_timeout_sec: mcpControl.tool_timeout_sec,
  });
  if (mcpControl.project_scoped && !mcpControl.trusted_project) {
    emitStartupEvent("mcp_startup_failure", {
      phase: "binding",
      code: "PROJECT_NOT_TRUSTED",
      message: "project_scoped MCP config requires trusted project",
    });
    throw Object.assign(new Error("project_scoped MCP config requires trusted project"), {
      code: "PROJECT_NOT_TRUSTED",
    });
  }
  let boundHost: string;
  let actualPort: number;
  let url: string;
  try {
    boundHost = await raceWithTimeout(
      () => bindHttpServerWithFallback(httpServer, port),
      mcpControl.startup_timeout_sec * 1000,
      "STARTUP_TIMEOUT"
    );
    actualPort = (httpServer.address() as import("net").AddressInfo).port;
    url = `http://${boundHost}:${actualPort}/mcp`;
    emitStartupEvent("mcp_startup_complete", {
      phase: "ready",
      host: boundHost,
      port: actualPort,
      url,
    });
    // Start idle session reaper for HTTP transport
    SessionRegistry.startReaper();
    // Warn if running in zero-auth mode
    if (!process.env.KINDX_MCP_TOKEN && !process.env.KINDX_TENANTS_CONFIG) {
      process.stderr.write(
        '[KINDX] WARNING: No KINDX_MCP_TOKEN or tenants.yml configured. ' +
        'Running in zero-auth mode (loopback only). ' +
        'Set KINDX_MCP_TOKEN for production deployments.\n'
      );
    }
    // Purge old audit log entries on startup
    try {
      const purged = purgeOldAuditEntries(store.db);
      if (purged > 0) {
        process.stderr.write(`[KINDX] Purged ${purged} old audit entries\n`);
      }
    } catch { /* audit purge must never fail startup */ }
  } catch (err) {
    emitStartupEvent("mcp_startup_failure", {
      phase: "binding",
      code: (err as any)?.code || "startup_error",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Dispose all KindxSession instances — aborts in-flight ops and clears embedding caches
    await SessionRegistry.disposeAll().catch(() => {});
    for (const session of sessions.values()) {
      await session.transport.close();
    }
    sessions.clear();
    inFlightBySession.clear();
    inFlightMcpBySession.clear();
    httpServer.close();
    store.close();
    await disposeSensitiveContexts().catch(() => {});
    await disposeDefaultLLM();
  };

  const shutdown = async () => {
    await stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    logger.info("Shutting down (SIGTERM)...");
    shutdown();
  });
  process.once("SIGINT", () => {
    logger.info("Shutting down (SIGINT)...");
    shutdown();
  });

  logger.info(`KINDX MCP server listening on ${url}`);
  return { httpServer, port: actualPort, host: boundHost, url, stop, controlPlane: { rateLimiter, initRateLimiter, quotaManager, circuitBreaker } };
}

// Run if this is the main module
if (fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1]?.endsWith("/mcp.ts") || process.argv[1]?.endsWith("/protocol.js")) {
  startMcpServer().catch(console.error);
}
