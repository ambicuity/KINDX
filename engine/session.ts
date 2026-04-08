/**
 * session.ts - Per-connection session lifecycle management for KINDX
 *
 * Provides:
 * - Session-scoped embedding cache (avoids re-embedding identical queries per session)
 * - AbortController for cooperative cancellation of in-flight operations
 * - Query log for context enrichment across turns
 * - Global session registry for HTTP transport (keyed by sessionId)
 *
 * Architecture note: The reference implementation (claude-code) uses a class-based
 * QueryEngine that owns the full session lifecycle. KINDX's MCP server was stateless
 * per-request closures. This module bridges that gap without breaking the existing
 * MCP tool handler API surface.
 */

import { getDefaultLLM, formatQueryForEmbedding } from "./inference.js";
import type { EmbeddingResult } from "./inference.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Memory scope context forwarded from MCP initialize request.
 * Mirrors the shape used in protocol.ts — defined here to avoid circular imports.
 */
export type SessionScopeContext = {
  sessionScope?: string;
  workspaceScope?: string;
  workspaceUri?: string;
};

/**
 * A single query turn log entry for context enrichment.
 */
export type QueryLogEntry = {
  query: string;
  ts: number; // Unix ms timestamp
};

// =============================================================================
// KindxSession
// =============================================================================

/**
 * Per-connection session that manages:
 * - Embedding cache keyed by `(isQuery|doc):text` — avoids LLM round-trips for
 *   identical queries within the same session.
 * - AbortController propagated to all long-running operations (embed, rerank,
 *   vector search). Call `session.abort()` to cancel in-flight work on disconnect.
 * - Query log: records every query text for potential future enrichment.
 * - Scope context resolved from MCP initialize metadata.
 */
export class KindxSession {
  /** Monotonically-increasing ID generated at construction time. */
  readonly sessionId: string;

  /** Resolved scope context from MCP initialize (workspaceScope, sessionScope). */
  readonly scopeContext: SessionScopeContext;

  /** AbortController for cooperative cancellation across all session operations. */
  private readonly _abortController: AbortController;

  /**
   * Session-scoped embedding cache.
   * Key: `q:<text>` for queries, `d:<text>` for documents.
   * Value: embedding vector (number[]).
   *
   * This avoids re-embedding identical queries within a session.
   * Cache is unbounded per-session; the session itself is bounded by connection lifetime.
   */
  private readonly _embeddingCache = new Map<string, number[]>();

  /**
   * Query log for context enrichment.
   * Stores the last N query texts that were executed in this session.
   */
  private readonly _queryLog: QueryLogEntry[] = [];
  private static readonly QUERY_LOG_MAX = 20;

  /** Timestamp when this session was constructed. */
  readonly createdAt: number;

  /** Whether this session has been explicitly aborted. */
  private _aborted = false;

