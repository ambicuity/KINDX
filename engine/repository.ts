/**
 * KINDX Repository - Core data access and retrieval functions
 *
 * This module provides all database operations, search functions, and document
 * retrieval for kindx. It returns raw data structures that can be formatted by
 * CLI or MCP consumers.
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
 */

// W1 decomposition — symbols progressively move into ./repository/.
// The barrel re-exports below preserve the public surface during migration.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5
export * from "./repository/index.js";

import { openDatabase } from "./runtime.js";
import {
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  type BreakPoint,
  type CodeFenceRegion
} from "./chunker.js";
import type { Database } from "./runtime.js";
import picomatch from "picomatch";
import { resolve as pathResolve, relative } from "path";
import {
  formatQueryForEmbedding,
  formatDocForEmbedding,
  type RerankOptions,
  type ILLMSession,
} from "./inference.js";
import {
  getCollection,
  listCollections as collectionsListCollections,
  loadConfig as collectionsLoadConfig,
  type NamedCollection,
} from "./catalogs.js";
// SessionRegistry import removed — signal now propagated via options.signal
import { ensureEncryptedIndexReady, ensureEncryptedShardIndexesReady } from "./encryption.js";
import { quietWarn, errString } from "./utils/quiet-warn.js";

export { scanBreakPoints, findCodeFences, isInsideCodeFence, findBestCutoff };
export type { BreakPoint, CodeFenceRegion };

// =============================================================================
// Configuration
// =============================================================================

// HOME constant moved to engine/repository/paths.ts (W1 C2).
export const DEFAULT_EMBED_MODEL = "embeddinggemma";
export const DEFAULT_RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-Q8_0";
export const DEFAULT_QUERY_MODEL = "Qwen/Qwen3-1.7B";
export const DEFAULT_GLOB = "**/*.md";
export const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024; // 10KB

export function getCollectionShardCount(collectionName?: string): number {
  if (!collectionName) return 1;
  const cfg = getCollection(collectionName) as (NamedCollection & { shard_count?: number }) | null;
  const raw = Number(cfg?.shard_count ?? 1);
  return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) : 1;
}

// getCollectionRerankSettings moved to engine/repository/rerank-queue.ts (W1 C13).

// Chunking logic extracted to engine/chunker.ts

// Hybrid query: strong BM25 signal detection thresholds
// Skip expensive LLM expansion when top result is strong AND clearly separated from runner-up
export const STRONG_SIGNAL_MIN_SCORE = 0.85;
export const STRONG_SIGNAL_MIN_GAP = 0.15;
// Max candidates to pass to reranker — balances quality vs latency.
// 40 keeps rank 31-40 visible to the reranker (matters for recall on broad queries).
export const RERANK_CANDIDATE_LIMIT = 40;

/**
 * A typed query expansion result. Decoupled from inference.ts internal Queryable —
 * same shape, but repository.ts owns its own public API type.
 *
 * - lex: keyword variant → routes to FTS only
 * - vec: semantic variant → routes to vector only
 * - hyde: hypothetical document → routes to vector only
 */
// ExpandedQuery moved to engine/repository/types.ts (W1 C4).

// =============================================================================
// Path utilities — moved to engine/repository/paths.ts (W1 C2)
// =============================================================================
// All path symbols now re-exported via the barrel at the top of this file.
// Imported back here for internal use:
import { getDefaultDbPath } from "./repository/paths.js";
import { getCacheKey, getCachedResult, setCachedResult, clearCache, deleteLLMCache } from "./repository/llm-cache.js";
import { searchVec } from "./repository/vec.js";
import { getHashesForEmbedding, clearAllEmbeddings, insertEmbedding, bulkInsertEmbeddings } from "./repository/embeddings.js";
import { initializeDatabase, ensureVecTableInternal } from "./repository/store-init.js";
import { getHashesNeedingEmbedding, getIndexHealth, vacuumDatabase } from "./repository/store-maintenance.js";
import { getDocid } from "./repository/handelize.js";
import { findDocumentByDocid, findSimilarFiles } from "./repository/docid.js";
import { expandQuery } from "./repository/retrieval/expansion.js";
import { rerank } from "./repository/retrieval/rerank.js";
import {
  findDocument,
  getDocumentBody,
  findDocuments,
  getStatus,
} from "./repository/retrieval/document-lookup.js";
import { buildFTS5Query } from "./repository/fts.js";
import {
  getCollectionByName,
} from "./repository/collections.js";
import {
  getContextForPath,
  getCollectionsWithoutContext,
  getTopLevelPathsWithoutContext,
} from "./repository/context-annotations.js";
import {
  deleteInactiveDocuments,
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  insertContent,
  insertDocument,
  findActiveDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
} from "./repository/content.js";
import { indexSingleFile, unlinkSingleFile } from "./repository/indexing.js";
import type {
  ExpandedQuery,
  DocumentResult,
  SearchResult,
  DocumentNotFound,
  MultiGetResult,
  IndexStatus,
  IndexHealthInfo,
} from "./repository/types.js";

