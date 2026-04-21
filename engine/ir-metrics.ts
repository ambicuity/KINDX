/**
 * Standard Information Retrieval evaluation metrics.
 *
 * Extracted from the benchmark harness into a reusable module so that
 * metrics can be computed both in offline benchmarks and at query-time
 * when relevance judgments are available.
 *
 * Metrics implemented:
 *   - MRR@k   (Mean Reciprocal Rank)
 *   - NDCG@k  (Normalized Discounted Cumulative Gain)
 *   - Precision@k
 *   - Recall@k
 *   - Hit@k   (binary: was there at least one relevant result in top-k?)
 *   - MAP@k   (Mean Average Precision)
 *
 * Inspired by Phoenix retrieval_metrics and BEIR benchmark conventions.
 */

export type RelevanceJudgments = Record<string, number>;

/**
 * Normalize a document key (file path or name) for comparison.
 * Strips directory components and lowercases for fuzzy matching.
 */
function normalizeKey(name: string): string {
  const basename = name.split("/").pop() ?? name;
  return basename.toLowerCase().replace(/_/g, "-");
}

/**
 * Find the rank (1-indexed) of the first relevant document in results.
 * Returns null if no relevant document is found.
 */
export function firstRelevantRank(
  results: string[],
  relevance: RelevanceJudgments,
  k?: number,
): number | null {
  const wanted = new Set(Object.keys(relevance).map(normalizeKey));
  const limit = k ?? results.length;
  for (let i = 0; i < Math.min(limit, results.length); i++) {
    if (wanted.has(normalizeKey(results[i]!))) return i + 1;
  }
  return null;
}

/**
 * Hit@k: Binary indicator — is there at least one relevant result in top-k?
 */
export function hitAtK(
  results: string[],
  relevance: RelevanceJudgments,
  k: number,
): number {
  return firstRelevantRank(results, relevance, k) !== null ? 1 : 0;
}

/**
 * MRR@k (Mean Reciprocal Rank at k).
 *
 * Returns 1/rank of the first relevant document in the top-k results.
 * Returns 0 if no relevant document appears in the top-k.
 */
export function mrrAtK(
  results: string[],
  relevance: RelevanceJudgments,
  k: number,
): number {
  const rank = firstRelevantRank(results, relevance, k);
  return rank ? 1 / rank : 0;
}

/**
 * DCG@k (Discounted Cumulative Gain at k).
 *
 * Uses the standard formula: sum(i=1..k) of (2^rel_i - 1) / log2(i + 1)
 */
export function dcgAtK(
  results: string[],
  relevance: RelevanceJudgments,
  k: number,
): number {
  const relMap = new Map(
    Object.entries(relevance).map(([key, val]) => [normalizeKey(key), val]),
  );
  let dcg = 0;
  for (let i = 0; i < Math.min(k, results.length); i++) {
    const rel = relMap.get(normalizeKey(results[i]!)) ?? 0;
    if (rel > 0) {
      dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }
  }
  return dcg;
}

/**
 * NDCG@k (Normalized Discounted Cumulative Gain at k).
 *
 * Normalizes DCG by the ideal DCG (documents sorted by relevance).
 * Returns 0 if no relevant documents exist.
 */
export function ndcgAtK(
  results: string[],
  relevance: RelevanceJudgments,
  k: number,
): number {
  const idealRels = Object.values(relevance)
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealRels.length; i++) {
    const rel = idealRels[i]!;
    idcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  if (idcg === 0) return 0;
  return dcgAtK(results, relevance, k) / idcg;
}

/**
 * Precision@k: Fraction of top-k results that are relevant.
 */
export function precisionAtK(
  results: string[],
  relevance: RelevanceJudgments,
  k: number,
): number {
  const wanted = new Set(Object.keys(relevance).map(normalizeKey));
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const relevant = topK.filter((r) => wanted.has(normalizeKey(r))).length;
  return relevant / topK.length;
}

/**
 * Recall@k: Fraction of all relevant documents that appear in top-k results.
 */
export function recallAtK(
  results: string[],
  relevance: RelevanceJudgments,
  k: number,
): number {
  const wanted = new Set(Object.keys(relevance).map(normalizeKey));
  const totalRelevant = wanted.size;
  if (totalRelevant === 0) return 0;
  const topK = results.slice(0, k);
  const found = topK.filter((r) => wanted.has(normalizeKey(r))).length;
  return found / totalRelevant;
}

/**
 * AP@k (Average Precision at k) — used for computing MAP.
 *
 * Average of precision values at each rank position where a relevant
 * document is retrieved, normalized by the total number of relevant documents.
 */
export function averagePrecisionAtK(
  results: string[],
  relevance: RelevanceJudgments,
  k: number,
): number {
  const wanted = new Set(Object.keys(relevance).map(normalizeKey));
  const totalRelevant = wanted.size;
  if (totalRelevant === 0) return 0;

  let sumPrecision = 0;
  let relevantSoFar = 0;
  const topK = results.slice(0, k);

  for (let i = 0; i < topK.length; i++) {
    if (wanted.has(normalizeKey(topK[i]!))) {
      relevantSoFar++;
      sumPrecision += relevantSoFar / (i + 1);
    }
  }

  return sumPrecision / totalRelevant;
}

/**
 * Compute a full evaluation report for a set of queries.
 * Returns aggregate metrics across all queries.
 */
export type EvaluationReport = {
  hitAt3: number;
  hitAt5: number;
  hitAt10: number;
  mrrAt5: number;
  mrrAt10: number;
  ndcgAt5: number;
  ndcgAt10: number;
  precisionAt3: number;
  precisionAt5: number;
  precisionAt10: number;
  recallAt5: number;
  recallAt10: number;
  mapAt5: number;
  mapAt10: number;
  queryCount: number;
};

export function computeEvaluationReport(
  queryResults: Array<{ results: string[]; relevance: RelevanceJudgments }>,
): EvaluationReport {
  const n = Math.max(1, queryResults.length);
  const aggregate = (fn: (qr: { results: string[]; relevance: RelevanceJudgments }) => number): number =>
    queryResults.reduce((sum, qr) => sum + fn(qr), 0) / n;

  return {
    hitAt3: aggregate((qr) => hitAtK(qr.results, qr.relevance, 3)),
    hitAt5: aggregate((qr) => hitAtK(qr.results, qr.relevance, 5)),
    hitAt10: aggregate((qr) => hitAtK(qr.results, qr.relevance, 10)),
    mrrAt5: aggregate((qr) => mrrAtK(qr.results, qr.relevance, 5)),
    mrrAt10: aggregate((qr) => mrrAtK(qr.results, qr.relevance, 10)),
    ndcgAt5: aggregate((qr) => ndcgAtK(qr.results, qr.relevance, 5)),
    ndcgAt10: aggregate((qr) => ndcgAtK(qr.results, qr.relevance, 10)),
    precisionAt3: aggregate((qr) => precisionAtK(qr.results, qr.relevance, 3)),
    precisionAt5: aggregate((qr) => precisionAtK(qr.results, qr.relevance, 5)),
    precisionAt10: aggregate((qr) => precisionAtK(qr.results, qr.relevance, 10)),
    recallAt5: aggregate((qr) => recallAtK(qr.results, qr.relevance, 5)),
    recallAt10: aggregate((qr) => recallAtK(qr.results, qr.relevance, 10)),
    mapAt5: aggregate((qr) => averagePrecisionAtK(qr.results, qr.relevance, 5)),
    mapAt10: aggregate((qr) => averagePrecisionAtK(qr.results, qr.relevance, 10)),
    queryCount: queryResults.length,
  };
}
