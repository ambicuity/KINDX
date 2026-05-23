// Extracted from engine/repository.ts as part of W1 decomposition (C4).
// Pure data shapes shared across the repository surface: search results,
// RRF/hybrid traces, collection and index status types, snippet results.
// Function-bearing types (SearchHooks, HybridQueryOptions, etc.) stay in
// engine/repository.ts until their associated callees move out.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

export type ExpandedQuery = {
  type: 'lex' | 'vec' | 'hyde';
  text: string;
};

export type DocumentResult = {
  filepath: string;           // Full filesystem path
  displayPath: string;        // Short display path (e.g., "docs/readme.md")
  title: string;              // Document title (from first heading or filename)
  context: string | null;     // Folder context description if configured
  hash: string;               // Content hash for caching/change detection
  docid: string;              // Short docid (first 6 chars of hash) for quick reference
  collectionName: string;     // Parent collection name
  modifiedAt: string;         // Last modification timestamp
  bodyLength: number;         // Body length in bytes (useful before loading)
  body?: string;              // Document body (optional, load with getDocumentBody)
  extraction?: {
    format: string;
    extractor: string;
    warnings: string[];
  };
};

/**
 * Search result extends DocumentResult with score and source info
 */
export type SearchResult = DocumentResult & {
  score: number;              // Relevance score (0-1)
  source: "fts" | "vec";      // Search source (full-text or vector)
  chunkPos?: number;          // Character position of matching chunk (for vector search)
};

/**
 * Ranked result for RRF fusion (simplified, used internally)
 */
export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  modifiedAt?: string;
};

export type RRFContributionTrace = {
  listIndex: number;
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
  rank: number;            // 1-indexed rank within list
  weight: number;
  backendScore: number;    // Backend-normalized score before fusion
  rrfContribution: number; // weight / (k + rank)
};

export type RRFScoreTrace = {
  contributions: RRFContributionTrace[];
  baseScore: number;       // Sum of reciprocal-rank contributions
  topRank: number;         // Best (lowest) rank seen across lists
  topRankBonus: number;    // +0.05 for rank 1, +0.02 for rank 2-3
  totalScore: number;      // baseScore + topRankBonus
};

export type HybridQueryExplain = {
  ftsScores: number[];
  vectorScores: number[];
  rrf: {
    rank: number;          // Rank after RRF fusion (1-indexed)
    positionScore: number; // 1 / rank used in position-aware blending
    weight: number;        // Position-aware RRF weight (0.75 / 0.60 / 0.40)
    baseScore: number;
    topRankBonus: number;
    totalScore: number;
    contributions: RRFContributionTrace[];
  };
  rerankScore: number;
  blendedScore: number;
};

export type HybridQueryResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  score: number;
  context: string | null;
  docid: string;
  contentType?: 'text' | 'image' | 'csv' | 'json';
  sourceMetadata?: {
    originalFile?: string;
    imageDescription?: boolean;
    schemaInfo?: Record<string, string>;
  };
  explain?: HybridQueryExplain;
};

/**
 * Error result when document is not found
 */
export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};

/**
 * Result from multi-get operations
 */
export type MultiGetResult = {
  doc: DocumentResult;
  skipped: false;
} | {
  doc: Pick<DocumentResult, "filepath" | "displayPath">;
  skipped: true;
  skipReason: string;
};

export type CollectionInfo = {
  name: string;
  path: string;
  pattern: string;
  documents: number;
  lastUpdated: string;
};

export type IndexStatus = {
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
  collections: CollectionInfo[];
  shards: {
    enabledCollections: Array<{ collection: string; shardCount: number }>;
    checkpointPath: string;
    checkpointExists: boolean;
    warnings: string[];
  };
};

export type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};

export type SnippetResult = {
  line: number;            // 1-indexed line number of best match
  snippet: string;         // Snippet text WITH legacy `@@ -X,Y @@` diff-style header
                           // (kept for JSON/CSV/MD/XML output backward compat)
  body: string;            // Snippet text WITHOUT the diff header (for new CLI renderer)
  bodyStartLine: number;   // 1-indexed line number of the FIRST line of `body`
  linesBefore: number;     // Lines in document before snippet
  linesAfter: number;      // Lines in document after snippet
  snippetLines: number;    // Number of lines in snippet
};