  constructor(scopeContext: SessionScopeContext = {}) {
    this.sessionId = generateSessionId();
    this.scopeContext = scopeContext;
    this._abortController = new AbortController();
    this.createdAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  /** Abort all in-flight operations bound to this session. */
  abort(): void {
    this._aborted = true;
    this._abortController.abort();
  }

  /** AbortSignal that fires when the session is aborted. */
  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  /** Whether this session has been aborted. */
  get isAborted(): boolean {
    return this._aborted;
  }

  // ---------------------------------------------------------------------------
  // Embedding cache
  // ---------------------------------------------------------------------------

  /**
   * Get or compute a session-cached embedding.
   *
   * On cache hit: returns the cached vector without touching the LLM.
   * On cache miss: calls the LLM, populates the cache, and returns the vector.
   *
   * @param text - Raw text to embed (before task prefix formatting)
   * @param isQuery - true for query-side embedding, false for document-side
   * @returns Embedding vector, or null if the LLM failed
   */
  async cachedEmbed(text: string, isQuery: boolean = true): Promise<number[] | null> {
    const cacheKey = `${isQuery ? "q" : "d"}:${text}`;
    const cached = this._embeddingCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const llm = getDefaultLLM();
    let result: EmbeddingResult | null = null;
    try {
      const formatted = isQuery ? formatQueryForEmbedding(text) : text;
      result = await llm.embed(formatted);
    } catch (err) {
      process.stderr.write(
        `[KindxSession] embed failed for session ${this.sessionId}: ${err}\n`
      );
      return null;
    }

    if (result?.embedding) {
      this._embeddingCache.set(cacheKey, result.embedding);
      return result.embedding;
    }
    return null;
  }

  /**
   * Return a pre-cached embedding if present, without computing.
   * Useful for checking before making an LLM call.
   */
  getCachedEmbedding(text: string, isQuery: boolean = true): number[] | null {
    return this._embeddingCache.get(`${isQuery ? "q" : "d"}:${text}`) ?? null;
  }

  /** Number of entries currently in the embedding cache. */
  get embeddingCacheSize(): number {
    return this._embeddingCache.size;
  }

  // ---------------------------------------------------------------------------
  // Query log
  // ---------------------------------------------------------------------------

  /**
   * Record a query text in the session's query log.
   * Oldest entries are evicted when the log reaches QUERY_LOG_MAX.
   */
  logQuery(query: string): void {
    this._queryLog.push({ query, ts: Date.now() });
    if (this._queryLog.length > KindxSession.QUERY_LOG_MAX) {
      this._queryLog.shift();
    }
  }

  /**
   * Recent query texts in this session, newest last.
   */
  get queryLog(): readonly QueryLogEntry[] {
    return this._queryLog;
  }

  /**
   * The most recent query executed in this session, or null if none.
   */
  get lastQuery(): string | null {
    return this._queryLog[this._queryLog.length - 1]?.query ?? null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Release session resources.
   * After calling dispose(), the session should not be used again.
   */
  dispose(): void {
    if (!this._aborted) {
      this.abort();
    }
    this._embeddingCache.clear();
    this._queryLog.length = 0;
    SessionRegistry.delete(this.sessionId);
  }
}

// =============================================================================
// Session Registry
// =============================================================================

/**
 * Global session registry for HTTP transport.
 *
 * The MCP HTTP transport creates one session per client connection (keyed by the
 * `mcp-session-id` header value). This registry maps session IDs to KindxSession
 * instances, enabling tool handlers to access per-session state (embedding cache,
 * abort signal) without changing their function signatures.
 *
 * Usage in HTTP transport:
 *   SessionRegistry.create(sessionId, scopeContext)
 *   SessionRegistry.get(sessionId)
 *   SessionRegistry.delete(sessionId)
 */
export const SessionRegistry = {
  _sessions: new Map<string, KindxSession>(),

  /**
   * Create and register a new session.
   * If a session with the same ID already exists, it is replaced.
   */
  create(sessionId: string, scopeContext: SessionScopeContext = {}): KindxSession {
    const existing = this._sessions.get(sessionId);
    if (existing) {
      existing.dispose();
    }
    // Use a KindxSession that reports the caller's sessionId (not a new generated one)
    const session = new _KindxSessionWithId(sessionId, scopeContext);
    this._sessions.set(sessionId, session);
    return session;
  },

  /**
   * Get an existing session by ID.
   * Returns null if the session does not exist.
   */
  get(sessionId: string): KindxSession | null {
    return this._sessions.get(sessionId) ?? null;
  },

  /**
   * Remove a session from the registry (does NOT call dispose).
   * Use session.dispose() to fully clean up and then remove.
   */
  delete(sessionId: string): void {
    this._sessions.delete(sessionId);
  },

  /** Active session count. */
  get size(): number {
    return this._sessions.size;
  },

  /** Dispose all sessions (call on server shutdown). */
  async disposeAll(): Promise<void> {
    for (const session of this._sessions.values()) {
      session.dispose();
    }
    this._sessions.clear();
  },
};

// =============================================================================
// Utility
// =============================================================================

function generateSessionId(): string {
  // Use crypto.randomUUID if available (Node 16.7+), otherwise fallback.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Internal: KindxSession subclass that accepts a pre-determined sessionId
 * (used by SessionRegistry.create to preserve the caller-provided ID).
 */
class _KindxSessionWithId extends KindxSession {
  constructor(id: string, scopeContext: SessionScopeContext) {
    super(scopeContext);
    // Override the auto-generated sessionId with the caller's id.
    (this as any).sessionId = id;
  }
}
