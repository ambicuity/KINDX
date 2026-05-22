# KINDX Retrieval Feedback Loop — Design Spec

**Date**: 2026-05-22
**Branch**: `feature/retrieval-feedback-loop`
**Priority**: P1
**Approach**: Sequential feature-by-feature (Approach A)

---

## Overview

Adds a retrieval feedback loop to the KINDX memory subsystem. Enables users to provide satisfaction signals on search results, biasing future rankings. Also addresses TTL refresh, cross-prefix semantic dedup, per-scope memory limits with LRU eviction, background lifecycle jobs, and support for multiple embedding models.

All work touches three files:
- `engine/memory.ts` — core memory subsystem
- `engine/protocol.ts` — MCP server tool registration
- `engine/repository/retrieval/rerank.ts` — LLM reranking (unchanged; feedback integrated at memory search layer, not rerank)

---

## Feature 1: Feedback Schema & MCP Tool

### Schema

New table `memory_feedback` created in `initializeMemorySchema()` as a migration block (gated on table existence check, same pattern as existing `expires_at` column migration):

```sql
CREATE TABLE IF NOT EXISTS memory_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  query TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  result_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  satisfaction TEXT NOT NULL CHECK(satisfaction IN ('positive', 'negative', 'neutral')),
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_scope_hash
  ON memory_feedback(scope, query_hash);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_scope_result
  ON memory_feedback(scope, result_id);
```

- `query_hash` = SHA-256 of normalized (trimmed, lowercased) query. Enables fast lookups for repeated queries.
- `result_id` FK to `memories.id` with `ON DELETE CASCADE` — deleting a memory automatically removes its feedback rows.
- `scope` provides tenancy isolation consistent with all other memory operations.

### Exported functions in `engine/memory.ts`

```typescript
export function initializeMemoryFeedbackSchema(db: Database): void;
export function recordFeedback(
  db: Database,
  scope: string,
  query: string,
  results: { id: number; satisfaction: "positive" | "negative" | "neutral" }[],
  source?: string,
): number;
export type FeedbackSummary = {
  result_id: number;
  positive: number;
  negative: number;
  neutral: number;
  total: number;
};
export function getFeedbackForScope(db: Database, scope: string): FeedbackSummary[];
```

### MCP Tool: `memory_feedback`

Registered in `engine/protocol.ts` after the existing `memory_bulk` tool block.

**Input schema**:
```typescript
{
  scope: z.string().optional(),
  query: z.string(),
  results: z.array(z.object({
    id: z.number().int().positive(),
    satisfaction: z.enum(["positive", "negative", "neutral"]),
  })),
  source: z.string().optional(),
}
```

**Handler logic**:
1. Resolve scope via `resolveToolScope()`.
2. Validate all `result_id`s exist in the resolved scope (single SQL query).
3. Call `recordFeedback()` with batched inserts.
4. Record audit via `recordAudit(store.db, { action: "memory_feedback", ... })`.
5. Return `{ recorded: number }`.

### RBAC

Add `"memory_feedback"` to:
- `RBACOperation` union in `engine/rbac.ts`
- `ROLE_PERMISSIONS` for `admin` and `editor` (same as `memory_put`)
- `toolToOp` mapping in HTTP transport section of `engine/protocol.ts`

---

## Feature 2: Feedback-based Ranking Adjustment

### Algorithm

After computing raw scores, apply a multiplicative bias derived from historical feedback:

```
adjustedScore = rawScore * (1 + boostFactor * (satisfactionRatio - 0.5))

where:
  satisfactionRatio = positiveCount / totalFeedbackCount
  default = 0.5 when no feedback exists (neutral)
  boostFactor = 0.3 (configurable via KINDX_FEEDBACK_BOOST_FACTOR)
```

- Positive feedback (ratio > 0.5) → score increases
- Negative feedback (ratio < 0.5) → score decreases
- No feedback → ratio defaults to 0.5, bias = 1.0 (no-op)

### New helper in `engine/memory.ts`

```typescript
export function computeFeedbackBias(
  db: Database,
  scope: string,
  memoryIds: number[],
): Map<number, number>;
```

- Single SQL aggregation query over `memory_feedback` filtered by `result_id IN (...)` and scope
- Returns Map of `memoryId → biasMultiplier` for O(1) lookup per result
- Returns empty Map when `memoryIds` is empty (avoids unnecessary query)