// =============================================================================
// Virtual Path Utilities (kindx://)
// =============================================================================

export type VirtualPath = {
  collectionName: string;
  path: string;  // relative path within collection
};

/**
 * Normalize explicit virtual path formats to standard kindx:// format.
 * Only handles paths that are already explicitly virtual:
 * - kindx://collection/path.md (already normalized)
 * - kindx:////collection/path.md (extra slashes - normalize)
 * - //collection/path.md (missing kindx: prefix - add it)
 *
 * Does NOT handle:
 * - collection/path.md (bare paths - could be filesystem relative)
 * - :linenum suffix (should be parsed separately before calling this)
 */
export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  // Handle kindx:// with extra slashes: kindx:////collection/path -> kindx://collection/path
  if (path.startsWith('kindx:')) {
    // Remove kindx: prefix and normalize slashes
    path = path.slice(6);
    // Remove leading slashes and re-add exactly two
    path = path.replace(/^\/+/, '');
    return `kindx://${path}`;
  }

  // Handle //collection/path (missing kindx: prefix)
  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `kindx://${path}`;
  }

  // Return as-is for other cases (filesystem paths, docids, bare collection/path, etc.)
  return path;
}

/**
 * Parse a virtual path like "kindx://collection-name/path/to/file.md"
 * into its components.
 * Also supports collection root: "kindx://collection-name/" or "kindx://collection-name"
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  // Normalize the path first
  const normalized = normalizeVirtualPath(virtualPath);

  // Match: kindx://collection-name[/optional-path]
  // Allows: kindx://name, kindx://name/, kindx://name/path
  const match = normalized.match(/^kindx:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  return {
    collectionName: match[1],
    path: match[2] ?? '',  // Empty string for collection root
  };
}

/**
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string): string {
  return `kindx://${collectionName}/${path}`;
}

/**
 * Check if a path is explicitly a virtual path.
 * Only recognizes explicit virtual path formats:
 * - kindx://collection/path.md
 * - //collection/path.md
 *
 * Does NOT consider bare collection/path.md as virtual - that should be
 * handled separately by checking if the first component is a collection name.
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  // Explicit kindx:// prefix (with any number of slashes)
  if (trimmed.startsWith('kindx:')) return true;

  // //collection/path format (missing kindx: prefix)
  if (trimmed.startsWith('//')) return true;

  return false;
}

/**
 * Resolve a virtual path to absolute filesystem path.
 *
 * Tier-1: refuse paths that escape the collection root via `..` segments.
 * Without this guard, a virtual path like `kindx://docs/../../../etc/passwd`
 * resolved to `/etc/passwd` and downstream code (multi-get, get) read
 * arbitrary files outside the indexed collection.
 */
export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getCollectionByName(db, parsed.collectionName);
  if (!coll) return null;

  const absolute = pathResolve(coll.pwd, parsed.path);
  // assertUnderRoot semantics inline (kept inline to avoid a new import in
  // the hot retrieval path): return null on traversal so callers fall
  // through their existing not-found handling.
  const rel = relative(coll.pwd, absolute);
  if (rel.startsWith("..") || rel === "" || /^([A-Za-z]:)?[\\/]/.test(rel)) {
    if (absolute === coll.pwd) return absolute;
    return null;
  }
  return absolute;
}

/**
 * Convert an absolute filesystem path to a virtual path.
 * Returns null if the file is not in any indexed collection.
 */
