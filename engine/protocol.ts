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
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
import { disposeDefaultLLM, disposeSensitiveContexts, withLLMScope } from "./inference.js";
import {
  upsertMemory,
  semanticSearchMemory,
  textSearchMemory,
  getMemoryHistory,
  getMemoryStats,
  markMemoryAccessed,
  resolveMemoryScope,
  deriveWorkspaceMemoryScope,
} from "./memory.js";
import {
  KindxSession,
  SessionRegistry,
  type SessionScopeContext,
} from "./session.js";
import { getShardHealthSummary } from "./sharding.js";
import { initializeAuditSchema, recordAudit, queryAuditLog, getAuditSummary } from "./audit.js";
import { loadLayeredInstructions } from "./instruction-layering.js";
import {
  McpToolListCache,
  applyToolPolicy,
  buildResolvedHttpHeaders,
  buildToolProvenanceRegistry,
  isToolEnabledByPolicy,
  loadMcpControlPlaneConfig,
  resolveMcpServerControl,
} from "./mcp-control-plane.js";
import type { ResolvedMcpServerControl } from "./mcp-control-plane.js";

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
  "status",
  "arch_status",
  "arch_query",
  "memory_put",
  "memory_search",
  "memory_history",
  "memory_stats",
  "memory_mark_accessed",
  "memory_delete",
  "memory_bulk",
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
  code: string
): Promise<T> {
  const ac = new AbortController();
  const getPromise = () => typeof promiseOrFn === "function" ? promiseOrFn(ac.signal) : promiseOrFn;
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

function buildInstructions(store: Store, session?: KindxSession): string {
  const status = store.getStatus();
  const lines: string[] = [];

  // --- What is this? ---
  const globalCtx = getGlobalContext();
  lines.push(`KINDX is your local search engine over ${status.totalDocuments} markdown documents.`);
  if (globalCtx) lines.push(`Context: ${globalCtx}`);
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

  // --- What's searchable? ---
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

  // --- Capability gaps ---
  if (!status.hasVectorIndex) {
    lines.push("");
    lines.push("Note: No vector embeddings yet. Run `kindx embed` to enable semantic search (vec/hyde).");
  } else if (status.needsEmbedding > 0) {
    lines.push("");
    lines.push(`Note: ${status.needsEmbedding} documents need embedding. Run \`kindx embed\` to update.`);
  }

  // --- Memory prefetch: surface top-accessed workspace memories inline ---
  // This avoids a separate memory_search tool call at the start of every session.
  // We only surface memories when we have a scope to resolve against.
  const workspaceScope = session?.scopeContext?.workspaceScope;
  if (workspaceScope) {
    try {
      const stats = getMemoryStats(store.db, workspaceScope);
      let topMemories = stats.topAccessed.slice(0, MEMORY_PREFETCH_LIMIT);
      if (topMemories.length === 0) {
        // Fallback for fresh scopes where no entry has been marked as accessed yet.
        const recentRows = store.db.prepare(`
          SELECT value
          FROM memories
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
    } catch {
      // Memory prefetch is best-effort — never block startup
    }
  }

  // --- Search tool ---
  lines.push("");
  lines.push("Search: Use `query` with sub-queries (lex/vec/hyde):");
  lines.push("  - type:'lex' — BM25 keyword search (exact terms, fast)");
  lines.push("  - type:'vec' — semantic vector search (meaning-based)");
  lines.push("  - type:'hyde' — hypothetical document (write what the answer looks like)");
  lines.push("");
  lines.push("Examples:");
  lines.push("  Quick keyword lookup: [{type:'lex', query:'error handling'}]");
  lines.push("  Semantic search: [{type:'vec', query:'how to handle errors gracefully'}]");
  lines.push("  Best results: [{type:'lex', query:'error'}, {type:'vec', query:'error handling best practices'}]");

  // --- Retrieval workflow ---
  lines.push("");
  lines.push("Retrieval:");
  lines.push("  - `get` — single document by path or docid (#abc123). Supports line offset (`file.md:100`).");
  lines.push("  - `multi_get` — batch retrieve by glob (`journals/2025-05*.md`) or comma-separated list.");

  // --- Non-obvious things that prevent mistakes ---
  lines.push("");
  lines.push("Tips:");
  lines.push("  - File paths in results are relative to their collection.");
  lines.push("  - Use `minScore: 0.5` to filter low-confidence results.");
  lines.push("  - Results include a `context` field describing the content type.");

  return lines.join("\n");
}

/**
 * Test hook: generate initialize instructions with optional session context.
 * Keeps production callsites unchanged while allowing deterministic unit tests.
 */
export function buildInstructionsForTest(store: Store, session?: KindxSession): string {
  return buildInstructions(store, session);
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
  },
): McpServer {
  const mcpControl = options?.mcpControl;
  const server = new McpServer(
    { name: "kindx", version: "1.3.2" },
    { instructions: buildInstructions(store, getSession?.() ?? undefined) },
  );
  const maybeRegisterTool = (
    name: string,
    def: any,
    handler: any,
  ): void => {
    if (mcpControl && !isToolEnabledByPolicy(mcpControl, name)) {
      return;
    }
    server.registerTool(name, def, handler);
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
      description: `Search the knowledge base using a query document — one or more typed sub-queries combined for best recall.

## Query Types

**lex** — BM25 keyword search. Fast, exact, no LLM needed.
Full lex syntax:
- \`term\` — prefix match ("perf" matches "performance")
- \`"exact phrase"\` — phrase must appear verbatim
- \`-term\` or \`-"phrase"\` — exclude documents containing this

Good lex examples:
- \`"connection pool" timeout -redis\`
- \`"machine learning" -sports -athlete\`
- \`handleError async typescript\`

**vec** — Semantic vector search. Write a natural language question. Finds documents by meaning, not exact words.
- \`how does the rate limiter handle burst traffic?\`
- \`what is the tradeoff between consistency and availability?\`

**hyde** — Hypothetical document. Write 50-100 words that look like the answer. Often the most powerful for nuanced topics.
- \`The rate limiter uses a token bucket algorithm. When a client exceeds 100 req/min, subsequent requests return 429 until the window resets.\`

## Strategy

Combine types for best results. First sub-query gets 2× weight — put your strongest signal first.

| Goal | Approach |
|------|----------|
| Know exact term/name | \`lex\` only |
| Concept search | \`vec\` only |
| Best recall | \`lex\` + \`vec\` |
| Complex/nuanced | \`lex\` + \`vec\` + \`hyde\` |
| Unknown vocabulary | Use a standalone natural-language query (no typed lines) so the server can auto-expand it |

## Examples

Simple lookup:
\`\`\`json
[{ "type": "lex", "query": "CAP theorem" }]
\`\`\`

Best recall on a technical topic:
\`\`\`json
[
  { "type": "lex", "query": "\\"connection pool\\" timeout -redis" },
  { "type": "vec", "query": "why do database connections time out under load" },
  { "type": "hyde", "query": "Connection pool exhaustion occurs when all connections are in use and new requests must wait. This typically happens under high concurrency when queries run longer than expected." }
]
\`\`\`

Intent-aware lex (C++ performance, not sports):
\`\`\`json
[
  { "type": "lex", "query": "\\"C++ performance\\" optimization -sports -athlete" },
  { "type": "vec", "query": "how to optimize C++ program performance" }
]
\`\`\``,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        searches: z.array(subSearchSchema).min(1).max(10).describe(
          "Typed sub-queries to execute (lex/vec/hyde). First gets 2x weight."
        ),
        limit: z.number().max(200).optional().default(10).describe("Max results (default: 10, max: 200)"),
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
        maxSnippetLines: z.number().optional().describe(
          "Maximum lines per result snippet. Truncates to the most relevant excerpt. Reduces token usage for agents with limited context windows."
        ),
      },
    },
    async ({ searches, limit, minScore, candidateLimit, maxRerankCandidates, rerankTimeoutMs, rerankQueueLimit, rerankConcurrency, rerankDropPolicy, vectorFanoutWorkers, routingProfile, collections, maxSnippetLines }: any) => {
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

      const results = await withLLMScope(
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
        diagnostics: results.diagnostics,
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
      description: "Retrieve the full content of a document by its file path or docid. Use paths or docids (#abc123) from search results. Suggests similar files if not found.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results (e.g., 'pages/meeting.md', '#abc123', or 'pages/meeting.md:100' to start at line 100)"),
        fromLine: z.number().optional().describe("Start from this line number (1-indexed)"),
        maxLines: z.number().optional().describe("Maximum number of lines to return"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
      },
    },
    async ({ file, fromLine, maxLines, lineNumbers }: any) => {
      try {
      // Support :line suffix in `file` (e.g. "foo.md:120") when fromLine isn't provided
      let parsedFromLine = fromLine;
      let lookup = file;
      const colonMatch = lookup.match(/:(\d+)$/);
      if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
        parsedFromLine = parseInt(colonMatch[1], 10);
        lookup = lookup.slice(0, -colonMatch[0].length);
      }

      const result = store.findDocument(lookup, { includeBody: false });

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
      description: "Retrieve multiple documents by glob pattern (e.g., 'journals/2025-05*.md') or comma-separated list. Skips files larger than maxBytes.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated list of file paths"),
        maxLines: z.number().optional().describe("Maximum lines per file"),
        maxBytes: z.number().optional().default(10240).describe("Skip files larger than this (default: 10240 = 10KB)"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
      },
    },
    async ({ pattern, maxLines, maxBytes, lineNumbers }: any) => {
      try {
      const { docs, errors } = store.findDocuments(pattern, { includeBody: true, maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES });

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
      description: "Show the status of the KINDX index: collections, document counts, and health information.",
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

  maybeRegisterTool(
    "arch_status",
    {
      title: "Arch Status",
      description: "Show Arch integration status, artifact paths, and latest distilled manifest summary.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        sourceRoot: z.string().optional().describe("Source root path used to resolve Arch workspace (default: current process cwd)."),
      },
    },
    async ({ sourceRoot }: any) => {
      try {
        const root = typeof sourceRoot === "string" && sourceRoot.trim().length > 0
          ? sourceRoot
          : process.cwd();
        const { getArchConfig, getArchStatus } = await import("./integrations/arch/adapter.js");
        const config = getArchConfig();
        const status = getArchStatus(config, root);
        return {
          content: [{
            type: "text",
            text: [
              `enabled=${status.enabled}`,
              `augment=${status.augmentEnabled}`,
              `repo=${config.repoPath}`,
              `source_root=${root}`,
              `distilled_docs=${status.paths.docsDir}`,
              `manifest=${status.paths.manifestPath}`,
              `manifest_present=${status.manifest ? "yes" : "no"}`,
            ].join("\n"),
          }],
          structuredContent: {
            enabled: status.enabled,
            augmentEnabled: status.augmentEnabled,
            repoCheck: status.repoCheck,
            paths: status.paths,
            manifest: status.manifest,
            config: {
              collectionName: config.collectionName,
              minConfidence: config.minConfidence,
              maxHints: config.maxHints,
            },
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `arch_status_failed: ${error}` }],
          isError: true,
        };
      }
    },
  );

  maybeRegisterTool(
    "arch_query",
    {
      title: "Arch Query",
      description: "Retrieve architecture-aware hints from distilled Arch artifacts without altering KINDX primary retrieval.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().describe("Architecture-focused query text."),
        sourceRoot: z.string().optional().describe("Source root path used to resolve Arch workspace (default: current process cwd)."),
        limit: z.number().optional().default(3).describe("Maximum number of hints to return."),
      },
    },
    async ({ query, sourceRoot, limit }: any) => {
      try {
        if (!query || typeof query !== "string" || query.trim().length === 0) {
          return {
            content: [{ type: "text", text: "query is required" }],
            isError: true,
          };
        }
        const root = typeof sourceRoot === "string" && sourceRoot.trim().length > 0
          ? sourceRoot
          : process.cwd();
        const { getArchConfig } = await import("./integrations/arch/adapter.js");
        const { resolveArchPaths, readDistilledManifest } = await import("./integrations/arch/importer.js");
        const { selectArchHints } = await import("./integrations/arch/augment.js");
        const config = getArchConfig();
        if (!config.enabled) {
          return {
            content: [{ type: "text", text: "Arch integration is disabled. Set KINDX_ARCH_ENABLED=1 to enable." }],
            isError: true,
          };
        }
        const paths = resolveArchPaths(config.artifactDir, root);
        const manifest = readDistilledManifest(paths.manifestPath);
        if (!manifest) {
          return {
            content: [{ type: "text", text: `no_arch_manifest: ${paths.manifestPath}` }],
            isError: true,
          };
        }
        const maxHints = Number.isFinite(limit) ? Math.max(1, Number(limit)) : config.maxHints;
        const hints = selectArchHints(query, manifest.hintsPath, maxHints);
        return {
          content: [{ type: "text", text: `returned ${hints.length} arch hint(s)` }],
          structuredContent: {
            query,
            sourceRoot: root,
            manifestPath: paths.manifestPath,
            hints,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `arch_query_failed: ${error}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tools: memory_* (Scoped memory subsystem)
  // ---------------------------------------------------------------------------

  maybeRegisterTool(
    "memory_put",
    {
      title: "Memory Put",
      description: "Create or update a scoped memory record.",
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
      description: "Search scoped memories using semantic or text mode.",
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
      description: "Show historical values for a key in one scope.",
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
      description: "Get memory statistics for a scope.",
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
      description: "Increment accessed counter for a scoped memory id.",
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
      description: "Delete a memory record by its ID. Removes associated tags, embeddings, and links.",
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
      description: "Batch execute multiple memory insertions and deletions efficiently. Highly recommended when summarizing blocks or migrating multiple related facts at once.",
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

  return server;
}

// =============================================================================
// Transport: stdio (default)
// =============================================================================

export async function startMcpServer(dbPath?: string): Promise<void> {
  const store = createStore(dbPath);
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
  const store = createStore(options?.dbPath);
  const loadedControl = loadMcpControlPlaneConfig();
  const mcpControl = resolveMcpServerControl(KINDX_MCP_SERVER_ID, loadedControl);
  const controlHeaders = buildResolvedHttpHeaders(mcpControl);
  const toolProvenance = buildToolProvenanceRegistry(KINDX_MCP_SERVER_ID, [...KINDX_MCP_TOOL_NAMES]);
  const toolListCache = new McpToolListCache();
  const requestScopeContext = new AsyncLocalStorage<MemoryScopeContext | undefined>();
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
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      mcpToken = randomBytes(32).toString("hex");
      writeFileSync(tokenFile, mcpToken, { encoding: "utf8", mode: 0o600 });
      // Ensure strict permissions if writeFileSync mode isn't fully honored (e.g. umask)
      chmodSync(tokenFile, 0o600);
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
      void disposeSensitiveContexts().catch(() => {});
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

  // Helper to collect request body
  async function collectBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
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
      // /health and /metrics are intentionally unauthenticated for monitoring.
      // -----------------------------------------------------------------------
      let requestIdentity: import("./rbac.js").ResolvedIdentity | null = null;
      {
        const authHeader = nodeReq.headers["authorization"];
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, "").trim() || null;
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
          // Single-tenant legacy mode — exact token match
          if (!authHeader || authHeader !== `Bearer ${mcpToken}`) {
            nodeRes.writeHead(401, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({ error: "Unauthorized: set Authorization: Bearer <KINDX_MCP_TOKEN>" }));
            recordHttpMetrics(401);
            logger.info(`401 Unauthorized ${nodeReq.method} ${pathname}`);
            return;
          }
          // Single-tenant → admin identity
          requestIdentity = { tenantId: "__default", role: "admin", allowedCollections: "*" };
        } else {
          // No auth configured — admin identity (open access, local-only deployments)
          requestIdentity = { tenantId: "__default", role: "admin", allowedCollections: "*" };
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
          const rawBody = await collectBody(nodeReq);
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
        const sessionKey = String(nodeReq.headers["mcp-session-id"] || nodeReq.socket.remoteAddress || "anon");
        const dedupeKey = stableHash({
          searches: subSearches,
          collections: effectiveCollections,
          limit: params.limit ?? 10,
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
              limit: params.limit ?? 10,
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
          const rawBody = await collectBody(nodeReq);
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
          const scopeKey = String(nodeReq.headers["mcp-session-id"] || nodeReq.socket.remoteAddress || "anon");

          try {
            const rawResults = await withLLMScope(
              scopeKey,
              () => raceWithTimeout(
                (signal) => structuredSearchWithDiagnostics(store, subSearches, {
                  collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
                  limit: params.limit ?? 10,
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
        const rawBody = await collectBody(nodeReq);
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

        if (body?.method === "tools/call") {
          const toolName = typeof body?.params?.name === "string" ? body.params.name : "";
          if (!toolName || !isToolEnabledByPolicy(mcpControl, toolName)) {
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

          // RBAC enforcement on MCP tool calls
          if (requestIdentity) {
            const { isPermitted, filterAllowedCollections, RBACDeniedError } = await import("./rbac.js");
            // Map MCP tool names to RBAC operations
            const toolToOp: Record<string, import("./rbac.js").RBACOperation> = {
              query: "query",
              get: "get",
              multi_get: "multi_get",
              status: "status",
              arch_status: "arch_status",
              arch_query: "arch_query",
              memory_put: "memory_put",
              memory_search: "memory_search",
              memory_history: "memory_history",
              memory_stats: "memory_stats",
              memory_mark_accessed: "memory_mark_accessed",
              memory_delete: "memory_delete" as import("./rbac.js").RBACOperation,
              memory_bulk: "memory_bulk" as import("./rbac.js").RBACOperation,
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
        const toolListCacheKey = toolListCache.buildKey({
          accountId: cacheLookup.accountId,
          workspaceId: cacheLookup.workspaceId,
          projectHash: mcpControl.project_hash,
          serverFingerprint: mcpControl.config_hash,
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
        const rawBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? await collectBody(nodeReq) : undefined;
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
      logger.error("HTTP handler error:", { error: err?.message || String(err) });
      const code = (err as any)?.code as string | undefined;
      const message = err instanceof Error ? err.message : "Internal Server Error";
      const status = code === "query_timeout" ? 408 : 500;
      nodeRes.writeHead(status, { "Content-Type": "application/json" });
      nodeRes.end(JSON.stringify({
        error: message,
        code: code || "internal_error",
      }));
      recordHttpMetrics(status);
    }
  });

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
  return { httpServer, port: actualPort, host: boundHost, url, stop };
}

// Run if this is the main module
if (fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1]?.endsWith("/mcp.ts") || process.argv[1]?.endsWith("/protocol.js")) {
  startMcpServer().catch(console.error);
}
