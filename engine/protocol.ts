/**
 * KINDX MCP Server - Model Context Protocol server for QMD
 *
 * Exposes KINDX search and document retrieval as MCP tools and resources.
 * Documents are accessible via kindx:// URIs.
 *
 * Follows MCP spec 2025-06-18 for proper response types.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createStore,
  extractSnippet,
  addLineNumbers,
  structuredSearchWithDiagnostics,
  DEFAULT_MULTI_GET_MAX_BYTES,
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
  collections: {
    name: string;
    path: string;
    pattern: string;
    documents: number;
    lastUpdated: string;
  }[];
  watchDaemon?: "active" | "inactive";
};

type MemoryScopeContext = SessionScopeContext;
const KINDX_MCP_SERVER_ID = "kindx";
const KINDX_MCP_TOOL_NAMES = [
  "query",
  "get",
  "multi_get",
  "status",
  "memory_put",
  "memory_search",
  "memory_history",
  "memory_stats",
  "memory_mark_accessed",
] as const;

type QueryTimings = {
  expand_ms: number;
  embed_ms: number;
  retrieval_ms: number;
  rerank_init_ms: number;
  rerank_ms: number;
  total_ms: number;
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
  diagnostics?: StructuredSearchDiagnostics;
};

function newTimings(): QueryTimings {
  return {
    expand_ms: 0,
    embed_ms: 0,
    retrieval_ms: 0,
    rerank_init_ms: 0,
    rerank_ms: 0,
    total_ms: 0,
  };
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

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`Query timed out after ${timeoutMs}ms`), { code }));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
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
    { name: "kindx", version: "0.9.9" },
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
        limit: z.number().optional().default(10).describe("Max results (default: 10)"),
        minScore: z.number().optional().default(0).describe("Min relevance 0-1 (default: 0)"),
        candidateLimit: z.number().optional().describe(
          "Maximum candidates to rerank (default: 40, lower = faster but may miss results)"
        ),
        routingProfile: z.enum(["fast", "balanced", "max_precision"]).optional().default("balanced").describe(
          "Retrieval routing profile: fast (lower latency), balanced (default), max_precision (higher recall/precision)."
        ),
        collections: z.array(z.string()).optional().describe("Filter to collections (OR match)"),
      },
    },
    async ({ searches, limit, minScore, candidateLimit, routingProfile, collections }: any) => {
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

      const results = await withLLMScope(
        scopeKey,
        () => raceWithTimeout(
          structuredSearchWithDiagnostics(store, subSearches, {
            collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
            limit,
            minScore,
            candidateLimit: profilePolicy.candidateLimit,
            rerankLimit: profilePolicy.rerankLimit,
            disableRerank: profile === "fast",
            routingProfile: profile,
            hooks: {
              onExpand: (_original, _expanded, elapsedMs) => { timings.expand_ms += elapsedMs; },
              onEmbedDone: (elapsedMs) => { timings.embed_ms += elapsedMs; },
              onRetrievalDone: (elapsedMs) => { timings.retrieval_ms = elapsedMs; },
              onRerankInitDone: (elapsedMs) => { timings.rerank_init_ms += elapsedMs; },
              onRerankDone: (elapsedMs) => { timings.rerank_ms += elapsedMs; },
            },
          }),
          resolveTimeoutByProfile(timeoutMs, profile),
          "query_timeout"
        )
      );
      timings.total_ms = Date.now() - totalStart;

      // Use first lex or vec query for snippet extraction
      const primaryQuery = searches.find((s: any) => s.type === 'lex')?.query
        || searches.find((s: any) => s.type === 'vec')?.query
        || searches[0]?.query || "";

      const filtered: SearchResultItem[] = results.results.map(r => {
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
        results: filtered,
      });
      metadata.replay_artifact_path = metadata.replay_artifact;

      return {
        content: [{ type: "text", text: formatSearchSummary(filtered, primaryQuery) }],
        structuredContent: { results: filtered, metadata, timings },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_get (Retrieve document)
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
      // Support :line suffix in `file` (e.g. "foo.md:120") when fromLine isn't provided
      let parsedFromLine = fromLine;
      let lookup = file;
      const colonMatch = lookup.match(/:(\d+)$/);
      if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
        parsedFromLine = parseInt(colonMatch[1], 10);
        lookup = lookup.slice(0, -colonMatch[0].length);
      }

      const result = store.findDocument(lookup, { includeBody: false });

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

      const body = store.getDocumentBody(result, parsedFromLine, maxLines) ?? "";
      let text = body;
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
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_multi_get (Retrieve multiple documents)
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
            text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}. Use 'qmd_get' with file="${result.doc.displayPath}" to retrieve.]`,
          });
          continue;
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
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_status (Index status)
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
      const status: StatusResult = store.getStatus();

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

      const fullStatus = { ...status, watchDaemon };

      const summary = [
        `KINDX Index Status:`,
        `  Total documents: ${status.totalDocuments}`,
        `  Needs embedding: ${status.needsEmbedding}`,
        `  Vector index: ${status.hasVectorIndex ? 'yes' : 'no'}`,
        `  Collections: ${status.collections.length}`,
        `  Watch Daemon: ${watchDaemon === "active" ? "active" : "inactive"}`,
      ];

      for (const col of status.collections) {
        summary.push(`    - ${col.path} (${col.documents} docs)`);
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
      },
    },
    async ({ scope, key, value, tags, source, confidence, semanticThreshold }: any) => {
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

  // Read token once at startup. Undefined / empty = auth disabled (single-user local mode).
  const mcpToken = controlHeaders.Authorization?.replace(/^Bearer\s+/i, "").trim()
    || process.env.KINDX_MCP_TOKEN?.trim()
    || null;

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
        structuredSearchWithDiagnostics(store, subSearches, {
          collections: effectiveCollections && effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit: options.limit,
          minScore: options.minScore,
          candidateLimit: profilePolicy.candidateLimit,
          rerankLimit: profilePolicy.rerankLimit,
          disableRerank: options.routingProfile === "fast",
          routingProfile: options.routingProfile,
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
        log(`${ts()} New session ${sessionId} (${sessions.size} active)`);
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
          log(`${ts()} WARN stale KindxSession detected during onclose cleanup for ${sid} (force-deleted)`);
        } else {
          log(`${ts()} Session ${sid} cleaned up`);
        }
      }
      void disposeSensitiveContexts().catch(() => {});
    };

    return transport;
  }

  const startTime = Date.now();
  const quiet = options?.quiet ?? false;

  /** Format timestamp for request logging */
  function ts(): string {
    return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  }

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

  function log(msg: string): void {
    if (!quiet) console.error(msg);
  }

  function emitStartupEvent(
    type: "mcp_startup_update" | "mcp_startup_complete" | "mcp_startup_failure",
    payload: Record<string, unknown>
  ): void {
    const event = { type, ts: new Date().toISOString(), ...payload };
    log(JSON.stringify(event));
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

  const httpServer = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const reqStart = Date.now();
    const pathname = nodeReq.url || "/";

    try {
      if (pathname === "/health" && nodeReq.method === "GET") {
        const body = JSON.stringify({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(body);
        log(`${ts()} GET /health (${Date.now() - reqStart}ms)`);
        return;
      }

      // Bearer token authentication — enforced when KINDX_MCP_TOKEN env var is set.
      // /health is intentionally exempt to allow monitoring probes without credentials.
      // Set KINDX_MCP_TOKEN before starting the daemon in any shared or networked deployment.
      if (mcpToken) {
        const authHeader = nodeReq.headers["authorization"];
        if (!authHeader || authHeader !== `Bearer ${mcpToken}`) {
          nodeRes.writeHead(401, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({ error: "Unauthorized: set Authorization: Bearer <KINDX_MCP_TOKEN>" }));
          log(`${ts()} 401 Unauthorized ${nodeReq.method} ${pathname}`);
          return;
        }
      }

      // REST endpoint: POST /search — structured search without MCP protocol
      // REST endpoint: POST /query (alias: /search) — structured search without MCP protocol
      if ((pathname === "/query" || pathname === "/search") && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const params = JSON.parse(rawBody);

        // Validate required fields
        if (!params.searches || !Array.isArray(params.searches)) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({ error: "Missing required field: searches (array)" }));
          return;
        }

        // Map to internal format
        const subSearches: StructuredSubSearch[] = params.searches.map((s: any) => ({
          type: s.type as 'lex' | 'vec' | 'hyde',
          query: String(s.query || ""),
        }));

        // Use default collections if none specified
        const effectiveCollections = params.collections ?? getDefaultCollectionNames();
        const routingProfile = normalizeRoutingProfile(params.routingProfile);
        const sessionKey = String(nodeReq.headers["mcp-session-id"] || nodeReq.socket.remoteAddress || "anon");
        const dedupeKey = stableHash({
          searches: subSearches,
          collections: effectiveCollections,
          limit: params.limit ?? 10,
          minScore: params.minScore ?? 0,
          candidateLimit: params.candidateLimit,
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
        log(`${ts()} POST /query ${params.searches.length} queries (${Date.now() - reqStart}ms)`);
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
            return;
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
            log(`${ts()} POST /mcp tools/list (cache-hit ${Date.now() - reqStart}ms)`);
            return;
          }
        }

        const execute = async () => {
          const request = new Request(url, { method: "POST", headers, body: rawBody });
          const response = await requestScopeContext.run(
            activeContext,
            async () => transport.handleRequest(request, { parsedBody: body }),
          );
          const responseBody = Buffer.from(await response.arrayBuffer()).toString("utf-8");
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: responseBody,
          };
        };
        const executeWithPolicy = async () => {
          if (body?.method === "tools/call") {
            return await raceWithTimeout(
              execute(),
              mcpControl.tool_timeout_sec * 1000,
              "TOOL_TIMEOUT"
            );
          }
          return await execute();
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
        log(`${ts()} POST /mcp ${label} (${Date.now() - reqStart}ms)`);
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
        return;
      }

      nodeRes.writeHead(404);
      nodeRes.end("Not Found");
    } catch (err) {
      console.error("HTTP handler error:", err);
      const code = (err as any)?.code as string | undefined;
      const message = err instanceof Error ? err.message : "Internal Server Error";
      const status = code === "query_timeout" ? 408 : 500;
      nodeRes.writeHead(status, { "Content-Type": "application/json" });
      nodeRes.end(JSON.stringify({
        error: message,
        code: code || "internal_error",
      }));
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
      bindHttpServerWithFallback(httpServer, port),
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

  process.on("SIGTERM", async () => {
    console.error("Shutting down (SIGTERM)...");
    await stop();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.error("Shutting down (SIGINT)...");
    await stop();
    process.exit(0);
  });

  log(`KINDX MCP server listening on ${url}`);
  return { httpServer, port: actualPort, host: boundHost, url, stop };
}

// Run if this is the main module
if (fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1]?.endsWith("/mcp.ts") || process.argv[1]?.endsWith("/protocol.js")) {
  startMcpServer().catch(console.error);
}