export function toVirtualPath(db: Database, absolutePath: string): string | null {
  // Get all collections from YAML config
  const collections = collectionsListCollections();

  // Find which collection this absolute path belongs to
  for (const coll of collections) {
    if (absolutePath.startsWith(coll.path + '/') || absolutePath === coll.path) {
      // Extract relative path
      const relativePath = absolutePath.startsWith(coll.path + '/')
        ? absolutePath.slice(coll.path.length + 1)
        : '';

      // Verify this document exists in the database
      const doc = db.prepare(`
        SELECT d.path
        FROM documents d
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
        LIMIT 1
      `).get(coll.name, relativePath) as { path: string } | null;

      if (doc) {
        return buildVirtualPath(coll.name, relativePath);
      }
    }
  }

  return null;
}

// Database init (initializeDatabase, ensureVectorIndexIntegrity,
// verifySqliteVecLoaded, isSqliteVecAvailable, ensureVecTableInternal)
// moved to engine/repository/store-init.ts (W1 C3).

// =============================================================================
// Store Factory
// =============================================================================

export type Store = {
  db: Database;
  dbPath: string;
  indexName: string;
  close: () => void;
  ensureVecTable: (dimensions: number) => void;

  // Index health
  getHashesNeedingEmbedding: () => number;
  getIndexHealth: () => IndexHealthInfo;
  getStatus: () => IndexStatus;

  // Caching
  getCacheKey: typeof getCacheKey;
  getCachedResult: (cacheKey: string) => string | null;
  setCachedResult: (cacheKey: string, result: string) => void;
  clearCache: () => void;

  // Cleanup and maintenance
  deleteLLMCache: () => number;
  deleteInactiveDocuments: () => number;
  cleanupOrphanedContent: () => number;
  cleanupOrphanedVectors: () => number;
  vacuumDatabase: () => void;

  // Context
  getContextForFile: (filepath: string) => string | null;
  getContextForPath: (collectionName: string, path: string) => string | null;
  getCollectionByName: (name: string) => { name: string; pwd: string; glob_pattern: string } | null;
  getCollectionsWithoutContext: () => { name: string; pwd: string; doc_count: number }[];
  getTopLevelPathsWithoutContext: (collectionName: string) => string[];

  // Virtual paths
  parseVirtualPath: typeof parseVirtualPath;
  buildVirtualPath: typeof buildVirtualPath;
  isVirtualPath: typeof isVirtualPath;
  resolveVirtualPath: (virtualPath: string) => string | null;
  toVirtualPath: (absolutePath: string) => string | null;

  // Search
  searchFTS: (query: string, limit?: number, collectionName?: string) => SearchResult[];
  searchVec: (
    query: string,
    model: string,
    limit?: number,
    collectionName?: string,
    session?: ILLMSession,
    precomputedEmbedding?: number[],
    diagnostics?: { onWarning?: (warning: string) => void }
  ) => Promise<SearchResult[]>;

  // Query expansion & reranking
  expandQuery: (query: string, model?: string) => Promise<ExpandedQuery[]>;
  rerank: (
    query: string,
    documents: { file: string; text: string }[],
    model?: string,
    options?: RerankOptions
  ) => Promise<{ file: string; score: number }[]>;

  // Document retrieval
  findDocument: (filename: string, options?: { includeBody?: boolean }) => DocumentResult | DocumentNotFound;
  getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => string | null;
  findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => { docs: MultiGetResult[]; errors: string[] };

  // Fuzzy matching and docid lookup
  findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => string[];
  matchFilesByGlob: (pattern: string) => { filepath: string; displayPath: string; bodyLength: number }[];
  findDocumentByDocid: (docid: string) => { filepath: string; hash: string } | null;

  // Document indexing operations
  insertContent: (hash: string, content: string, createdAt: string) => void;
  insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => void;
  findActiveDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => void;
  updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => void;
  deactivateDocument: (collectionName: string, path: string) => void;
  getActiveDocumentPaths: (collectionName: string) => string[];

  // Vector/embedding operations
  getHashesForEmbedding: () => { hash: string; body: string; path: string }[];
  clearAllEmbeddings: () => void;
  insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => void;
  bulkInsertEmbeddings: (embeddings: ReadonlyArray<{ hash: string; seq: number; pos: number; embedding: Float32Array; model: string; embeddedAt: string }>) => void;

  // Watcher integrations
  indexSingleFile: (collectionName: string, relativePath: string, absolutePath: string) => Promise<"embedded" | "unchanged" | "failed">;
  unlinkSingleFile: (collectionName: string, relativePath: string) => Promise<boolean>;
};

