// Extracted from engine/repository.ts as part of W1 decomposition (C14).
// Query expansion via the configured LLM, with LLM-cache memoization and
// AI-usage telemetry.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../../runtime.js";
import { getDefaultLLM } from "../../inference.js";
import { recordDirectUsage } from "../../ai-usage.js";
import { getCacheKey, getCachedResult, setCachedResult } from "../llm-cache.js";
import type { ExpandedQuery } from "../types.js";

const DEFAULT_QUERY_MODEL = "Qwen/Qwen3-1.7B";

export async function expandQuery(query: string, model: string = DEFAULT_QUERY_MODEL, db: Database): Promise<ExpandedQuery[]> {
  // Check cache first — stored as JSON preserving types
  const cacheKey = getCacheKey("expandQuery", { query, model });
  const cached = getCachedResult(db, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ExpandedQuery[];
    } catch {
      // Old cache format (pre-typed, newline-separated text) — re-expand
    }
  }

  const llm = getDefaultLLM();
  const expandStart = Date.now();
  // Note: LLM usages rely on configuration logic internally
  const results = await llm.expandQuery(query);
  const expandDuration = Date.now() - expandStart;

  // Map Queryable[] → ExpandedQuery[] (same shape, decoupled from inference.ts internals).
  // Filter out entries that duplicate the original query text.
  const expanded: ExpandedQuery[] = results
    .filter(r => r.text !== query)
    .map(r => ({ type: r.type, text: r.text }));

  if (expanded.length > 0) {
    setCachedResult(db, cacheKey, JSON.stringify(expanded));
  }

  // Record query expansion AI usage.
  // expandQuery uses the generate model internally; estimate tokens from query + result.
  const provider = process.env.KINDX_LLM_BACKEND === "remote" ? "remote_openai" as const : "llama_cpp" as const;
  const estimatedInputTokens = Math.ceil(query.length / 4);
  const estimatedOutputTokens = Math.ceil(
    results.reduce((sum, r) => sum + r.text.length, 0) / 4
  );
  recordDirectUsage(db, {
    operation: "expand_query",
    model,
    provider,
    usage: {
      prompt_tokens: estimatedInputTokens,
      completion_tokens: estimatedOutputTokens,
      total_tokens: estimatedInputTokens + estimatedOutputTokens,
    },
    durationMs: expandDuration,
    context: { query_length: query.length, expansions: expanded.length },
  });

  return expanded;
}