### Integration points

**`textSearchMemory()`** — after score computation (line ~728), apply:
```typescript
const bias = computeFeedbackBias(db, scope, scored.map(s => s.id));
scored.forEach(s => { s.score *= bias.get(s.id) ?? 1.0; });
scored.sort((a, b) => (b.score - a.score) || (b.hitRate || 0) - (a.hitRate || 0));
```

**`semanticSearchMemoryWithVector()`** — after similarity computation (line ~780-801), apply:
```typescript
const bias = computeFeedbackBias(db, scope, scored.map(s => s.id));
scored.forEach(s => { s.similarity = (s.similarity ?? 0) * (bias.get(s.id) ?? 1.0); });
scored.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
```

**`semanticSearchMemory()`** — inherits from above (no direct change).

### Performance

One additional SQL query per search, aggregating over `memory_feedback` with indexed `(scope, result_id)`. For typical scopes with <100 results, this is <1ms.

### Depends on

Feature 1 (feedback table must exist).

---

## Feature 3: TTL Refresh on Access

### Problem

Memories with TTL expire on their original deadline regardless of usage. A heavily-accessed memory with a 7-day TTL should refresh its expiry on each access.

### Schema change

Add `ttl_seconds INTEGER` column to `memories` table (migration, same pattern as `expires_at`):
```sql
ALTER TABLE memories ADD COLUMN ttl_seconds INTEGER;
```

`NULL` = permanent (no TTL), consistent with existing `expires_at IS NULL` semantics.

### Type changes

```typescript
// MemoryRecord gets new field:
ttlSeconds: number | null;

// UpsertMemoryInput — ttl_seconds is derived internally from ttl input
```

### Function changes

**`insertNewMemory()`**: Accept and store `ttlSeconds` parameter alongside `expiresAt`.

**`incrementCounters()`** — extended to refresh `expires_at` when `ttl_seconds` IS NOT NULL:
```sql
UPDATE memories SET
  appeared_count = appeared_count + 1,
  accessed_count = accessed_count + 1,
  last_appeared_at = ?,
  last_accessed_at = ?,
  expires_at = CASE
    WHEN ttl_seconds IS NOT NULL
    THEN datetime('now', '+' || ttl_seconds || ' seconds')
    ELSE expires_at
  END
WHERE id IN (...)
```

**`markMemoryAccessed()`** — same refresh logic added to the UPDATE statement.

**`upsertMemory()` exact dedup path** (line 562-578): When exact match found and incoming `ttl` is set, refresh `expires_at` to `now + ttl` and update `ttl_seconds` on the existing row.

**`computeExpiresAt()`** — no change (still computes initial `expires_at` from `ttl`).

### Backward compatibility

Existing memories without `ttl_seconds` have `NULL` — no refresh occurs. Migration is additive only.

### Depends on

None (independent).

---

## Feature 4: Cross-prefix Semantic Dedup

### Problem

`getSemanticCandidates()` (line 308-330) filters by same key prefix. Two near-identical memories under different prefixes (e.g., `preference:editor` → "vim" and `setting:editor` → "vim") are not deduplicated.

### Design

Two-tier semantic dedup in `upsertMemory()`:

**Tier 1 (existing, unchanged)**: Same-prefix matching via `getSemanticCandidates()`. Fast, targeted.

**Tier 2 (new)**: Cross-prefix matching. Runs ONLY when Tier 1 produces no match AND `disableSemanticDedup` is false. Uses a higher threshold.

### New function

```typescript
function getCrossPrefixCandidates(
  db: Database,
  scope: string,
): { id: number; key: string; embedding: Float32Array }[];
```

Same as `getSemanticCandidates()` but without the `key = ? OR key LIKE ? || ':%'` prefix filter. Loads ALL active embeddings for the scope.

### Threshold

Cross-prefix default: `CROSS_PREFIX_THRESHOLD = 0.94` (vs 0.92 for same-prefix). Overridable via `UpsertMemoryInput.crossPrefixThreshold`. Higher threshold prevents false positives from semantically unrelated memories across prefixes.

### Supersession flow

Identical to existing Tier 1 logic: newer record supersedes older via `superseded_by`, counters merged.

### Type change

```typescript
// UpsertMemoryInput gets:
crossPrefixThreshold?: number;
```