/**
 * Create a new store instance with the given database path.
 * If no path is provided, uses the default path (~/.cache/kindx/index.sqlite).
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Store instance with all methods bound to the database
 */
export function createStore(dbPath?: string, indexName?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath(indexName || "index");
  ensureEncryptedIndexReady(resolvedPath);
  ensureEncryptedShardIndexesReady(resolvedPath);
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);

  return {
    db,
    dbPath: resolvedPath,
    indexName: indexName || "index",
    close: () => db.close(),
    ensureVecTable: (dimensions: number) => ensureVecTableInternal(db, dimensions),

    // Index health
    getHashesNeedingEmbedding: () => getHashesNeedingEmbedding(db),
    getIndexHealth: () => getIndexHealth(db),
    getStatus: () => getStatus(db),

    // Caching
    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    // Cleanup and maintenance
    deleteLLMCache: () => deleteLLMCache(db),
    deleteInactiveDocuments: () => deleteInactiveDocuments(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    cleanupOrphanedVectors: () => cleanupOrphanedVectors(db),
    vacuumDatabase: () => vacuumDatabase(db),

    // Context
    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    // Virtual paths
    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    // Search
    searchFTS: (query: string, limit?: number, collectionName?: string) => searchFTS(db, query, limit, collectionName),
    searchVec: (
      query: string,
      model: string,
      limit?: number,
      collectionName?: string,
      session?: ILLMSession,
      precomputedEmbedding?: number[],
      diagnostics?: { onWarning?: (warning: string) => void }
    ) => searchVec(db, query, model, limit, collectionName, session, precomputedEmbedding, diagnostics),

    // Query expansion & reranking
    expandQuery: (query: string, model?: string) => expandQuery(query, model, db),
    rerank: (
      query: string,
      documents: { file: string; text: string }[],
      model?: string,
      options?: RerankOptions
    ) => rerank(query, documents, model, db, options),

    // Watcher integrations
    indexSingleFile: (collectionName: string, relativePath: string, absolutePath: string) => indexSingleFile(db, collectionName, relativePath, absolutePath),
    unlinkSingleFile: (collectionName: string, relativePath: string) => unlinkSingleFile(db, collectionName, relativePath),

    // Document retrieval
    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    // Fuzzy matching and docid lookup
    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    // Document indexing operations
    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string) => deactivateDocument(db, collectionName, path),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),

    // Vector/embedding operations
    getHashesForEmbedding: () => getHashesForEmbedding(db),
    clearAllEmbeddings: () => clearAllEmbeddings(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt),
    bulkInsertEmbeddings: (embeddings: ReadonlyArray<{ hash: string; seq: number; pos: number; embedding: Float32Array; model: string; embeddedAt: string }>) => bulkInsertEmbeddings(db, embeddings),
  };
}

export function createStoreForIndex(indexName: string): Store {
  return createStore(undefined, indexName);
}

export interface FederatedMatch {
  _index: string;
  docid: string;
  file: string;
  title?: string;
  score: number;
  context?: string;
  snippet?: string;
}

export interface FederatedResult {
  matches: FederatedMatch[];
  indexes_queried: string[];
  indexes_skipped: string[];
}

function runIndexQuery(
  indexName: string,
  queryText: string,
  limit: number = 10,
): { matches: Array<{ docid: string; displayPath: string; title?: string; score: number; context?: string; snippet?: string }> } {
  const store = createStoreForIndex(indexName);
  try {
    const ftsMatches = store.searchFTS(queryText, limit * 2);
    const matches = ftsMatches.slice(0, limit).map(m => ({
      docid: m.docid,
      displayPath: m.displayPath,
      title: m.title || "",
      score: m.score,
      context: m.context || "",
      snippet: m.body || "",
    }));
    return { matches };
  } finally {
    store.close();
  }
}

