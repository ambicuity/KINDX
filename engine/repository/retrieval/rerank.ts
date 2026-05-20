// Extracted from engine/repository.ts as part of W1 decomposition (C14).
// The `rerank` orchestrator: caches reranker scores per (query, model, chunk)
// and forwards uncached chunks to the configured LLM. The backpressure queue
// (rerank-queue.ts) was extracted earlier in C13; this function is the
// synchronous, cache-aware façade callers actually invoke.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../../runtime.js";
import { getDefaultLLM, type RerankDocument, type RerankOptions } from "../../inference.js";
import { recordDirectUsage } from "../../ai-usage.js";
import { getCacheKey, getCachedResult, setCachedResult } from "../llm-cache.js";

const DEFAULT_RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-Q8_0";

export async function rerank(
  query: string,
  documents: { file: string; text: string }[],
  model: string = DEFAULT_RERANK_MODEL,
  db: Database,
  options: RerankOptions = {}
): Promise<{ file: string; score: number }[]> {
  const cachedResults: Map<string, number> = new Map();
  const uncachedDocsByChunk: Map<string, RerankDocument> = new Map();

  // Check cache for each document
  // Cache key includes chunk text — different queries can select different chunks
  // from the same file, and the reranker score depends on which chunk was sent.
  // File path is excluded from the new cache key because the reranker score
  // depends on the chunk content, not where it came from.
  for (const doc of documents) {
    const cacheKey = getCacheKey("rerank", { query, model, chunk: doc.text });
    const legacyCacheKey = getCacheKey("rerank", { query, file: doc.file, model, chunk: doc.text });
    const cached = getCachedResult(db, cacheKey) ?? getCachedResult(db, legacyCacheKey);
    if (cached !== null) {
      cachedResults.set(doc.text, parseFloat(cached));
    } else {
      uncachedDocsByChunk.set(doc.text, { file: doc.file, text: doc.text });
    }
  }

  // Rerank uncached documents using LlamaCpp
  if (uncachedDocsByChunk.size > 0) {
    const llm = getDefaultLLM();
    const uncachedDocs = [...uncachedDocsByChunk.values()];
    const rerankStart = Date.now();
    const rerankResult = await llm.rerank(query, uncachedDocs, { model, onRerankInit: options.onRerankInit });
    const rerankDuration = Date.now() - rerankStart;

    // Cache results by chunk text so identical chunks across files are scored once.
    const textByFile = new Map(uncachedDocs.map(d => [d.file, d.text]));
    for (const result of rerankResult.results) {
      const chunk = textByFile.get(result.file) || "";
      const cacheKey = getCacheKey("rerank", { query, model, chunk });
      setCachedResult(db, cacheKey, result.score.toString());
      cachedResults.set(chunk, result.score);
    }

    // Record rerank AI usage.
    const provider = process.env.KINDX_LLM_BACKEND === "remote" ? "remote_openai" as const : "llama_cpp" as const;
    // If the rerank response carries usage metadata, use it; otherwise estimate.
    const usage = rerankResult.usage ?? {
      prompt_tokens: Math.ceil(
        (query.length + uncachedDocs.reduce((s, d) => s + d.text.length, 0)) / 4
      ),
      completion_tokens: 0,
      total_tokens: Math.ceil(
        (query.length + uncachedDocs.reduce((s, d) => s + d.text.length, 0)) / 4
      ),
    };
    recordDirectUsage(db, {
      operation: "rerank",
      model,
      provider,
      usage,
      durationMs: rerankDuration,
      context: { documents_count: uncachedDocs.length, query_length: query.length },
    });
  }

  // Return all results sorted by score
  return documents
    .map(doc => ({ file: doc.file, score: cachedResults.get(doc.text) || 0 }))
    .sort((a, b) => b.score - a.score);
}
