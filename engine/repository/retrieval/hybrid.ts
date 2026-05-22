// Extracted from engine/repository.ts as part of W1 decomposition (C14b).
// Hybrid search orchestrator: BM25 + vector + query expansion + RRF + reranking.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { getDefaultLLM, formatQueryForEmbedding } from "../../inference.js";
import type {
  ExpandedQuery,
  RankedResult,
  HybridQueryExplain,
  HybridQueryResult,
} from "../types.js";
export type { HybridQueryResult } from "../types.js";
import {
  reciprocalRankFusion,
  buildRrfTrace,
  type RankedListMeta,
} from "./rrf.js";
import { chunkDocument } from "../chunking.js";
import { withTimeout } from "./document-lookup.js";
import {
  type RerankDropPolicy,
  getCollectionRerankSettings,
} from "../rerank-queue.js";
// Store type still lives in engine/repository.ts. Type-only import avoids any
// runtime cycle. Constants (DEFAULT_EMBED_MODEL, RERANK_CANDIDATE_LIMIT,
// STRONG_SIGNAL_*) are imported back lazily — Node ESM resolves them on first
// use, well after module load.
import {
  type Store,
  DEFAULT_EMBED_MODEL,
  RERANK_CANDIDATE_LIMIT,
  STRONG_SIGNAL_MIN_SCORE,
  STRONG_SIGNAL_MIN_GAP,
} from "../../repository.js";

function detectContentType(body: string, filepath: string): 'text' | 'image' | 'csv' | 'json' {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif'].includes(ext)) {
    return 'image';
  }
  if (ext === 'csv') return 'csv';
  if (ext === 'json') return 'json';

  if (body.includes('Schema:') && body.includes('Rows ')) return 'csv';
  if (body.includes('Schema:') && body.includes('Items ')) return 'json';

  return 'text';
}

function extractSchemaFromBody(body: string): Record<string, string> | undefined {
  const schemaMatch = body.match(/Schema:\s*([^\n]+)/);
  if (!schemaMatch) return undefined;

  const schemaStr = schemaMatch[1] || "";
  const schema: Record<string, string> = {};

  for (const pair of schemaStr.split(",")) {
    const [key, type] = pair.split(":").map(s => s.trim());
    if (key && type) {
      schema[key] = type;
    }
  }

  return Object.keys(schema).length > 0 ? schema : undefined;
}

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

    const contentType = detectContentType(candidate?.body || "", r.file);

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
      contentType,
      sourceMetadata: {
        originalFile: r.file,
        imageDescription: contentType === 'image',
        schemaInfo: contentType === 'csv' || contentType === 'json' ? extractSchemaFromBody(candidate?.body || "") : undefined,
      },
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