export function federatedQuery(
  indexes: string[],
  queryText: string,
  options: { limit?: number } = {},
): FederatedResult {
  const allMatches: Array<{ index: string; match: any }> = [];
  const skipped: string[] = [];
  const limit = options.limit ?? 10;

  for (const indexName of indexes) {
    try {
      const { matches } = runIndexQuery(indexName, queryText, limit);
      for (const m of matches) {
        allMatches.push({ index: indexName, match: m });
      }
    } catch (e) {
      quietWarn("federated_query.index_skipped", { index: indexName, err: errString(e) });
      skipped.push(indexName);
    }
  }

  const seen = new Map<string, { match: any; index: string; score: number }>();
  for (const { index, match } of allMatches) {
    const key = match.docid;
    const existing = seen.get(key);
    if (!existing || match.score > existing.score) {
      seen.set(key, { match, index, score: match.score });
    }
  }

  const merged = Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    matches: merged.map(({ match, index }) => ({
      _index: index,
      docid: match.docid,
      file: match.displayPath,
      title: match.title,
      score: Math.round(match.score * 100) / 100,
      context: match.context,
      snippet: match.snippet,
    })),
    indexes_queried: indexes.filter(i => !skipped.includes(i)),
    indexes_skipped: skipped,
  };
}

// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Unified document result type with all metadata.
 * Body is optional - use getDocumentBody() to load it separately if needed.
 */
// DocumentResult moved to engine/repository/types.ts (W1 C4).

// getDocid, handelize, emojiToHex moved to engine/repository/handelize.ts (W1 C3).

// SearchResult, RankedResult, RRFContributionTrace, RRFScoreTrace, HybridQueryExplain,
// DocumentNotFound, MultiGetResult, CollectionInfo, IndexStatus moved to
// engine/repository/types.ts (W1 C4).

// =============================================================================
// Index health
// =============================================================================

// getHashesNeedingEmbedding, getIndexHealth moved to engine/repository/store-maintenance.ts (W1 C3).

// =============================================================================
// Caching / LLM cache — moved to engine/repository/llm-cache.ts (W1 C12)
// =============================================================================

// =============================================================================
// Cleanup and maintenance operations
// =============================================================================

// deleteInactiveDocuments, cleanupOrphanedContent, cleanupOrphanedVectors
// moved to engine/repository/content.ts (W1 C5).

// vacuumDatabase, walCheckpointTruncate, cleanupSqliteSidecars moved to engine/repository/store-maintenance.ts (W1 C3).

// hashContent, extractTitle, insertContent, insertDocument, upsertDocumentIngestion,
// upsertDocumentLinks, getLinkedDocuments, getBacklinkedDocuments moved to
// engine/repository/content.ts (W1 C5).
// getGraphConnectedCandidates stays here because it depends on parseVirtualPath
// which has not yet been extracted.

export function getGraphConnectedCandidates(db: Database, virtualPaths: string[]): any[] {
  // Tier-1 perf: collapse the per-path N+1 into a single grouped query per
  // collection. The previous loop ran the full 4-subquery prepared statement
  // ONCE PER input path (50 inputs = 50 round trips). We now bucket the
  // input paths by collection and execute one IN-clause query per bucket,
  // chunked at 500 to stay well below SQLITE_MAX_VARIABLE_NUMBER.

  // Bucket the inputs: collection -> Set<path>.
  const byCollection = new Map<string, Set<string>>();
  for (const vp of virtualPaths) {
    const p = parseVirtualPath(vp);
    if (!p) continue;
    let bucket = byCollection.get(p.collectionName);
    if (!bucket) {
      bucket = new Set();
      byCollection.set(p.collectionName, bucket);
    }
    bucket.add(p.path);
  }

  const result: any[] = [];
  // Dedupe: a connected candidate may be reachable from multiple seeds.
  const seen = new Set<string>();

  const CHUNK = 500;
  for (const [collection, pathSet] of byCollection) {
    const paths = [...pathSet];
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = db.prepare(`
        SELECT DISTINCT d.collection, d.path, d.title, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.active = 1 AND (
          d.path IN (
            SELECT target_path FROM document_links
            WHERE collection = ? AND source_path IN (${placeholders})
          )
          OR
          d.path IN (
            SELECT source_path FROM document_links
            WHERE collection = ? AND target_path IN (${placeholders})
          )
        )
      `);
      const rows = stmt.all(collection, collection, ...chunk, collection, ...chunk) as any[];
      for (const r of rows) {
        const key = `${r.collection}/${r.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          file: `kindx://${r.collection}/${r.path}`,
          displayPath: key,
          title: r.title,
          body: r.body,
          score: 0.1, // Base expansion score
        });
      }
    }
  }
  return result;
}

