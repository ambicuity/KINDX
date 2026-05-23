// Extracted from engine/repository.ts as part of W1 decomposition (C7).
// Docid normalization, similarity matching via Levenshtein distance.
// matchFilesByGlob remains in repository.ts for now — it depends on
// getCollectionByName, which has not been extracted yet.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../runtime.js";

export function levenshtein(a: string, b: string, maxDistance: number = Number.POSITIVE_INFINITY): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Fast-fail: edit distance must be at least the length delta.
  if (Number.isFinite(maxDistance) && Math.abs(m - n) > maxDistance) {
    return maxDistance + 1;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
      if (dp[i]![j]! < rowMin) {
        rowMin = dp[i]![j]!;
      }
    }

    if (Number.isFinite(maxDistance) && rowMin > maxDistance) {
      return maxDistance + 1;
    }
  }
  return dp[m]![n]!;
}

/**
 * Normalize a docid input by stripping surrounding quotes and leading #.
 */
export function normalizeDocid(docid: string): string {
  let normalized = docid.trim();

  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

/**
 * Check if a string looks like a docid reference.
 */
export function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}

/**
 * Find a document by its short docid (first 6+ characters of hash).
 */
export function findDocumentByDocid(db: Database, docid: string): { filepath: string; hash: string } | null {
  const shortHash = normalizeDocid(docid);

  if (shortHash.length < 1) return null;

  const doc = db.prepare(`
    SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.hash
    FROM documents d
    WHERE d.hash LIKE ? AND d.active = 1
    LIMIT 1
  `).get(`${shortHash}%`) as { filepath: string; hash: string } | null;

  return doc;
}

export function findSimilarFiles(db: Database, query: string, maxDistance: number = 3, limit: number = 5): string[] {
  const allFiles = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.active = 1
  `).all() as { path: string }[];
  const queryLower = query.toLowerCase();
  const scored = allFiles
    .map(f => ({ path: f.path, dist: levenshtein(f.path.toLowerCase(), queryLower, maxDistance) }))
    .filter(f => f.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
  return scored.map(f => f.path);
}
