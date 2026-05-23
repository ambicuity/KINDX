// Extracted from engine/repository.ts as part of W1 decomposition (C12).
// LLM response cache primitives. Self-contained: only depends on Database.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { createHash } from "crypto";
import type { Database } from "../runtime.js";

/**
 * Canonical JSON stringify: walks the value and emits objects with keys in
 * sorted order so two semantically identical requests hash to the same key
 * regardless of property insertion order. Arrays preserve order (significant).
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export function getCacheKey(url: string, body: object): string {
  const hash = createHash("sha256");
  hash.update(url);
  hash.update(canonicalStringify(body));
  return hash.digest("hex");
}

export function getCachedResult(db: Database, cacheKey: string): string | null {
  const row = db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(cacheKey) as { result: string } | null;
  return row?.result || null;
}

export function setCachedResult(db: Database, cacheKey: string, result: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, result, created_at) VALUES (?, ?, ?)`).run(cacheKey, result, now);
  // Tier-1 perf: high-water-mark eviction. Only run the O(n log n) DELETE
  // when the table has actually grown past the high-water threshold; avoids
  // the random-sampling spike where the same DELETE could fire 100 times in
  // quick succession by coincidence on a hot path.
  if (Math.random() < 0.01) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM llm_cache`).get() as { c: number };
    if (row.c > 1500) {
      db.exec(`DELETE FROM llm_cache WHERE hash NOT IN (SELECT hash FROM llm_cache ORDER BY created_at DESC LIMIT 1000)`);
    }
  }
}

export function clearCache(db: Database): void {
  db.exec(`DELETE FROM llm_cache`);
}

export function deleteLLMCache(db: Database): number {
  const result = db.prepare(`DELETE FROM llm_cache`).run();
  return result.changes;
}
