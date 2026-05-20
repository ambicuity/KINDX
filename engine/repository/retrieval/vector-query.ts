// Extracted from engine/repository.ts as part of W1 decomposition (C14b).
// Vector-only semantic search with query expansion.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { SearchHooks } from "./hybrid.js";
// Store type and DEFAULT_EMBED_MODEL still live in engine/repository.ts.
// Type-only import for Store, value import for the constant (resolved lazily by Node ESM).
import { type Store, DEFAULT_EMBED_MODEL } from "../../repository.js";

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
