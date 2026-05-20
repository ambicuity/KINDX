# W1 — Decompose `engine/repository.ts` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 4974-line `engine/repository.ts` god-file with a directory `engine/repository/` containing 12–14 focused modules, each ≤ 800 LOC, with a re-export barrel `engine/repository/index.ts` preserving the public surface so no consumer breaks.

**Architecture:** Mechanical extraction first, surgical detangling second, no behavior changes. One PR per cluster (target cluster size: ≤ 800 LOC of moved code, ≤ ~30 functions). Each PR keeps `engine/repository.ts` working as a thin pass-through during the migration window. Existing 13 test files in `specs/` that import from `engine/repository.js` are not edited.

**Tech Stack:** TypeScript ESM, Node 20+, Vitest, `madge` (one-off circular-import check).

**Prerequisite:** Baseline-capture plan merged (`tooling/artifacts/baseline-*` exist).

**Branching model:** Each cluster gets its own short-lived branch named `refactor/repo-<cluster>`. All branches merge into `program/strategic-refactor` (or `main`, per maintainer preference) one at a time. Do not work on two clusters in parallel.

---

## Cluster Plan

Each task below corresponds to one cluster from spec §5.1 and produces one PR. The order minimizes inter-cluster import chaos: pure utilities first, then storage primitives, then orchestration.

| # | Cluster | Target file | Approx. LOC | Spec §5.1 line range |
|---|---|---|---|---|
| C1 | Setup directory + barrel | `engine/repository/index.ts` | 50 | — |
| C2 | Paths | `engine/repository/paths.ts` | ~350 | 152–499 |
| C3 | Store / DB lifecycle | `engine/repository/store.ts` | ~700 | 516–1245 |
| C4 | Types | `engine/repository/types.ts` | ~150 | scattered |
| C5 | Content & documents | `engine/repository/content.ts` | ~300 | 1274–1562 |
| C6 | Chunking | `engine/repository/chunking.ts` | ~200 | 1564–1724 |
| C7 | Docid / similarity / glob | `engine/repository/docid.ts` | ~150 | 1765–1893 |
| C8 | Context annotations | `engine/repository/context-annotations.ts` | ~300 | 1893–2191 |
| C9 | Collections | `engine/repository/collections.ts` | ~250 | 2024–2191 |
| C10 | FTS | `engine/repository/fts.ts` | ~200 | 2276–2449 |
| C11 | Vector storage + search | `engine/repository/vec.ts` + `engine/repository/embeddings.ts` | ~250 + ~200 | 2455–2757 |
| C12 | LLM cache | `engine/repository/llm-cache.ts` | ~80 | 1117–1156 |
| C13 | Rerank queue | `engine/repository/rerank-queue.ts` | ~200 | 3632–3757 |
| C14 | Retrieval orchestrators | `engine/repository/retrieval/{expansion,rerank,rrf,hybrid,vector-query,structured}.ts` | 6 files | 2757–4892 |
| C15 | Indexing | `engine/repository/indexing.ts` | ~150 | 4892–4974 |
| C16 | Final cleanup | delete `engine/repository.ts` | — | — |

The mechanical pattern is the same for every cluster: create target file → move symbols → re-export from `engine/repository.ts` (or the barrel) → build → run tests → benchmark → commit → open PR.

---

## Universal "Per-Cluster" Procedure

Each cluster task below references this template. **Read it once and follow it for every cluster PR.**

- [ ] **Step 1: Create branch**

```bash
git checkout main && git pull
git checkout -b refactor/repo-<cluster-name>
```

- [ ] **Step 2: Create the target file with imports**

Create `engine/repository/<target>.ts` with a header:

```typescript
// Extracted from engine/repository.ts as part of W1 decomposition.
// See docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5
```

