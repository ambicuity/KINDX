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

import { openDatabase, loadSqliteVec } from "./runtime.js";
import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  type BreakPoint,
  type CodeFenceRegion
} from "./chunker.js";
import type { Database } from "./runtime.js";
import picomatch from "picomatch";
import { createHash } from "crypto";
import { dirname, resolve as pathResolve, relative, join } from "path";
import { existsSync, realpathSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { ingestFile } from "./ingestion.js";
import {
  LLM,
  getDefaultLLM,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  type RerankDocument,
  type RerankOptions,
  type ILLMSession,
} from "./inference.js";
import {
  findContextForPath as collectionsFindContextForPath,
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  listAllContexts as collectionsListAllContexts,
  getCollection,
  listCollections as collectionsListCollections,
  addCollection as collectionsAddCollection,
  removeCollection as collectionsRemoveCollection,
  renameCollection as collectionsRenameCollection,
  setGlobalContext,
  loadConfig as collectionsLoadConfig,
  type NamedCollection,
} from "./catalogs.js";
// SessionRegistry import removed — signal now propagated via options.signal
import { initializeCoreSchema } from "./schema.js";
import { describeEncryptionState, ensureEncryptedIndexReady, ensureEncryptedShardIndexesReady } from "./encryption.js";
import {
  getShardRuntimeStatus,
  getAnnRuntimeStatus,
  searchShardedVectorsWithDiagnostics,
} from "./sharding.js";
import { recordDirectUsage } from "./ai-usage.js";
import { quietWarn, errString } from "./utils/quiet-warn.js";
import { extractInternalLinks } from "./link-extractor.js";

export { scanBreakPoints, findCodeFences, isInsideCodeFence, findBestCutoff };
export type { BreakPoint, CodeFenceRegion };

// =============================================================================
// Configuration
// =============================================================================

const HOME = process.env.HOME || "/tmp";
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
import { resolve, homedir, getPwd, getRealPath, getDefaultDbPath } from "./repository/paths.js";
import { getCacheKey, getCachedResult, setCachedResult, clearCache, deleteLLMCache } from "./repository/llm-cache.js";
import { searchVec, getMainDatabasePath } from "./repository/vec.js";
import { getEmbedding, getHashesForEmbedding, clearAllEmbeddings, insertEmbedding, bulkInsertEmbeddings } from "./repository/embeddings.js";
import { initializeDatabase, ensureVecTableInternal, isSqliteVecAvailable } from "./repository/store-init.js";
import { getHashesNeedingEmbedding, getIndexHealth, vacuumDatabase, getIndexCapabilities } from "./repository/store-maintenance.js";
import { getDocid } from "./repository/handelize.js";
import { isDocid, findDocumentByDocid, findSimilarFiles } from "./repository/docid.js";
import { expandQuery } from "./repository/retrieval/expansion.js";
import { rerank } from "./repository/retrieval/rerank.js";
import { reciprocalRankFusion, buildRrfTrace, type RankedListMeta } from "./repository/retrieval/rrf.js";
import {
  findDocument,
  getDocumentBody,
  findDocuments,
  getStatus,
  extractSnippet,
  addLineNumbers,
  withTimeout,
} from "./repository/retrieval/document-lookup.js";
import {
  type RerankQueueConfig,
  type RerankQueueSnapshot,
  type RerankDropPolicy,
  acquireRerankSlot,
  getRerankQueueSnapshot,
  getCollectionRerankSettings,
  parsePositiveInt,
  runWithConcurrencyLimit,
} from "./repository/rerank-queue.js";
import { chunkDocument, chunkDocumentByTokens } from "./repository/chunking.js";
import { sanitizeFTS5Term, buildFTS5Query, validateLexQuery, validateSemanticQuery } from "./repository/fts.js";
import {
  getCollectionByName,
  listCollections,
  removeCollection,
  renameCollection,
  getAllCollections,
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
  extractTitle,
  insertContent,
  insertDocument,
  upsertDocumentIngestion,
  upsertDocumentLinks,
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
  RankedResult,
  RRFContributionTrace,
  RRFScoreTrace,
  HybridQueryExplain,
  DocumentNotFound,
  MultiGetResult,
  CollectionInfo,
  IndexStatus,
  IndexHealthInfo,
  SnippetResult,
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
export function createStore(dbPath?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  ensureEncryptedIndexReady(resolvedPath);
  ensureEncryptedShardIndexesReady(resolvedPath);
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);

  return {
    db,
    dbPath: resolvedPath,
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

/**
 * Optional progress hooks for search orchestration.
 * CLI wires these to stderr for user feedback; MCP leaves them unset.
 */
export interface SearchHooks {
  /** BM25 probe found strong signal — expansion will be skipped */
  onStrongSignal?: (topScore: number) => void;
  /** Query expansion starting */
  onExpandStart?: () => void;
  /** Query expansion complete. Empty array = strong signal skip. elapsedMs = time taken. */
  onExpand?: (original: string, expanded: ExpandedQuery[], elapsedMs: number) => void;
  /** Embedding starting (vec/hyde queries) */
  onEmbedStart?: (count: number) => void;
  /** Embedding complete */
  onEmbedDone?: (elapsedMs: number) => void;
  /** Retrieval pipeline complete (before rerank) */
  onRetrievalDone?: (elapsedMs: number) => void;
  /** Rerank context initialization complete */
  onRerankInitDone?: (elapsedMs: number) => void;
  /** Reranking is about to start */
  onRerankStart?: (chunkCount: number) => void;
  /** Reranking finished */
  onRerankDone?: (elapsedMs: number) => void;
  /** Retrieval degraded mode triggered with machine-readable reason */
  onDegradedMode?: (reason: string) => void;
}

export type SearchRoutingProfile = "fast" | "balanced" | "max_precision";

export interface StructuredSearchDiagnostics {
  degradedMode: boolean;
  fallbackReasons: string[];
  scaleWarnings: string[];
  routingProfile: SearchRoutingProfile;
  candidateLimit: number;
  rerankLimit: number;
  rerankApplied: number;
  planner: {
    policy: {
      precedence: ["candidateLimit", "maxRerankCandidates", "rerankLimit"];
      routingProfile: SearchRoutingProfile;
      vectorFanoutWorkers: number;
    };
    appliedLimits: {
      requestedCandidateLimit: number;
      maxRerankCandidates: number | null;
      candidateLimit: number;
      requestedRerankLimit: number;
      rerankLimit: number;
    };
    degradedReasons: string[];
  };
  ann: {
    route: "ann" | "exact_fallback" | "n/a";
    state: "ready" | "stale" | "missing" | "degraded" | "n/a";
  };
  staleFiles: string[];
  throughput: {
    queue: {
      depth: number;
      active: number;
      limit: number | null;
      concurrency: number;
      dropPolicy: RerankDropPolicy;
      saturated: boolean;
      deferred: boolean;
      fairness: {
        enqueued: number;
        dequeued: number;
        immediateServed: number;
        deferredServed: number;
        timedOut: number;
        saturated: number;
        lastServedSeq: number | null;
      };
    };
  };
}

export interface HybridQueryOptions {
  collection?: string;
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  maxRerankCandidates?: number; // optional hard ceiling for rerank candidates
  rerankTimeoutMs?: number; // optional rerank timeout budget
  explain?: boolean;        // include backend/RRF/rerank score traces
  hooks?: SearchHooks;
  signal?: AbortSignal;
}

export interface HybridQueryResult {
  file: string;             // internal filepath (kindx://collection/path)
  displayPath: string;
  title: string;
  body: string;             // full document body (for snippet extraction)
  bestChunk: string;        // best chunk text
  bestChunkPos: number;     // char offset of best chunk in body
  score: number;            // blended score (full precision)
  context: string | null;   // user-set context
  docid: string;            // content hash prefix (6 chars)
  explain?: HybridQueryExplain;
}

// RankedListMeta moved to engine/repository/retrieval/rrf.ts (W1 C14).

/**
 * Hybrid search: BM25 + vector + query expansion + RRF + chunked reranking.
 *
 * Pipeline:
 * 1. BM25 probe → skip expansion if strong signal
 * 2. expandQuery() → typed query variants (lex/vec/hyde)
 * 3. Type-routed search: original→vector, lex→FTS, vec/hyde→vector
 * 4. RRF fusion → slice to candidateLimit
 * 5. chunkDocument() + keyword-best-chunk selection
 * 6. rerank on chunks (NOT full bodies — O(tokens) trap)
 * 7. Position-aware score blending (RRF rank × reranker score)
 * 8. Dedup by file, filter by minScore, slice to limit
 */
export async function hybridQuery(
  store: Store,
  query: string,
  options?: HybridQueryOptions
): Promise<HybridQueryResult[]> {
  const retrievalStart = Date.now();
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const collectionSettings = getCollectionRerankSettings(options?.collection);
  const requestedCandidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;
  const maxRerankCandidates = options?.maxRerankCandidates ?? collectionSettings.maxCandidates;
  const candidateLimit = maxRerankCandidates
    ? Math.min(requestedCandidateLimit, Math.max(1, maxRerankCandidates))
    : requestedCandidateLimit;
  const rerankTimeoutMs = options?.rerankTimeoutMs ?? collectionSettings.timeoutMs;
  const collection = options?.collection;
  const explain = options?.explain ?? false;
  const hooks = options?.hooks;

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>(); // filepath -> docid
  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();

  // Step 1: BM25 probe — strong signal skips expensive LLM expansion
  // Pass collection directly into FTS query (filter at SQL level, not post-hoc)
  const initialFts = store.searchFTS(query, 20, collection);
  const topScore = initialFts[0]?.score ?? 0;
  const secondScore = initialFts[1]?.score ?? 0;
  const hasStrongSignal = initialFts.length > 0
    && topScore >= STRONG_SIGNAL_MIN_SCORE
    && (topScore - secondScore) >= STRONG_SIGNAL_MIN_GAP;

  if (hasStrongSignal) hooks?.onStrongSignal?.(topScore);

  // Step 2: Expand query (or skip if strong signal)
  hooks?.onExpandStart?.();
  const expandStart = Date.now();
  const expanded = hasStrongSignal
    ? []
    : await store.expandQuery(query);

  hooks?.onExpand?.(query, expanded, Date.now() - expandStart);

  // Seed with initial FTS results (avoid re-running original query FTS)
  if (initialFts.length > 0) {
    for (const r of initialFts) docidMap.set(r.filepath, r.docid);
    rankedLists.push(initialFts.map(r => ({
      file: r.filepath, displayPath: r.displayPath,
      title: r.title, body: r.body || "", score: r.score,
    })));
    rankedListMeta.push({ source: "fts", queryType: "original", query });
  }

  // Step 3: Route searches by query type
  //
  // Strategy: run all FTS queries immediately (they're sync/instant), then
  // batch-embed all vector queries in one embedBatch() call, then run
  // sqlite-vec lookups with pre-computed embeddings.

  // 3a: Run FTS for all lex expansions right away (no LLM needed)
  for (const q of expanded) {
    if (q.type === 'lex') {
      const ftsResults = store.searchFTS(q.text, 20, collection);
      if (ftsResults.length > 0) {
        for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(ftsResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({ source: "fts", queryType: "lex", query: q.text });
      }
    }
  }

  // 3b: Collect all texts that need vector search (original query + vec/hyde expansions)
  if (hasVectors) {
    const vecQueries: { text: string; queryType: "original" | "vec" | "hyde" }[] = [
      { text: query, queryType: "original" },
    ];
    for (const q of expanded) {
      if (q.type === 'vec' || q.type === 'hyde') {
        vecQueries.push({ text: q.text, queryType: q.type });
      }
    }

    // Batch embed all vector queries in a single call
    const llm = getDefaultLLM();
    const textsToEmbed = vecQueries.map(q => formatQueryForEmbedding(q.text));
    hooks?.onEmbedStart?.(textsToEmbed.length);
    const embedStart = Date.now();
    let embeddings: Awaited<ReturnType<typeof llm.embedBatch>>;
    try {
      embeddings = await llm.embedBatch(textsToEmbed, { signal: options?.signal });
    } catch (err) {
      process.stderr.write(
        `KINDX Warning: embedBatch failed during hybridQuery, falling back to FTS-only results. ${err}\n`
      );
      embeddings = textsToEmbed.map(() => null);
    }
    hooks?.onEmbedDone?.(Date.now() - embedStart);

    // Run sqlite-vec lookups with pre-computed embeddings
    for (let i = 0; i < vecQueries.length; i++) {
      const embedding = embeddings[i]?.embedding;
      if (!embedding) continue;

      const vecResults = await store.searchVec(
        vecQueries[i]!.text, DEFAULT_EMBED_MODEL, 20, collection,
        undefined, embedding,
        {
          onWarning: (warning) => hooks?.onDegradedMode?.(warning),
        }
      );
      if (vecResults.length > 0) {
        for (const r of vecResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(vecResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({
          source: "vec",
          queryType: vecQueries[i]!.queryType,
          query: vecQueries[i]!.text,
        });
      }
    }
  }

  // Step 4: RRF fusion — first 2 lists (original FTS + first vec) get 2x weight
  const weights = rankedLists.map((_, i) => i < 2 ? 2.0 : 1.0);
  const fused = reciprocalRankFusion(rankedLists, weights);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];

  // Step 5: Chunk documents, pick best chunk per doc for reranking.
  // Reranking full bodies is O(tokens) — the critical perf lesson that motivated this refactor.
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const chunksToRerank: { file: string; text: string }[] = [];
  const docChunkMap = new Map<string, { chunks: { text: string; pos: number }[]; bestIdx: number }>();

  for (const cand of candidates) {
    const chunks = chunkDocument(cand.body);
    if (chunks.length === 0) continue;

    // Pick chunk with most keyword overlap (fallback: first chunk)
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < chunks.length; i++) {
      const chunkLower = chunks[i]!.text.toLowerCase();
      const score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    chunksToRerank.push({ file: cand.file, text: chunks[bestIdx]!.text });
    docChunkMap.set(cand.file, { chunks, bestIdx });
  }

  hooks?.onRetrievalDone?.(Date.now() - retrievalStart);

  // Step 6: Rerank chunks (NOT full bodies)
  hooks?.onRerankStart?.(chunksToRerank.length);
  const rerankStart = Date.now();
  const timed = await withTimeout(
    store.rerank(
      query,
      chunksToRerank,
      undefined,
      {
        onRerankInit: (elapsedMs) => hooks?.onRerankInitDone?.(elapsedMs),
      }
    ),
    rerankTimeoutMs
  );
  const reranked = timed.timedOut || !timed.value
    ? candidates.map((cand, idx) => ({ file: cand.file, score: cand.score, index: idx }))
    : timed.value;
  if (timed.timedOut) {
    hooks?.onDegradedMode?.("rerank_timeout");
  }
  hooks?.onRerankDone?.(Date.now() - rerankStart);

  // Step 7: Blend RRF position score with reranker score
  // Position-aware weights: top retrieval results get more protection from reranker disagreement
  const candidateMap = new Map(candidates.map(c => [c.file, {
    displayPath: c.displayPath, title: c.title, body: c.body,
  }]));
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || candidateLimit;
    let rrfWeight: number;
    if (rrfRank <= 3) rrfWeight = 0.75;
    else if (rrfRank <= 10) rrfWeight = 0.60;
    else rrfWeight = 0.40;

    // Replace severe 1/rank penalty with a softer exponential decay.
    // Rank 1 = 1.0, Rank 2 = 0.83, Rank 3 = 0.69, Rank 4 = 0.57 ...
    const rrfScore = Math.max(0.01, Math.exp(-(rrfRank - 1) / 5.5));
    const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * r.score;

    const candidate = candidateMap.get(r.file);
    const chunkInfo = docChunkMap.get(r.file);
    const bestIdx = chunkInfo?.bestIdx ?? 0;
    const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
    const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
    const trace = rrfTraceByFile?.get(r.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: rrfWeight,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore: r.score,
      blendedScore,
    } : undefined;

    return {
      file: r.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk,
      bestChunkPos,
      score: blendedScore,
      context: store.getContextForFile(r.file),
      docid: docidMap.get(r.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => (b.score - a.score) || a.file.localeCompare(b.file));

  // Step 8: Dedup by file (safety net — prevents duplicate output)
  const seenFiles = new Set<string>();
  return blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}

export interface VectorSearchOptions {
  collection?: string;
  limit?: number;           // default 10
  minScore?: number;        // default 0.3
  hooks?: Pick<SearchHooks, 'onExpand'>;
}

export interface VectorSearchResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context: string | null;
  docid: string;
}

/**
 * Vector-only semantic search with query expansion.
 *
 * Pipeline:
 * 1. expandQuery() → typed variants, filter to vec/hyde only (lex irrelevant here)
 * 2. searchVec() for original + vec/hyde variants (sequential — node-llama-cpp embed limitation)
 * 3. Dedup by filepath (keep max score)
 * 4. Sort by score descending, filter by minScore, slice to limit
 */
export async function vectorSearchQuery(
  store: Store,
  query: string,
  options?: VectorSearchOptions
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0.3;
  const collection = options?.collection;

  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();
  if (!hasVectors) return [];

  // Expand query — filter to vec/hyde only (lex queries target FTS, not vector)
  const expandStart = Date.now();
  const allExpanded = await store.expandQuery(query);
  const vecExpanded = allExpanded.filter(q => q.type !== 'lex');
  options?.hooks?.onExpand?.(query, vecExpanded, Date.now() - expandStart);

  // Run original + vec/hyde expanded through vector, sequentially — concurrent embed() hangs
  const queryTexts = [query, ...vecExpanded.map(q => q.text)];
  const allResults = new Map<string, VectorSearchResult>();
  for (const q of queryTexts) {
    const vecResults = await store.searchVec(q, DEFAULT_EMBED_MODEL, limit, collection);
    for (const r of vecResults) {
      const existing = allResults.get(r.filepath);
      if (!existing || r.score > existing.score) {
        allResults.set(r.filepath, {
          file: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: r.body || "",
          score: r.score,
          context: store.getContextForFile(r.filepath),
          docid: r.docid,
        });
      }
    }
  }

  return Array.from(allResults.values())
    .sort((a, b) => (b.score - a.score) || a.file.localeCompare(b.file))
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}

// =============================================================================
// Structured search — pre-expanded queries from LLM
// =============================================================================

/**
 * A single sub-search in a structured search request.
 * Matches the format used in KINDX training data.
 */
export interface StructuredSubSearch {
  /** Search type: 'lex' for BM25, 'vec' for semantic, 'hyde' for hypothetical */
  type: 'lex' | 'vec' | 'hyde';
  /** The search query text */
  query: string;
  /** Optional line number for error reporting (CLI parser) */
  line?: number;
}

export interface StructuredSearchOptions {
  collections?: string[];   // Filter to specific collections (OR match)
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  maxRerankCandidates?: number; // optional hard ceiling for rerank candidates
  rerankTimeoutMs?: number; // optional rerank timeout budget
  rerankLimit?: number;     // default candidateLimit
  rerankQueueLimit?: number; // optional queue cap override
  rerankConcurrency?: number; // optional rerank worker cap override
  rerankDropPolicy?: RerankDropPolicy; // queue behavior override
  vectorFanoutWorkers?: number; // bounded vec fanout worker cap
  disableRerank?: boolean;  // default false
  explain?: boolean;        // include backend/RRF/rerank score traces
  routingProfile?: SearchRoutingProfile; // default balanced
  intent?: string;
  hooks?: SearchHooks;
  signal?: AbortSignal;
}

export type StructuredSearchWithDiagnosticsResult = {
  results: HybridQueryResult[];
  diagnostics: StructuredSearchDiagnostics;
};

/**
 * Structured search: execute pre-expanded queries without LLM query expansion.
 *
 * Designed for LLM callers (MCP/HTTP) that generate their own query expansions.
 * Skips the internal expandQuery() step — goes directly to:
 *
 * Pipeline:
 * 1. Route searches: lex→FTS, vec/hyde→vector (batch embed)
 * 2. RRF fusion across all result lists
 * 3. Chunk documents + keyword-best-chunk selection
 * 4. Rerank on chunks
 * 5. Position-aware score blending
 * 6. Dedup, filter, slice
 *
 * This is the recommended endpoint for capable LLMs — they can generate
 * better query variations than our small local model, especially for
 * domain-specific or nuanced queries.
 */
export async function structuredSearch(
  store: Store,
  searches: StructuredSubSearch[],
  options?: StructuredSearchOptions
): Promise<HybridQueryResult[]> {
  const withDiagnostics = await structuredSearchWithDiagnostics(store, searches, options);
  return withDiagnostics.results;
}

export async function structuredSearchWithDiagnostics(
  store: Store,
  searches: StructuredSubSearch[],
  options?: StructuredSearchOptions
): Promise<StructuredSearchWithDiagnosticsResult> {
  const retrievalStart = Date.now();
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const firstCollection = options?.collections?.length === 1 ? options.collections[0] : undefined;
  const collectionSettings = getCollectionRerankSettings(firstCollection);
  const envMaxRerankCandidates = parsePositiveInt(process.env.KINDX_MAX_RERANK_CANDIDATES);
  const envRerankTimeoutMs = parsePositiveInt(process.env.KINDX_RERANK_TIMEOUT_MS);
  const envRerankQueueLimit = parsePositiveInt(process.env.KINDX_RERANK_QUEUE_LIMIT);
  const envRerankConcurrency = parsePositiveInt(process.env.KINDX_RERANK_CONCURRENCY);
  const envVectorFanoutWorkers = parsePositiveInt(process.env.KINDX_VECTOR_FANOUT_WORKERS);
  const envDropPolicyRaw = String(process.env.KINDX_RERANK_DROP_POLICY ?? "").trim().toLowerCase();
  const envDropPolicy = envDropPolicyRaw === "wait" ? "wait" : envDropPolicyRaw === "timeout_fallback" ? "timeout_fallback" : undefined;
  const requestedCandidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;
  const maxRerankCandidates = options?.maxRerankCandidates
    ?? envMaxRerankCandidates
    ?? collectionSettings.maxCandidates;
  const candidateLimit = maxRerankCandidates
    ? Math.min(requestedCandidateLimit, Math.max(1, maxRerankCandidates))
    : requestedCandidateLimit;
  const requestedRerankLimit = options?.rerankLimit ?? candidateLimit;
  const rerankLimit = Math.max(0, Math.min(requestedRerankLimit, candidateLimit));
  const rerankTimeoutMs = options?.rerankTimeoutMs ?? envRerankTimeoutMs ?? collectionSettings.timeoutMs;
  const rerankQueueLimit = options?.rerankQueueLimit ?? envRerankQueueLimit ?? collectionSettings.queueLimit ?? null;
  const rerankConcurrency = options?.rerankConcurrency ?? envRerankConcurrency ?? collectionSettings.concurrency ?? 1;
  const rerankDropPolicy = options?.rerankDropPolicy ?? envDropPolicy ?? collectionSettings.dropPolicy ?? "timeout_fallback";
  const vectorFanoutWorkers = options?.vectorFanoutWorkers ?? envVectorFanoutWorkers ?? collectionSettings.vectorFanoutWorkers ?? 4;
  const disableRerank = options?.disableRerank ?? false;
  const explain = options?.explain ?? false;
  const routingProfile = options?.routingProfile ?? "balanced";
  const hooks = options?.hooks;
  const collections = options?.collections;
  const queueKey = collections && collections.length > 0
    ? `collections:${[...collections].sort().join(",")}`
    : (firstCollection ?? "__global__");
  const queueConfig: RerankQueueConfig = {
    key: queueKey,
    concurrency: Math.max(1, rerankConcurrency),
    queueLimit: rerankQueueLimit,
    dropPolicy: rerankDropPolicy as RerankDropPolicy,
  };
  const initialQueueSnapshot = getRerankQueueSnapshot(queueConfig);
  const fallbackReasons: string[] = [];
  const scaleWarnings: string[] = [];
  const plannerDegradedReasons: string[] = [];
  const queueState = {
    depth: initialQueueSnapshot.depth,
    active: initialQueueSnapshot.active,
    limit: initialQueueSnapshot.limit,
    concurrency: initialQueueSnapshot.concurrency,
    dropPolicy: initialQueueSnapshot.dropPolicy,
    saturated: false,
    deferred: false,
    fairness: initialQueueSnapshot.fairness,
  };
  const staleFiles: string[] = [];
  const mapScaleWarningToFallbackReason = (warning: string): string | undefined => {
    if (warning.startsWith("ann_missing:")) {
      return "ann_missing";
    }
    if (warning.startsWith("ann_stale:")) {
      return "ann_stale";
    }
    if (warning.startsWith("ann_failed:")) {
      return "ann_failed";
    }
    if (warning.startsWith("shard_missing:") || warning.startsWith("shard_root_missing:") || warning.startsWith("shard_read_missing:")) {
      return "shard_missing";
    }
    if (warning.startsWith("shard_read_failed:") || warning.startsWith("shard_read_vec_unavailable:") || warning.startsWith("shard_read_no_vectors_table:")) {
      return "shard_read_failed";
    }
    if (warning.startsWith("shard_write_failed:") || warning.startsWith("shard_write_handle_missing:")) {
      return "shard_write_failed";
    }
    if (warning.startsWith("topology_drift:")) {
      return "shard_topology_drift";
    }
    if (warning.startsWith("resume_cursor_invalid:")) {
      return "shard_resume_cursor_invalid";
    }
    if (warning.startsWith("checkpoint_")) {
      return "shard_checkpoint_invalid";
    }
    if (warning.startsWith("candidate_limit_clamped:") || warning.startsWith("rerank_limit_clamped:")) {
      return "rerank_truncated";
    }
    return undefined;
  };
  const markDegraded = (reason: string): void => {
    if (!fallbackReasons.includes(reason)) {
      fallbackReasons.push(reason);
      hooks?.onDegradedMode?.(reason);
    }
    if (!plannerDegradedReasons.includes(reason)) {
      plannerDegradedReasons.push(reason);
    }
  };
  const buildDiagnostics = (rerankApplied: number): StructuredSearchDiagnostics => ({
    ann: (() => {
      const hasSharded = scaleWarnings.some((w) => w.startsWith("sharded_collection:"));
      if (!hasSharded) {
        return { route: "n/a" as const, state: "n/a" as const };
      }
      if (scaleWarnings.some((w) => w.startsWith("ann_failed:"))) {
        return { route: "exact_fallback" as const, state: "degraded" as const };
      }
      if (scaleWarnings.some((w) => w.startsWith("ann_stale:"))) {
        return { route: "exact_fallback" as const, state: "stale" as const };
      }
      if (scaleWarnings.some((w) => w.startsWith("ann_missing:"))) {
        return { route: "exact_fallback" as const, state: "missing" as const };
      }
      return { route: "ann" as const, state: "ready" as const };
    })(),
    degradedMode: fallbackReasons.length > 0,
    fallbackReasons,
    scaleWarnings,
    routingProfile,
    candidateLimit,
    rerankLimit,
    rerankApplied,
    planner: {
      policy: {
        precedence: ["candidateLimit", "maxRerankCandidates", "rerankLimit"],
        routingProfile,
        vectorFanoutWorkers: Math.max(1, vectorFanoutWorkers),
      },
      appliedLimits: {
        requestedCandidateLimit,
        maxRerankCandidates: maxRerankCandidates ?? null,
        candidateLimit,
        requestedRerankLimit,
        rerankLimit,
      },
      degradedReasons: plannerDegradedReasons,
    },
    staleFiles,
    throughput: {
      queue: queueState,
    },
  });
  if (maxRerankCandidates && requestedCandidateLimit > candidateLimit) {
    scaleWarnings.push(`candidate_limit_clamped:${requestedCandidateLimit}->${candidateLimit}`);
    markDegraded("rerank_truncated");
  }
  if (requestedRerankLimit > rerankLimit) {
    scaleWarnings.push(`rerank_limit_clamped:${requestedRerankLimit}->${rerankLimit}`);
    markDegraded("rerank_truncated");
  }

  if (searches.length === 0) {
    return {
      results: [],
      diagnostics: buildDiagnostics(0),
    };
  }

  // Validate queries before executing
  for (const search of searches) {
    const location = search.line ? `Line ${search.line}` : 'Structured search';
    if (/[\r\n]/.test(search.query)) {
      throw new Error(`${location} (${search.type}): queries must be single-line. Remove newline characters.`);
    }
    if (search.type === 'lex') {
      const error = validateLexQuery(search.query);
      if (error) {
        throw new Error(`${location} (lex): ${error}`);
      }
    } else if (search.type === 'vec' || search.type === 'hyde') {
      const error = validateSemanticQuery(search.query);
      if (error) {
        throw new Error(`${location} (${search.type}): ${error}`);
      }
    }
  }

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>(); // filepath -> docid
  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();

  // Helper to run search across collections (or all if undefined)
  const collectionList = collections ?? [undefined]; // undefined = all collections
  if (collections && collections.length > 0) {
    const shardStatus = getShardRuntimeStatus(getMainDatabasePath(store.db));
    const configuredShardCollections = new Set(shardStatus.enabledCollections.map((c) => c.collection));
    for (const coll of collections) {
      if (configuredShardCollections.has(coll)) {
        scaleWarnings.push(`sharded_collection:${coll}`);
      }
    }
    for (const warn of shardStatus.warnings) {
      scaleWarnings.push(warn);
      markDegraded(mapScaleWarningToFallbackReason(warn) ?? "shard_runtime_warning");
    }
  }

  // Step 1: Run FTS for all lex searches (sync, instant)
  for (const search of searches) {
    if (search.type === 'lex') {
      for (const coll of collectionList) {
        const ftsResults = store.searchFTS(search.query, 20, coll);
        if (ftsResults.length > 0) {
          for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
          rankedLists.push(ftsResults.map(r => ({
            file: r.filepath, displayPath: r.displayPath,
            title: r.title, body: r.body || "", score: r.score,
            modifiedAt: r.modifiedAt,
          })));
          rankedListMeta.push({
            source: "fts",
            queryType: "lex",
            query: search.query,
          });
        }
      }
    }
  }

  // Step 2: Batch embed and run vector searches for vec/hyde
  if (hasVectors) {
    const vecSearches = searches.filter(
      (s): s is StructuredSubSearch & { type: 'vec' | 'hyde' } =>
        s.type === 'vec' || s.type === 'hyde'
    );
    if (vecSearches.length > 0) {
      const llm = getDefaultLLM();
      const textsToEmbed = vecSearches.map(s => formatQueryForEmbedding(s.query));
      hooks?.onEmbedStart?.(textsToEmbed.length);
      const embedStart = Date.now();
      let embeddings: Awaited<ReturnType<typeof llm.embedBatch>>;
      try {
        embeddings = await llm.embedBatch(textsToEmbed, { signal: options?.signal });
      } catch (err) {
        process.stderr.write(
          `KINDX Warning: embedBatch failed during structuredSearch, falling back to FTS-only results. ${err}\n`
        );
        markDegraded("embed_batch_failed");
        embeddings = vecSearches.map(() => null);
      }
      hooks?.onEmbedDone?.(Date.now() - embedStart);

      // Parallel fan-out: search across (embedding × collection) pairs concurrently.
      // sqlite-vec reads are CPU-bound and non-blocking; parallelising them here
      // gives near-linear speedup with multiple collections.
      //
      // Guardrail: collect fan-out results first, then flush into rankedLists in a
      // stable deterministic order so concurrent completion timing cannot reorder
      // result-list precedence across repeated identical requests.
      type VecFanOutItem = {
        queryIdx: number;
        collIdx: number;
        queryType: "vec" | "hyde";
        query: string;
        vecResults: Awaited<ReturnType<Store["searchVec"]>>;
      };
      const vecFanOutTasks: Array<() => Promise<VecFanOutItem>> = [];

      for (let i = 0; i < vecSearches.length; i++) {
        const embedding = embeddings[i]?.embedding;
        if (!embedding) continue;
        const searchEntry = vecSearches[i]!;

        for (let collIdx = 0; collIdx < collectionList.length; collIdx++) {
          const coll = collectionList[collIdx];
          vecFanOutTasks.push(async () => {
            try {
              const vecResults = await store.searchVec(
                searchEntry.query,
                DEFAULT_EMBED_MODEL,
                20,
                coll,
                undefined,
                embedding,
                {
                  onWarning: (warning) => {
                    scaleWarnings.push(warning);
                    markDegraded(mapScaleWarningToFallbackReason(warning) ?? "vector_search_partial_failure");
                  },
                }
              );
              return {
                queryIdx: i,
                collIdx,
                queryType: searchEntry.type,
                query: searchEntry.query,
                vecResults,
              } as VecFanOutItem;
            } catch (err) {
              process.stderr.write(
                `KINDX Warning: vector search failed for collection=${coll ?? "all"}, query="${searchEntry.query}": ${err}\n`
              );
              markDegraded("vector_search_partial_failure");
              return {
                queryIdx: i,
                collIdx,
                queryType: searchEntry.type,
                query: searchEntry.query,
                vecResults: [],
              } as VecFanOutItem;
            }
          });
        }
      }

      // Wait for all collection fan-out tasks to complete before proceeding to RRF.
      const vecFanOutResults = await runWithConcurrencyLimit(vecFanOutTasks, Math.max(1, vectorFanoutWorkers));
      if (vecFanOutResults.length !== vecFanOutTasks.length) {
        process.stderr.write(
          `KINDX Warning: vector fan-out task mismatch (expected ${vecFanOutTasks.length}, got ${vecFanOutResults.length}).\n`
        );
      }

      // Stable ordering: first by query index, then by collection index.
      vecFanOutResults
        .sort((a, b) => (a.queryIdx - b.queryIdx) || (a.collIdx - b.collIdx))
        .forEach(item => {
          if (item.vecResults.length === 0) return;
          for (const r of item.vecResults) docidMap.set(r.filepath, r.docid);
          rankedLists.push(item.vecResults.map(r => ({
            file: r.filepath, displayPath: r.displayPath,
            title: r.title, body: r.body || "", score: r.score,
            modifiedAt: r.modifiedAt,
          })));
          rankedListMeta.push({
            source: "vec",
            queryType: item.queryType,
            query: item.query,
          });
        });
    }
  }

  if (rankedLists.length === 0) {
    return {
      results: [],
      diagnostics: buildDiagnostics(0),
    };
  }

  // Step 3: RRF fusion — first list gets 2x weight (assume caller ordered by importance)
  const weights = rankedLists.map((_, i) => i === 0 ? 2.0 : 1.0);
  const fused = reciprocalRankFusion(rankedLists, weights);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidates = fused.slice(0, candidateLimit);

  // Step 3.5: Graph-Augmented Recall Expansion (Connectivity Boosting)
  const existingFiles = new Set(candidates.map(c => c.file));
  const candidatePaths = candidates.map(c => c.file);
  const connected = getGraphConnectedCandidates(store.db, candidatePaths);
  for (const conn of connected) {
    if (!existingFiles.has(conn.file)) {
       existingFiles.add(conn.file);
       candidates.push({ ...conn, score: conn.score });
    }
  }

  if (candidates.length === 0) {
    return {
      results: [],
      diagnostics: buildDiagnostics(0),
    };
  }

  hooks?.onExpand?.("", [], 0); // Signal no expansion (pre-expanded)

  // Step 4: Chunk documents, pick best chunk per doc for reranking
  // Use first lex query as the "query" for keyword matching, or first vec if no lex
  const primaryQuery = searches.find(s => s.type === 'lex')?.query
    || searches.find(s => s.type === 'vec')?.query
    || searches[0]?.query || "";
  const queryTerms = primaryQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const chunksToRerank: { file: string; text: string }[] = [];
  const docChunkMap = new Map<string, { chunks: { text: string; pos: number }[]; bestIdx: number }>();

  for (const cand of candidates) {
    const chunks = chunkDocument(cand.body);
    if (chunks.length === 0) continue;

    // Pick chunk with most keyword overlap
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < chunks.length; i++) {
      const chunkLower = chunks[i]!.text.toLowerCase();
      const score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    chunksToRerank.push({ file: cand.file, text: chunks[bestIdx]!.text });
    docChunkMap.set(cand.file, { chunks, bestIdx });
  }

  hooks?.onRetrievalDone?.(Date.now() - retrievalStart);

  // Step 5: Rerank chunks
  let reranked: { file: string; score: number }[] = [];
  if (disableRerank || rerankLimit <= 0) {
    markDegraded("rerank_skipped");
    const fallback = candidates.slice(0, rerankLimit > 0 ? rerankLimit : candidates.length);
    reranked = fallback.map((cand, idx) => ({ file: cand.file, score: cand.score, index: idx }));
  } else {
    hooks?.onRerankStart?.(Math.min(chunksToRerank.length, rerankLimit));
    const rerankStart2 = Date.now();
    try {
      const rerankInput = chunksToRerank.slice(0, rerankLimit);
      const queued = await acquireRerankSlot(queueConfig, rerankTimeoutMs);
      if (queued.saturated) {
        markDegraded("rerank_queue_saturated");
        queueState.saturated = true;
        scaleWarnings.push(`rerank_queue_saturated:${queueConfig.queueLimit ?? "unbounded"}`);
        const saturatedSnapshot = getRerankQueueSnapshot(queueConfig);
        queueState.depth = saturatedSnapshot.depth;
        queueState.active = saturatedSnapshot.active;
        queueState.fairness = saturatedSnapshot.fairness;
        const fallback = candidates.slice(0, rerankLimit);
        reranked = fallback.map((cand, idx) => ({ file: cand.file, score: cand.score, index: idx }));
      } else if (queued.timedOut) {
        markDegraded("rerank_timeout");
        queueState.deferred = true;
        scaleWarnings.push(`rerank_timeout_ms:${rerankTimeoutMs ?? 0}`);
        const timeoutSnapshot = getRerankQueueSnapshot(queueConfig);
        queueState.depth = timeoutSnapshot.depth;
        queueState.active = timeoutSnapshot.active;
        queueState.fairness = timeoutSnapshot.fairness;
        const fallback = candidates.slice(0, rerankLimit);
        reranked = fallback.map((cand, idx) => ({ file: cand.file, score: cand.score, index: idx }));
      } else {
        if (queued.deferred) {
          markDegraded("rerank_deferred");
          queueState.deferred = true;
        }
        const inFlightSnapshot = getRerankQueueSnapshot(queueConfig);
        queueState.depth = inFlightSnapshot.depth;
        queueState.active = inFlightSnapshot.active;
        queueState.fairness = inFlightSnapshot.fairness;
        try {
          const rerankTask = store.rerank(
            primaryQuery,
            rerankInput,
            undefined,
            {
              onRerankInit: (elapsedMs) => hooks?.onRerankInitDone?.(elapsedMs),
            }
          );
          const timed = await withTimeout(rerankTask, rerankTimeoutMs);
          if (timed.timedOut || !timed.value) {
            markDegraded("rerank_timeout");
            scaleWarnings.push(`rerank_timeout_ms:${rerankTimeoutMs ?? 0}`);
            const fallback = candidates.slice(0, rerankLimit);
            reranked = fallback.map((cand, idx) => ({ file: cand.file, score: cand.score, index: idx }));
          } else {
            reranked = timed.value
              .slice()
              .sort((a, b) => (b.score - a.score) || a.file.localeCompare(b.file));
          }
        } finally {
          queued.release?.();
        }
      }
      hooks?.onRerankDone?.(Date.now() - rerankStart2);
    } catch (err) {
      process.stderr.write(`KINDX Warning: rerank failed during structuredSearch, falling back to retrieval-only scoring. ${err}\n`);
      markDegraded("rerank_failed");
      const fallback = candidates.slice(0, rerankLimit);
      reranked = fallback.map((cand, idx) => ({ file: cand.file, score: cand.score, index: idx }));
      hooks?.onRerankDone?.(Date.now() - rerankStart2);
    }
  }

  // Step 6: Blend RRF position score with reranker score
  const candidateMap = new Map(candidates.map(c => [c.file, {
    displayPath: c.displayPath, title: c.title, body: c.body, modifiedAt: c.modifiedAt,
  }]));
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || candidateLimit;
    let rrfWeight: number;
    if (rrfRank <= 3) rrfWeight = 0.75;
    else if (rrfRank <= 10) rrfWeight = 0.60;
    else rrfWeight = 0.40;

    // Replace severe 1/rank penalty with a softer exponential decay.
    // Rank 1 = 1.0, Rank 2 = 0.83, Rank 3 = 0.69, Rank 4 = 0.57 ...
    const rrfScore = Math.max(0.01, Math.exp(-(rrfRank - 1) / 5.5));
    const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * r.score;

    const candidate = candidateMap.get(r.file);
    const chunkInfo = docChunkMap.get(r.file);
    const bestIdx = chunkInfo?.bestIdx ?? 0;
    const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
    const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
    const trace = rrfTraceByFile?.get(r.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: rrfWeight,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore: r.score,
      blendedScore,
    } : undefined;

    return {
      file: r.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk,
      bestChunkPos,
      score: blendedScore,
      context: store.getContextForFile(r.file),
      docid: docidMap.get(r.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => (b.score - a.score) || a.file.localeCompare(b.file));

  // Step 7: Dedup by file and filter
  const seenFiles = new Set<string>();
  let results = blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => r.score >= minScore)
    .slice(0, limit);

  // Step 8: Detect stale files among the returned results
  for (const res of results) {
    const candidate = candidateMap.get(res.file);
    if (!candidate?.modifiedAt) continue;
    try {
      if (res.file.startsWith("kindx://")) {
        const parts = res.file.slice("kindx://".length).split('/');
        const colName = parts[0];
        const relativePath = parts.slice(1).join('/');
        const collSettings = getCollection(colName || "");
        if (collSettings?.path) {
          const absolutePath = join(collSettings.path, relativePath);
          const stat = statSync(absolutePath);
          // sqlite stores ISO strings. We can directly compare them if they're both ISO format.
          // statSync.mtime.toISOString() could be newer than candidate.modifiedAt
          const diskMtime = stat.mtime.getTime();
          const dbMtime = new Date(candidate.modifiedAt).getTime();
          // We allow 1000ms drift to account for precision differences
          if (diskMtime > dbMtime + 1000) {
            staleFiles.push(res.file);
          }
        }
      }
    } catch (err) {
      // ignore stat errors (e.g., file deleted) - we could consider them stale or missing
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        staleFiles.push(res.file);
      }
    }
  }

  const finalQueueSnapshot = getRerankQueueSnapshot(queueConfig);
  queueState.depth = finalQueueSnapshot.depth;
  queueState.active = finalQueueSnapshot.active;
  queueState.fairness = finalQueueSnapshot.fairness;
  return {
    results,
    diagnostics: buildDiagnostics(reranked.length),
  };
}

// =============================================================================
// Watcher Integrations
// =============================================================================

// indexSingleFile and unlinkSingleFile moved to engine/repository/indexing.ts (W1 C15).