### Performance note

Cross-prefix loads all embeddings for the scope. For scopes with 10k+ memories this is ~30 MB across the JS boundary. Acceptable because:
- Tier 1 runs first and is fast (indexed key prefix filter)
- Cross-prefix is a fallback, not the hot path
- Scopes are typically <1000 active memories

### Depends on

None (independent).

---

## Feature 5: Memory Limits & LRU Eviction

### Schema

New table `memory_scope_config`:
```sql
CREATE TABLE IF NOT EXISTS memory_scope_config (
  scope TEXT PRIMARY KEY,
  max_memories INTEGER,
  eviction_policy TEXT NOT NULL DEFAULT 'lru',
  updated_at TEXT NOT NULL
);
```

### Default limit

Resolution order: `memory_scope_config.max_memories` > `KINDX_MEMORY_MAX_PER_SCOPE` env var > unlimited.

### Eviction function

```typescript
export function evictIfNeeded(
  db: Database,
  scope: string,
  maxMemories: number,
): number;
```

Logic:
1. Count active (non-superseded, non-expired) memories in scope.
2. If count < maxMemories, return 0.
3. Evict N = count - maxMemories + 1 memories with oldest `last_accessed_at`:
   ```sql
   SELECT id FROM memories
   WHERE scope = ? AND superseded_by IS NULL
     AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   ORDER BY last_accessed_at ASC NULLS LAST
   LIMIT ?
   ```
4. For each evicted row, run the same cleanup cascade as `deleteMemory()` (tags, embeddings, vector index, links, superseded_by references).
5. Return count evicted.

### Integration

Called in `insertNewMemory()` before INSERT. Eviction is best-effort — if it fails, insertion still proceeds.

### Exported functions

```typescript
export function initializeMemoryScopeConfigSchema(db: Database): void;
export function setScopeMemoryLimit(
  db: Database,
  scope: string,
  maxMemories: number,
): void;
export function getScopeMemoryLimit(
  db: Database,
  scope: string,
): number | null;
```

### Depends on

Feature 3 (TTL refresh — need `ttl_seconds` for correct eviction of TTL-ed memories).

---

## Feature 6: Background Lifecycle Jobs

### Problem

`purgeExpiredMemories()` and `consolidateMemories()` exist but are never called at runtime. They are dead code.

### Design

Event-driven trigger with probabilistic throttling. No timers, no background threads, no async complexity.

### Trigger helper

```typescript
const LIFECYCLE_EVERY_N_OPS = 50;
let _lifecycleOpsSinceLastRun = 0;

export function maybeRunLifecycleJobs(db: Database, scope: string): void {
  _lifecycleOpsSinceLastRun += 1;
  if (_lifecycleOpsSinceLastRun < LIFECYCLE_EVERY_N_OPS) return;
  _lifecycleOpsSinceLastRun = 0;
  if (Math.random() > 0.01) return;
  purgeExpiredMemories(db, scope);
  consolidateMemories(db, scope);
}
```

`LIFECYCLE_EVERY_N_OPS` overridable via `KINDX_MEMORY_LIFECYCLE_INTERVAL` env var.

### Integration points

- `upsertMemory()` — after successful upsert (all 4 code paths: exact dedup, semantic supersession, single-cardinality, new insert)
- `deleteMemory()` — after successful delete

Both are on the write path, ensuring lifecycle runs when the data is actually changing.

### Depends on

Features 3 and 4 (TTL refresh and cross-prefix dedup make lifecycle jobs more effective).

---

## Feature 7: Embedding Model Not Hardcoded

### Problem

`tryStoreEmbedding()` (line 364-390) hardcodes model as `"kindx-local"` regardless of which embedding model actually produced the vector.

### Changes

**`tryStoreEmbedding()`** — accept optional `model?: string` parameter:
```typescript
function tryStoreEmbedding(
  db: Database,
  memoryId: number,
  vector?: number[] | Float32Array,
  model?: string,
): void {
  const resolvedModel = model
    ?? process.env.KINDX_EMBED_MODEL
    ?? DEFAULT_EMBED_MODEL_URI;
  // ... use resolvedModel in INSERT
}
```

Where `DEFAULT_EMBED_MODEL_URI` is imported from `engine/inference.ts` (already exported as `DEFAULT_EMBED_MODEL_URI = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"`).