Add the required imports for the cluster (the originals you'll see in the source as you move code).

- [ ] **Step 3: Move the cluster's symbols**

Cut the listed functions and types from `engine/repository.ts` and paste them into the new file. Preserve identifiers exactly; do not rename.

- [ ] **Step 4: Re-export from the old file**

At the **top of `engine/repository.ts`** (so the public surface is unchanged), add:

```typescript
export * from "./repository/<target>.js";
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: success. If unresolved imports remain in `engine/repository.ts`, follow them: usually the moved function was referenced internally. Re-import it from the new path:

```typescript
import { movedSymbol } from "./repository/<target>.js";
```

- [ ] **Step 6: Run circular import check**

Run: `npx madge --circular engine/repository/ 2>&1 | tee /tmp/madge.log`
Expected: `No circular dependency found!` If a cycle is reported, fix it before continuing (usually by moving the offending helper down a layer — see Phase B rules in spec §5.3).

- [ ] **Step 7: Run the full root test suite**

Run: `npm test`
Expected: all 59 (or current count) tests pass unchanged.

- [ ] **Step 8: Run the enforced benchmarks**

```bash
npm run bench:quality
npm run bench:regressions
npm run bench:latency
```

Expected: all three pass and report numbers within ±5% of `tooling/artifacts/baseline-*`. If any track regresses > 5%, STOP and diagnose before committing.

- [ ] **Step 9: Confirm file size budget**

Run: `wc -l engine/repository/<target>.ts engine/repository.ts`
Expected:
- Target file ≤ 800 lines.
- `engine/repository.ts` line count decreased by approximately the cluster size.

- [ ] **Step 10: Commit**

```bash
git add engine/repository/<target>.ts engine/repository.ts
git commit -m "$(cat <<'EOF'
refactor: extract <cluster> from repository.ts

Mechanical extraction. No behavior changes. Public surface preserved
via re-export from engine/repository.ts.

Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Push and open PR**

```bash
git push -u origin refactor/repo-<cluster-name>
gh pr create --title "refactor: extract <cluster> from repository.ts" --body "$(cat <<'EOF'
## Summary
- Moves <list of public symbols> from \`engine/repository.ts\` to \`engine/repository/<target>.ts\`
- Re-exports preserve the public surface
- No behavior changes

## Benchmarks vs baseline
- bench:quality: within ±X.X% of baseline
- bench:regressions: pass
- bench:latency: within ±X.X% of baseline (p50/p95/p99 numbers in CI logs)

## Test plan
- [ ] CI green
- [ ] \`npx madge --circular engine/repository/\` is clean
- [ ] Reviewer confirms \`wc -l engine/repository/<target>.ts\` ≤ 800

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 12: Wait for merge before starting the next cluster**

Do not stack cluster branches. Each cluster touches `engine/repository.ts`; concurrent branches will conflict.

---

## Cluster-Specific Detail

These sections specify, for each cluster, *what to move*. The procedure for each is Steps 1–12 above.

### C1: Setup directory + barrel

**Files:**
- Create: `engine/repository/index.ts`

The barrel starts empty and grows as each cluster lands. Initial content:

```typescript
// Public surface barrel for engine/repository.
// As clusters land, they add `export * from "./<file>.js"` here.
//
// During the migration window, engine/repository.ts also re-exports
// from this barrel via `export * from "./repository/index.js"`.
//
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

// (Empty for now; cluster PRs will append below.)
```

After creating the barrel, add to the **top of `engine/repository.ts`**:

```typescript
export * from "./repository/index.js";
```

(This is a no-op until clusters add real re-exports.)

Commit: `refactor: scaffold engine/repository/ barrel`. Run build + tests + benchmarks per the universal procedure.

---

### C2: Paths (`engine/repository/paths.ts`)

Move these functions and their internal helpers from `engine/repository.ts`:

- `homedir` (line ~152)
- `isAbsolutePath` (line ~166)
- `normalizePathSeparators` (line ~195)
- `getRelativePathFromPrefix` (line ~204)
- `resolve` (line ~231)
- `getDefaultDbPath` (line ~330)
- `getPwd` (line ~350)
- `getRealPath` (line ~354)
- `enableProductionMode` (line ~326) **if it only mutates path state; otherwise leave for store cluster**
- Types `VirtualPath` (line ~366) and helpers:
  - `normalizeVirtualPath` (line ~382)
  - `parseVirtualPath` (line ~409)
  - `buildVirtualPath` (line ~426)
  - `isVirtualPath` (line ~439)
  - `resolveVirtualPath` (line ~459)
  - `toVirtualPath` (line ~482)

Update `engine/repository/index.ts` to add:

```typescript
export * from "./paths.js";
```

Notes:
- `resolveVirtualPath` takes a `Database` argument — `Database` is imported from `better-sqlite3`. Pull that import into `paths.ts`.
- These functions have no behavior dependencies on the storage layer; the file is pure utilities.

---

### C3: Store / DB lifecycle (`engine/repository/store.ts`)

Move:

- `createSqliteVecUnavailableError`, `getErrorMessage` (private helpers, ~516)
- `verifySqliteVecLoaded` (~529)
- `initializeDatabase` (~543)
- `ensureVectorIndexIntegrity` (~585)
- `isSqliteVecAvailable` (~640)
- `ensureVecTableInternal` (~644)
- `Store` type (~665)
- `createStore` (~761)
- `getDocid` (~887), `emojiToHex`, `handelize` (~901, ~909) — content-addressing helpers, move with store
- `getIndexHealth` and `IndexHealthInfo` (~1093–1099)
- `vacuumDatabase` (~1232), `walCheckpointTruncate` (~1236), `cleanupSqliteSidecars` (~1245)
- `getHashesNeedingEmbedding` (~1083)
- `getIndexCapabilities` (~1467)

Barrel addition:

```typescript
export * from "./store.js";
```

Notes:
- This is the largest "infrastructure" cluster. After this PR, `engine/repository.ts` should be ~3700 lines.
- `createStore` references a `Database` type and `sqlite-vec` extension loader; pull all relevant imports.
- `enableProductionMode` (from C2) may live here instead if it sets store-level flags. Re-evaluate during extraction.

---

### C4: Types (`engine/repository/types.ts`)

Move public type aliases and interfaces that are shared across modules. Do this **after C3 lands** so we know which storage types are settled. Types to move:

- `DocumentResult` (~866)
- `SearchResult` (~965)
- `RankedResult` (~974)
- `RRFContributionTrace` (~983), `RRFScoreTrace` (~994)
- `HybridQueryExplain` (~1002)
- `DocumentNotFound` (~1021), `MultiGetResult` (~1030)
- `CollectionInfo` (~1039), `IndexStatus` (~1047)
- `ExpandedQuery` (~143)
- `SnippetResult` (~3476)
- `SearchHooks` (~3792), `SearchRoutingProfile` (~3815), `StructuredSearchDiagnostics` (~3817)
- `HybridQueryOptions` (~3867), `HybridQueryResult` (~3879), `RankedListMeta` (~3892)
- `VectorSearchOptions` (~4164), `VectorSearchResult` (~4171)
- `StructuredSubSearch` (~4245), `StructuredSearchOptions` (~4254), `StructuredSearchWithDiagnosticsResult` (~4274)

Update barrel:

```typescript
export type * from "./types.js";
```

Where a moved type references a runtime symbol (e.g., a class) that lives elsewhere, import it. If the type references something that hasn't been moved yet, leave it for now — the type will move into `types.ts` during a later cluster's PR.

---

### C5: Content & documents (`engine/repository/content.ts`)

Move:

- `insertContent` (~1320)
- `insertDocument` (~1328)
- `upsertDocumentIngestion` (~1348)
- `upsertDocumentLinks` (~1375)
- `getLinkedDocuments` (~1391), `getBacklinkedDocuments` (~1397)
- `getGraphConnectedCandidates` (~1403)
- `findActiveDocument` (~1493)
- `updateDocumentTitle` (~1508), `updateDocument` (~1522)
- `deactivateDocument` (~1536)
- `getActiveDocumentPaths` (~1555)
- `hashContent` (~1274)
- `extractTitle` (~1302)
- `deleteInactiveDocuments` (~1165)
- `cleanupOrphanedContent` (~1174), `cleanupOrphanedVectors` (~1186)

Barrel:

```typescript
export * from "./content.js";
```

---

### C6: Chunking (`engine/repository/chunking.ts`)

Move:

- `chunkDocument` (~1564)
- `chunkDocumentByTokens` (~1631)
- Re-export the symbols already imported from peripheral files: `formatQueryForEmbedding`, `formatDocForEmbedding` (line ~1562). Those originate in `engine/inference.ts`; this cluster preserves the existing pass-through.

The `scanBreakPoints, findCodeFences, isInsideCodeFence, findBestCutoff` re-export at line 70 also belongs here (chunking concerns). Move that re-export line too.

Barrel:

```typescript
export * from "./chunking.js";
```

---

### C7: Docid / similarity / glob (`engine/repository/docid.ts`)

Move:

- `normalizeDocid` (~1765), `isDocid` (~1787)
- `findDocumentByDocid` (~1800)
- `levenshtein` (private helper, ~1724)
- `findSimilarFiles` (~1816)
- `matchFilesByGlob` (~1831)

Barrel:

```typescript
export * from "./docid.js";
```

---

### C8: Context annotations (`engine/repository/context-annotations.ts`)

Move:

- `getContextForPath` (~1893)
- `getContextForFile` (~1937)
- `insertContext` (~2109)
- `deleteContext` (~2124)
- `deleteGlobalContexts` (~2134)
- `listPathContexts` (~2157)
- `getCollectionsWithoutContext` (~2191)
- `getTopLevelPathsWithoutContext` (~2223)

Barrel:

```typescript
export * from "./context-annotations.js";
```

---

### C9: Collections (`engine/repository/collections.ts`)

Move:

- `getCollectionByName` (~2024)
- `listCollections` (~2039)
- `removeCollection` (~2070)
- `renameCollection` (~2093)
- `getAllCollections` (~2182)

Barrel:

```typescript
export * from "./collections.js";
```

---

### C10: FTS (`engine/repository/fts.ts`)

Move:

- `sanitizeFTS5Term` (~2276)
- `buildFTS5Query` (~2297)
- `validateSemanticQuery` (~2369), `validateLexQuery` (~2377)
- `searchFTS` (~2388)

Barrel:

```typescript
export * from "./fts.js";
```

---

### C11: Vector storage + search

Split into two files (the cluster grew enough to warrant separation):

**`engine/repository/vec.ts`** — search:
- `getMainDatabasePath` (~2449)
- `mapVectorMatchesToDocuments` (~2455)
- `searchVec` (~2524)

**`engine/repository/embeddings.ts`** — storage:
- `getEmbedding` (private, ~2604)
- `getHashesForEmbedding` (~2617)
- `clearAllEmbeddings` (~2632)
- `getInsertEmbeddingStmts` (~2648), `insertEmbedding` (~2666)
- `getBulkInsertTxn` (~2696), `bulkInsertEmbeddings` (~2738)

Barrel:

```typescript
export * from "./vec.js";
export * from "./embeddings.js";
```

---

### C12: LLM cache (`engine/repository/llm-cache.ts`)

Move:

- `getCacheKey` (~1117)
- `getCachedResult` (~1124)
- `setCachedResult` (~1129)
- `clearCache` (~1144)
- `deleteLLMCache` (~1156)

Barrel:

```typescript
export * from "./llm-cache.js";
```

---

### C13: Rerank queue (`engine/repository/rerank-queue.ts`)

Move:

- `RerankQueueConfig` type (if defined inline; locate via `grep -n "RerankQueueConfig" engine/repository.ts`)
- `RerankQueueSnapshot` type
- `QueueController` type
- `getQueueController` (~3632)
- `makeQueueRelease` (~3654)
- `acquireRerankSlot` (~3676)
- `getRerankQueueSnapshot` (~3716)
- `parsePositiveInt` (~3736)
- `getRerankThroughputSnapshot` (~3742)
- `runWithConcurrencyLimit` (~3757)

This cluster carries module-level state (queue controller map). When moving, preserve the singleton: the map lives at module top-level inside `rerank-queue.ts`.

Barrel:

```typescript
export * from "./rerank-queue.js";
```

---

### C14: Retrieval orchestrators

This is the largest single cluster of *logic* but is split into focused files because each represents an independent step in the pipeline.

Create:

- `engine/repository/retrieval/expansion.ts` — move `expandQuery` (~2757)
- `engine/repository/retrieval/rerank.ts` — move `rerank` (~2812). Imports from `./rerank-queue.js` for `acquireRerankSlot`.
- `engine/repository/retrieval/rrf.ts` — move `reciprocalRankFusion` (~2887), `buildRrfTrace` (~2936)
- `engine/repository/retrieval/document-lookup.ts` — move `hasDocumentIngestTable` (~3018), `findDocument` (~3037), `findDocuments` (~3251), `getDocumentBody` (~3201), `getStatus` (~3386), `extractSnippet` (~3484), `addLineNumbers` (~3556), `withTimeout` (~3561)
- `engine/repository/retrieval/hybrid.ts` — move `hybridQuery` (~3911)
- `engine/repository/retrieval/vector-query.ts` — move `vectorSearchQuery` (~4190)
- `engine/repository/retrieval/structured.ts` — move `structuredSearch` (~4297), `structuredSearchWithDiagnostics` (~4306)

Because the orchestrators import from every storage primitive cluster, **C14 must land after C2–C13**. Split C14 itself into seven PRs if any file exceeds 800 LOC; otherwise land as one PR.

Barrel:

```typescript
export * from "./retrieval/expansion.js";
export * from "./retrieval/rerank.js";
export * from "./retrieval/rrf.js";
export * from "./retrieval/document-lookup.js";
export * from "./retrieval/hybrid.js";
export * from "./retrieval/vector-query.js";
export * from "./retrieval/structured.js";
```

---

### C15: Indexing (`engine/repository/indexing.ts`)

Move:

- `indexSingleFile` (~4892)
- `unlinkSingleFile` (~4962)

These import from `content`, `chunking`, `embeddings`, `fts`. They're orchestrators of storage primitives, not retrieval — keep them at the top level of `engine/repository/`, not under `retrieval/`.

Barrel:

```typescript
export * from "./indexing.js";
```

---

### C16: Final cleanup — delete `engine/repository.ts`

At this point `engine/repository.ts` should consist entirely of:

```typescript
export * from "./repository/index.js";
```

…and nothing else (no remaining function definitions).

- [ ] **Step 1: Verify `engine/repository.ts` has no logic**

Run: `wc -l engine/repository.ts && grep -nE "^(export function|export async function|function|async function|class )" engine/repository.ts`
Expected: line count < 20; no function/class definitions in `grep` output.

- [ ] **Step 2: Replace `engine/repository.ts` with a redirect or remove it**

Two options:

**Option A — keep the file as a single-line pass-through (most consumer-friendly):** leave `engine/repository.ts` containing only `export * from "./repository/index.js";`. Consumers that imported from `engine/repository.js` continue working.

**Option B — delete and update consumers:** delete `engine/repository.ts`, update every import path inside `engine/` to point at `engine/repository/index.js` (or specific submodules). External consumers (specs in `specs/`) are NOT changed in this plan — they continue to import from `engine/repository.js`, which… won't exist. So Option B requires updating all 13 `specs/*.test.ts` files that import from `repository`. **Do not pick Option B in this plan.**

Recommendation: pick Option A. The single-line pass-through is permanent and free.

- [ ] **Step 3: Add the structure tests**

Create `specs/repository-structure.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("engine/repository structure", () => {
  const dir = join(__dirname, "..", "engine", "repository");
  const files = readdirSync(dir, { recursive: true })
    .filter((f) => typeof f === "string" && f.toString().endsWith(".ts")) as string[];

  test("every file ≤ 800 lines", () => {
    for (const f of files) {
      const path = join(dir, f);
      const lines = readFileSync(path, "utf8").split("\n").length;
      expect(lines, `${f} has ${lines} lines`).toBeLessThanOrEqual(800);
    }
  });

  test("average file < 700 lines", () => {
    let total = 0;
    for (const f of files) {
      total += readFileSync(join(dir, f), "utf8").split("\n").length;
    }
    expect(total / files.length).toBeLessThan(700);
  });
});
```

Create `specs/repository-barrel.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as barrel from "../engine/repository/index.js";

describe("engine/repository public surface", () => {
  const baselinePath = join(__dirname, "..", "tooling", "artifacts", "baseline-repository-functions.txt");
  const baseline = readFileSync(baselinePath, "utf8");

  // Extract the symbol names from the baseline file (e.g., "export function homedir(" -> "homedir")
  const exportedNames = baseline
    .split("\n")
    .map((line) => {
      const match = line.match(/export (?:async )?(?:function|const|class|type) (\w+)/);
      return match ? match[1] : null;
    })
    .filter((s): s is string => s !== null);

  test.each(exportedNames)("barrel exports %s", (name) => {
    expect((barrel as Record<string, unknown>)[name]).toBeDefined();
  });
});
```

- [ ] **Step 4: Run all tests + benchmarks one last time**

```bash
npm run build
npm test
npm run test:packages
npm run bench:quality
npm run bench:regressions
npm run bench:latency
```

Expected: all green, benchmarks within ±5% of baseline.

- [ ] **Step 5: Commit and open the final PR**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: finalize repository decomposition

engine/repository.ts is now a single-line pass-through to
engine/repository/index.js. All clusters (C2–C15) have landed.
Adds repository-structure and repository-barrel tests guarding
the file-size budget and public surface.

Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin refactor/repo-final
gh pr create --title "refactor: finalize repository decomposition" --body "Final cluster in the W1 program. See spec §5 and the per-cluster PRs that preceded this."
```

---

## Done Criteria (matches spec §5.6)

- `engine/repository.ts` is a single-line re-export of `engine/repository/index.js`.
- Every file under `engine/repository/` is ≤ 800 LOC; the directory average is < 700.
- `tooling/artifacts/baseline-*` benchmarks reproduced within ±5%.
- 13 existing `specs/*.test.ts` that imported from `engine/repository.js` still pass unchanged.
- Two new structure tests (`specs/repository-structure.test.ts`, `specs/repository-barrel.test.ts`) pass.
- `npx madge --circular engine/repository/` reports no circular dependencies.

## Failure / Rollback

If any cluster's PR shows a > 5% benchmark regression:

1. Do not merge.
2. Bisect inside the PR by reverting half of the moved functions back to `engine/repository.ts` and re-running benchmarks until the offender is found.
3. Typical causes: a function that was inlined by V8 in the original file is now a cross-module call; or a circular import added a wrapping module that defeats hoisting.
4. Fix: usually relocating one function or adding `/** @inline */` (if used in this codebase — check `engine/` first; do not introduce new conventions).

Cluster PRs are independent. If a cluster has to be reverted, only that one is rolled back; downstream clusters that haven't run yet are unaffected.
