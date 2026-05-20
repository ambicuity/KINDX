// Extracted from engine/repository.ts as part of W1 decomposition (C14b).
// Structured search orchestrator: pre-expanded queries from LLM callers.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { statSync } from "node:fs";
import { join } from "path";
import { getDefaultLLM, formatQueryForEmbedding } from "../../inference.js";
import { getCollection } from "../../catalogs.js";
import { getShardRuntimeStatus } from "../../sharding.js";
import type {
  RankedResult,
  HybridQueryExplain,
} from "../types.js";
import {
  reciprocalRankFusion,
  buildRrfTrace,
  type RankedListMeta,
} from "./rrf.js";
import { chunkDocument } from "../chunking.js";
import { withTimeout } from "./document-lookup.js";
import { validateLexQuery, validateSemanticQuery } from "../fts.js";
import { getMainDatabasePath } from "../vec.js";
import {
  type RerankQueueConfig,
  type RerankDropPolicy,
  acquireRerankSlot,
  getRerankQueueSnapshot,
  getCollectionRerankSettings,
  parsePositiveInt,
  runWithConcurrencyLimit,
} from "../rerank-queue.js";
import type {
  SearchHooks,
  SearchRoutingProfile,
  StructuredSearchDiagnostics,
  HybridQueryResult,
} from "./hybrid.js";
// Store type, DEFAULT_EMBED_MODEL, RERANK_CANDIDATE_LIMIT, and
// getGraphConnectedCandidates still live in engine/repository.ts. Type-only
// import for Store; value imports are resolved lazily by Node ESM.
import {
  type Store,
  DEFAULT_EMBED_MODEL,
  RERANK_CANDIDATE_LIMIT,
  getGraphConnectedCandidates,
} from "../../repository.js";

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