// getIndexCapabilities moved to engine/repository/store-maintenance.ts (W1 C3).

// findActiveDocument, updateDocumentTitle, updateDocument, deactivateDocument,
// getActiveDocumentPaths moved to engine/repository/content.ts (W1 C5).

export { formatQueryForEmbedding, formatDocForEmbedding };

// Chunking moved to engine/repository/chunking.ts (W1 C6).

// =============================================================================
// Fuzzy matching
// =============================================================================

// Docid utilities moved to engine/repository/docid.ts (W1 C7).

export function matchFilesByGlob(db: Database, pattern: string): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db.prepare(`
    SELECT
      'kindx://' || d.collection || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { virtual_path: string; body_length: number; path: string; collection: string }[];

  const isMatch = picomatch(pattern);
  const cwd = process.cwd();

  const results: { filepath: string; displayPath: string; bodyLength: number }[] = [];

  for (const f of allFiles) {
    // 1. Check against virtual path or generic database path
    if (isMatch(f.virtual_path) || isMatch(f.path)) {
      results.push({
        filepath: f.virtual_path,
        displayPath: f.path,
        bodyLength: f.body_length
      });
      continue;
    }

    // 2. Check against the real filesystem layout
    const coll = getCollectionByName(db, f.collection);
    // If the path evaluates to the actual workspace via relative evaluation
    if (coll) {
      const physicalPath = pathResolve(coll.pwd, f.path);
      const relativePathToCwd = relative(cwd, physicalPath);

      if (isMatch(physicalPath) || isMatch(relativePathToCwd) || (relativePathToCwd.startsWith('..') === false && isMatch(`./${relativePathToCwd}`))) {
        results.push({
          filepath: f.virtual_path,
          displayPath: f.path,
          bodyLength: f.body_length
        });
      }
    }
  }

  return results;
}

// =============================================================================
// Context
// =============================================================================

/**
 * Get context for a file path using hierarchical inheritance.
 * Contexts are collection-scoped and inherit from parent directories.
 * For example, context at "/talks" applies to "/talks/2024/keynote.md".
 *
 * @param db Database instance (unused - kept for compatibility)
 * @param collectionName Collection name
 * @param path Relative path within the collection
 * @returns Context string or null if no context is defined
 */
// getContextForPath moved to engine/repository/context-annotations.ts (W1 C8).

/**
 * Get context for a file path (virtual or filesystem).
 * Resolves the collection and relative path using the YAML collections config.
 */
export function getContextForFile(db: Database, filepath: string): string | null {
  // Handle undefined or null filepath
  if (!filepath) return null;

  // Get all collections from YAML config
  const collections = collectionsListCollections();
  const config = collectionsLoadConfig();

  // Parse virtual path format: kindx://collection/path
  let collectionName: string | null = null;
  let relativePath: string | null = null;

  const parsedVirtual = filepath.startsWith('kindx://') ? parseVirtualPath(filepath) : null;
  if (parsedVirtual) {
    collectionName = parsedVirtual.collectionName;
    relativePath = parsedVirtual.path;
  } else {
    // Filesystem path: find which collection this absolute path belongs to
    for (const coll of collections) {
      // Skip collections with missing paths
      if (!coll || !coll.path) continue;

      if (filepath.startsWith(coll.path + '/') || filepath === coll.path) {
        collectionName = coll.name;
        // Extract relative path
        relativePath = filepath.startsWith(coll.path + '/')
          ? filepath.slice(coll.path.length + 1)
          : '';
        break;
      }
    }

    if (!collectionName || relativePath === null) return null;
  }

  // Get the collection from config
  const coll = getCollection(collectionName);
  if (!coll) return null;

  // Verify this document exists in the database
  const doc = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
    LIMIT 1
  `).get(collectionName, relativePath) as { path: string } | null;

  if (!doc) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  if (config.global_context) {
    contexts.push(config.global_context);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

// Collection helpers moved to engine/repository/collections.ts (W1 C9).

// =============================================================================
// Context Management Operations
// =============================================================================

// Context annotation helpers (insertContext, deleteContext, deleteGlobalContexts,
// listPathContexts, getCollectionsWithoutContext, getTopLevelPathsWithoutContext)
// moved to engine/repository/context-annotations.ts (W1 C8).
// getContextForFile stays here because it depends on parseVirtualPath which is
// still defined in this file.

// =============================================================================
// FTS Search
// =============================================================================

// FTS query construction + validators moved to engine/repository/fts.ts (W1 C10).
// searchFTS stays here until SearchResult, getDocid, and getContextForFile
// move in their respective clusters.

export function searchFTS(db: Database, query: string, limit: number = 20, collectionName?: string): SearchResult[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  let sql = `
    SELECT
      'kindx://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      d.modified_at,
      content.doc as body,
      d.hash,
      bm25(documents_fts, 10.0, 1.0) as bm25_score
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    JOIN content ON content.hash = d.hash
    WHERE documents_fts MATCH ? AND d.active = 1
  `;
  const params: (string | number)[] = [ftsQuery];

  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(String(collectionName));
  }

  // bm25 lower is better; sort ascending.
  sql += ` ORDER BY bm25_score ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as { filepath: string; display_path: string; title: string; modified_at: string; body: string; hash: string; bm25_score: number }[];
  return rows.map(row => {
    const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
    // Convert bm25 (negative, lower is better) into a stable [0..1) score where higher is better.
    // FTS5 BM25 scores are negative (e.g., -10 is strong, -2 is weak).
    // |x| / (1 + |x|) maps: strong(-10)→0.91, medium(-2)→0.67, weak(-0.5)→0.33, none(0)→0.
    // Monotonic and query-independent — no per-query normalization needed.
    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    return {
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName,
      modifiedAt: row.modified_at,
      bodyLength: row.body.length,
      body: row.body,
      context: getContextForFile(db, row.filepath),
      score,
      source: "fts" as const,
    };
  });
}

// Vector search (searchVec, mapVectorMatchesToDocuments, getMainDatabasePath)
// moved to engine/repository/vec.ts (W1 C11a).

// Embedding storage (getEmbedding, getHashesForEmbedding, clearAllEmbeddings,
// getInsertEmbeddingStmts, insertEmbedding, getBulkInsertTxn, bulkInsertEmbeddings)
// moved to engine/repository/embeddings.ts (W1 C11b).

// =============================================================================
// Query expansion
// =============================================================================

// expandQuery moved to engine/repository/retrieval/expansion.ts (W1 C14).

// =============================================================================
// Reranking
// =============================================================================

// rerank moved to engine/repository/retrieval/rerank.ts (W1 C14).

// =============================================================================
// Reciprocal Rank Fusion
// =============================================================================

// reciprocalRankFusion, buildRrfTrace, RankedListMeta moved to engine/repository/retrieval/rrf.ts (W1 C14).

// =============================================================================
// Document retrieval
// =============================================================================

// hasDocumentIngestTable, findDocument, getDocumentBody, findDocuments, getStatus,
// extractSnippet, addLineNumbers, withTimeout moved to
// engine/repository/retrieval/document-lookup.ts (W1 C14).

// Rerank queue moved to engine/repository/rerank-queue.ts (W1 C13).
// Types and functions are now re-exported via the barrel; internal callers
// import from "./repository/rerank-queue.js" at the top of this file.

// =============================================================================
// Shared search orchestration
//
// hybridQuery() and vectorSearchQuery() are standalone functions (not Store
// methods) because they are orchestration over primitives — same rationale as
// reciprocalRankFusion(). They take a Store as first argument so both CLI
// and MCP can share the identical pipeline.
// =============================================================================

// hybridQuery (+ SearchHooks, HybridQueryOptions, HybridQueryResult, StructuredSearchDiagnostics)
// moved to engine/repository/retrieval/hybrid.ts (W1 C14b).
// vectorSearchQuery (+ VectorSearchOptions, VectorSearchResult)
// moved to engine/repository/retrieval/vector-query.ts (W1 C14b).
// structuredSearch, structuredSearchWithDiagnostics (+ StructuredSubSearch,
// StructuredSearchOptions, StructuredSearchWithDiagnosticsResult)
// moved to engine/repository/retrieval/structured.ts (W1 C14b).

// =============================================================================
// Watcher Integrations
// =============================================================================

// indexSingleFile and unlinkSingleFile moved to engine/repository/indexing.ts (W1 C15).