**`computeMemoryVector()`** — return type changes from `Promise<number[] | undefined>` to `Promise<{ vector: number[]; model: string } | undefined>`. The model URI comes from the session used for embedding.

**Callers updated**:
- `insertNewMemory()` — pass `model` through to `tryStoreEmbedding()`
- `upsertMemory()` — destructure `{ vector, model }` from `computeMemoryVector()`, pass `model` through all code paths
- `embedMemories()` — pass model from `withLLMSession` through to `tryStoreEmbedding()`
- `processBulkMemories()` — pass through from bulk vector computation

### Depends on

None (independent).

---

## Implementation Order

| # | Feature | Depends On | Files Modified |
|---|---------|-----------|----------------|
| 1 | Feedback Schema & MCP Tool | — | memory.ts, protocol.ts, rbac.ts |
| 2 | Feedback-based Ranking | 1 | memory.ts |
| 3 | TTL Refresh on Access | — | memory.ts |
| 4 | Cross-prefix Semantic Dedup | — | memory.ts |
| 5 | Memory Limits & LRU Eviction | 3 | memory.ts |
| 6 | Background Lifecycle Jobs | 3, 4 | memory.ts |
| 7 | Embedding Model Not Hardcoded | — | memory.ts |

Features 1-2 are sequential. Features 3, 4, 7 are independent of each other and of 1-2. Features 5-6 depend on 3 and 4.

---

## Testing Strategy

All tests in `specs/memory.test.ts` and `specs/mcp.test.ts` using in-memory SQLite databases (`:memory:`), consistent with existing patterns.

### New test cases

**Feature 1**:
- `recordFeedback` inserts batch rows correctly
- `recordFeedback` returns 0 for empty results array
- `getFeedbackForScope` aggregates correctly across multiple queries
- MCP `memory_feedback` tool accepts valid input and returns count
- MCP `memory_feedback` tool rejects invalid result IDs

**Feature 2**:
- Positive feedback boosts memory score in text search
- Negative feedback reduces memory score in text search
- No feedback leaves scores unchanged
- Feedback from different scopes does not affect ranking
- `computeFeedbackBias` returns empty Map for empty input

**Feature 3**:
- Memory with TTL refreshed on textSearchMemory
- Memory with TTL refreshed on markMemoryAccessed
- Memory without TTL (ttl_seconds IS NULL) unchanged on access
- Exact dedup path refreshes expires_at when TTL is set

**Feature 4**:
- Two memories with different prefixes but same semantic content: older is superseded
- Cross-prefix threshold (0.94) prevents low-similarity cross-prefix matches
- Tier 1 (same-prefix) match prevents Tier 2 from running
- `crossPrefixThreshold` input overrides default

**Feature 5**:
- Scope with max_memories=3: inserting a 4th evicts the oldest accessed
- Scope with no limit: no eviction occurs
- Eviction cleans up tags, embeddings, vector index
- LRU ordering: most recently accessed survives eviction

**Feature 6**:
- `maybeRunLifecycleJobs` triggers after 50 ops (probabilistic)
- Expired memories are purged on trigger
- Duplicate memories are consolidated on trigger

**Feature 7**:
- `tryStoreEmbedding` uses env var model when specified
- `tryStoreEmbedding` falls back to DEFAULT_EMBED_MODEL_URI
- `computeMemoryVector` returns model alongside vector

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cross-prefix false positives | Medium | High threshold (0.94), Tier 1 always tried first |
| Eviction evicts hot memory | Low | LRU ordering; scope caps are configurable per-scope |
| Feedback table grows unbounded | Low | Linked to memory FK with CASCADE; can add TTL-based cleanup later |
| Lifecycle jobs add latency to writes | Low | 1% probability per 50 ops; sub-millisecond SQL operations |
| `computeFeedbackBias` extra query per search | Low | Single indexed query, scoped, <1ms for typical result sets |
| Migration adds column to large `memories` table | Low | ALTER TABLE ADD COLUMN is O(1) in SQLite (schema-only change) |

---

## Acceptance Criteria (from task spec)

- [x] Feedback MCP tool accepts result IDs and satisfaction signals
- [x] Feedback stored and associated with queries/results
- [x] Subsequent queries use feedback to adjust ranking
- [x] TTL refreshed on access
- [x] Memory limits enforced per scope
