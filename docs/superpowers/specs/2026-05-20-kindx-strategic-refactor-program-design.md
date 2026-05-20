# KINDX Strategic Refactor Program — Design

**Date:** 2026-05-20
**Status:** Draft, awaiting review
**Author:** Expert design pass (Claude Code)
**Target branch:** new `program/strategic-refactor` (one PR per workstream)

---

## 1. Purpose and Scope

This document is the single design covering four independent but coordinated workstreams that address the operational and architectural weaknesses surfaced in the project audit. Each workstream below can be executed on its own branch, in its own PR, with its own implementation plan. They share only the constraints in §3.

In scope:

1. **W1** — Decompose `engine/repository.ts` (~5000 LOC) into focused modules.
2. **W2** — Decide and execute the Python integration strategy for `python/kindx-langchain`.
3. **W3** — Prove-or-prune the Arch sidecar integration (`engine/integrations/arch/`).
4. **W4** — Resolve the `openclaw-integration/` sibling-subtree (1.2 GB vendored fork) with a stable extension model.

Out of scope:

- New retrieval features, new MCP tools, new model backends.
- BENCHMARKS.md changes, except where a workstream needs a new benchmark to prove non-regression.
- Cross-cutting CLI UX rework.

## 2. Success Criteria (Program-Level)

The program is done when **all** of the following are true:

- `engine/repository.ts` no longer exists; its responsibilities live in ≤ 12 focused modules averaging < 700 LOC each, with `repository/index.ts` as a re-export barrel for back-compat.
- `npm run bench:quality`, `npm run bench:regressions`, and `npm run bench:latency` produce results within ±5% of the pre-refactor baseline captured in §6.
- The Python integration's status (kept-and-invested, kept-as-thin-adapter, or removed) is declared in a top-level `PYTHON.md` and matches what ships.
- The Arch integration is either (a) on by default with documented adoption metric, or (b) removed from the engine and moved to `experiments/` or an out-of-repo plugin.
- `openclaw-integration/` is no longer a sibling subtree in this repo; it's either extracted to its own repo, consumed via a published package, or removed.
- All 59 existing spec files in `specs/` still pass. No new `.test.ts` is deleted; some may be relocated.

## 3. Shared Constraints

These apply to all four workstreams:

- **No public surface breakage.** External consumers import from `engine/repository.js` (now re-export barrel), the published `@ambicuity/kindx-schemas`, `@ambicuity/kindx-client`, and the MCP tool list in `engine/protocol.ts`. None of those change.
- **Benchmarks gate every workstream.** Each PR must show before/after numbers for the three enforced tracks (`bench:quality`, `bench:regressions`, `bench:latency`). A regression > 5% on any reported percentile blocks the PR.
- **No combined PRs across workstreams.** Each workstream lands in its own PR so a revert affects only one concern.
- **No new dependencies** unless explicitly listed in a workstream's design below.
- **Conventional Commits** (the recent commits on `main` use `chore:` / `Merge pull request` — follow that).

## 4. Pre-Program Capture (Required Before W1 Starts)

Before any workstream begins, capture a frozen baseline. This is a single small PR.

- `npm run bench:quality > tooling/artifacts/baseline-quality.json`
- `npm run bench:regressions > tooling/artifacts/baseline-regressions.json`
- `npm run bench:latency > tooling/artifacts/baseline-latency.json`
- `wc -l engine/*.ts > tooling/artifacts/baseline-loc.txt`
- Snapshot the function listing of `engine/repository.ts` (the list in §5.1) as `tooling/artifacts/baseline-repository-functions.txt`.

Commit these under one PR titled `chore: capture pre-refactor baseline`. They are write-once; do not overwrite during the program.

---

## 5. Workstream W1 — Decompose `engine/repository.ts`

### 5.1 Current State (Evidence)

`engine/repository.ts` is 4974 lines and exports ~80 public symbols. Reading the function listing, the file does at least 11 separable jobs:

| Cluster | Approx. line range | Representative symbols |
|---|---|---|
| Path / virtual-path utils | 152–499 | `homedir`, `normalizePathSeparators`, `parseVirtualPath`, `toVirtualPath` |
| DB lifecycle and integrity | 516–1245 | `createStore`, `initializeDatabase`, `ensureVectorIndexIntegrity`, `cleanupSqliteSidecars` |
| Content & document CRUD | 1274–1562 | `insertContent`, `insertDocument`, `upsertDocumentIngestion`, `deactivateDocument`, link/backlink helpers |
| Chunking | 1564–1724 | `chunkDocument`, `chunkDocumentByTokens` |
| Docid / similarity / glob | 1765–1893 | `normalizeDocid`, `findSimilarFiles`, `matchFilesByGlob` |
| Context annotations | 1893–2191 | `getContextForPath`, `insertContext`, `deleteContext` |
| Collections | 2024–2191 | `getCollectionByName`, `listCollections`, `renameCollection` |
| FTS query construction | 2276–2449 | `sanitizeFTS5Term`, `buildFTS5Query`, `searchFTS` |
| Vector search | 2455–2604 | `searchVec`, `mapVectorMatchesToDocuments` |
| Embedding storage | 2617–2757 | `getHashesForEmbedding`, `insertEmbedding`, `bulkInsertEmbeddings` |
| Query expansion / rerank / RRF | 2757–3018 | `expandQuery`, `rerank`, `reciprocalRankFusion`, `buildRrfTrace` |
| Document lookup & snippet | 3037–3556 | `findDocument`, `findDocuments`, `getDocumentBody`, `extractSnippet` |
| Rerank queue / backpressure | 3632–3757 | `getQueueController`, `acquireRerankSlot`, `getRerankThroughputSnapshot` |
| Hybrid orchestration | 3792–4164 | `hybridQuery`, `SearchHooks`, `StructuredSearchDiagnostics` |
| Structured / vector public API | 4164–4892 | `vectorSearchQuery`, `structuredSearch`, `structuredSearchWithDiagnostics` |
| Indexing helpers | 4892–4974 | `indexSingleFile`, `unlinkSingleFile` |

### 5.2 Target Structure

Replace `engine/repository.ts` with a directory `engine/repository/`:

```
engine/repository/
├── index.ts                  # Re-export barrel (only public API)
├── paths.ts                  # Path & virtual-path utils
├── store.ts                  # createStore, DB lifecycle, vec integrity
├── content.ts                # Content & document CRUD + links
├── chunking.ts               # chunkDocument, chunkDocumentByTokens
├── docid.ts                  # docid, similarity, glob matching
├── context-annotations.ts    # context CRUD
├── collections.ts            # collection registry queries
├── fts.ts                    # FTS5 query construction & searchFTS
├── vec.ts                    # searchVec, mapping helpers
├── embeddings.ts             # embedding storage (read/write/bulk)
├── llm-cache.ts              # cache_key/getCachedResult/setCachedResult
├── rerank-queue.ts           # backpressure queue, snapshot
├── retrieval/                # Three thin orchestrators built on the above
│   ├── expansion.ts          # expandQuery
│   ├── rerank.ts             # rerank (uses rerank-queue)
│   ├── rrf.ts                # reciprocalRankFusion, buildRrfTrace
│   ├── hybrid.ts             # hybridQuery
│   ├── vector-query.ts       # vectorSearchQuery
│   └── structured.ts         # structuredSearch + diagnostics
└── indexing.ts               # indexSingleFile, unlinkSingleFile
```

**Why this split:**
- Storage primitives (`content`, `embeddings`, `fts`, `vec`) have no dependencies on retrieval orchestration. Today they're tangled with it via shared module-level state.
- The three retrieval orchestrators (`hybrid`, `vector-query`, `structured`) are the consumer-facing API. They depend on primitives, never the reverse.
- `rerank-queue.ts` carries module-level state today; isolating it makes the lifecycle (controllers, snapshots) testable in one place.
- `retrieval/` subfolder makes the "what is the query path?" question one directory listing.

### 5.3 Migration Strategy

**Phase A — Mechanical extraction (no logic changes):**
1. Create the directory and empty stub files.
2. For each cluster, move functions into the target file. Update imports inside the cluster.
3. Re-export every previously-public symbol from `engine/repository/index.ts`.
4. Add `engine/repository.ts` → `export * from "./repository/index.js"` for one release cycle, then delete in a follow-up PR.
5. Run `npm run build` + `npm test` after each cluster move. Commit per cluster.

**Phase B — Surgical detangling (allowed, scoped):**
- Module-level singletons (rerank queue controllers, cached prepared statements) move into their owning module behind a getter — no new pattern, just localizes scope.
- Cross-cluster imports that reveal a wrong-direction dependency (e.g., a primitive importing from an orchestrator) get fixed by moving the offending helper to the primitive layer.
- No API renames in this workstream. No behavior changes. No "while I'm here" cleanups.

**Phase C — Repository-internal type consolidation:**
- Move shared types (`DocumentResult`, `SearchResult`, `RankedResult`, `HybridQueryExplain`, `IndexStatus`, `StructuredSubSearch`, etc.) to `engine/repository/types.ts`. Other modules import from there.

### 5.4 Risk and Mitigation

| Risk | Mitigation |
|---|---|
| Regression in hottest code path | §4 baseline must be reproduced within ±5% on every PR. |
| Hidden circular imports | `npm run build` enforces this; ESM cycles fail loudly. Run `madge --circular engine/repository/` as a one-off check before each PR. |
| Test relocation breaks coverage | Tests in `specs/` import from `engine/repository.js`. The re-export barrel preserves this. Don't relocate tests in W1. |
| Reviewer fatigue from large PR | Land Phase A as **one PR per cluster** (≤ 14 PRs). Phase B+C are smaller follow-ups. |

### 5.5 Testing

- All 59 existing `specs/*.test.ts` must pass unchanged.
- Add `specs/repository-structure.test.ts` that asserts `wc -l` of every new module is < 800 (lint-as-test).
- Add `specs/repository-barrel.test.ts` that imports the full public surface from `engine/repository/index.ts` and checks each export is defined (snapshot test against `tooling/artifacts/baseline-repository-functions.txt`).

### 5.6 Done Definition for W1

- `engine/repository.ts` deleted; `engine/repository/index.ts` re-exports same public surface.
- All target files ≤ 800 LOC, average < 700.
- Baselines from §4 reproduced within ±5%.
- All existing tests pass; two new structure tests added.

---

## 6. Workstream W2 — Python Integration Decision

### 6.1 Current State (Evidence)

`python/kindx-langchain/` contains:
- `pyproject.toml`
- `README.md`
- `src/kindx_langchain/` (package source)
- `tests/test_retriever.py` (single file)
- An optional `langchain-core>=0.3.0` extra

It is a single-file retriever wrapper. The root README presents it as a peer feature, but the surface area says otherwise.

### 6.2 Decision Required

This workstream is a **decision plus the work to make the decision real**. Pick exactly one option, then execute the matching plan.

**Option A — Keep thin, label honestly (recommended).**
- Acknowledge it's a thin convenience adapter, not a product.
- Add a one-line banner to `python/kindx-langchain/README.md`: *"Thin LangChain retriever wrapper around the KINDX HTTP API. For complete integration, call `/query` directly."*
- Keep the test, keep CI green, no investment.
- Cost: ~1 hour, almost no risk.

**Option B — Invest into a real Python product.**
- Add: a sync + async client, retry/backoff, streaming `/query/stream` support, structured-query helpers, type stubs, examples covering RAG patterns (LangChain, LlamaIndex, raw httpx), a `tests/integration/` suite that spins up the HTTP server.
- Publish to PyPI as `kindx-langchain` (or rename to `kindx` if the namespace is free).
- Cost: 2–3 weeks of focused work; commits Python to being a supported language tier going forward.

**Option C — Remove from this repo, move to its own.**
- Extract `python/kindx-langchain/` to a sibling repo (`kindx-py` or similar). Reference it from the root README.
- Cost: low; communicates "we are a TypeScript project."

### 6.3 Recommendation

**Option A**, unless there is concrete demand data (downloads, issues, integration requests) that justifies the cost of B. The README currently overstates the maturity of the Python surface; correcting the framing is the cheapest fix and removes a credibility risk.

### 6.4 Done Definition for W2

- Decision recorded in `PYTHON.md` at the repo root.
- README updated to reflect the decision.
- If A: banner present, no other changes.
- If B: separate spec document required; this workstream becomes "produce the W2-B spec," not "implement it."
- If C: directory deleted from this repo, link added to root README pointing at the new home, root `package.json` `test:python` script removed.

---

## 7. Workstream W3 — Arch Sidecar Prove-or-Prune

### 7.1 Current State (Evidence)

`engine/integrations/arch/` already has clean isolation: 8 files (`adapter.ts`, `augment.ts`, `config.ts`, `contracts.ts`, `distill.ts`, `importer.ts`, `parser.ts`, `runner.ts`). Used in `engine/kindx.ts` and `engine/protocol.ts` only through `KINDX_ARCH_*` env flags. Every flag defaults to off (`KINDX_ARCH_ENABLED`, `KINDX_ARCH_AUGMENT_ENABLED`, `KINDX_ARCH_AUTO_REFRESH_ON_UPDATE`).

The structural problem is not the code — it's that no shipped path turns it on. A feature with no on-switch in production is dead weight; a feature with an on-switch that no one uses is worse, because it accumulates maintenance cost.

### 7.2 Decision Required

**Option A — Make Arch the default for a defined audience (recommended if there is real usage).**
- Flip `KINDX_ARCH_ENABLED` default to `1` for the Docker image (`Dockerfile` sets env).
- Wire the `arch_query` MCP tool registration unconditionally; today it's behind a flag.
- Add a section to `README.md` explaining when Arch hints help and the latency cost.
- Add `bench:arch` track that runs the same query set with/without Arch and reports recall delta. Gate it like the other enforced tracks.

**Option B — Move to `experiments/`.**
- Relocate `engine/integrations/arch/` to `experiments/arch/`.
- Add `experiments/README.md` describing the directory's policy: not built by default, not in the published package, allowed to break.
- Remove Arch refs from `engine/kindx.ts`, `engine/protocol.ts`. Strip the `KINDX_ARCH_*` env vars from the README.
- The MCP tool `arch_query` and the maintenance tool `arch_status` are removed.

**Option C — Extract to a separate plugin package.**
- Make it `@ambicuity/kindx-arch`, a peer dep loaded dynamically when `KINDX_ARCH_ENABLED=1`.
- Cleanest separation but requires the W4 extension model first. Do not pick C unless W4 is also chosen.

### 7.3 Recommendation

**Option B**, unless there is internal telemetry that shows Arch hints measurably improve recall on representative workloads. Optionality is not free — every env var is documentation surface, every conditional path is a test matrix dimension. If the feature is not on by default, it should not be in the main engine.

### 7.4 Done Definition for W3

- Decision recorded in commit message and a one-line entry in `CHANGELOG.md`.
- If A: defaults flipped, bench track added, README updated, `KINDX_ARCH_*` table in README marked as supported.
- If B: code relocated to `experiments/`, all references in `engine/` and README removed, `arch:status` / `arch:refresh` scripts removed from `package.json`, `arch_query` and Arch-related maintenance MCP tools removed from `engine/protocol.ts`.
- If C: blocked on W4 landing first.

---

## 8. Workstream W4 — Resolve `openclaw-integration/`

### 8.1 Current State (Evidence)

`openclaw-integration/` is **1.2 GB** at the root of this repo. It contains:
- Its own `apps/`, `extensions/`, `docs/`, `src/`, `Swabble/` subprojects.
- Three Dockerfiles (`Dockerfile`, `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`, `Dockerfile.sandbox-common`).
- Its own `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `AGENTS.md`, `appcast.xml`, fly.io configs (`fly.toml`, `fly.private.toml`).
- A separate test target wired into root `package.json` as `npm run test:openclaw-integration` (pnpm-based).

This is not a KINDX integration. It is a separate product vendored in. Every clone pays the 1.2 GB cost; every CI run risks coupling KINDX's release to OpenClaw's. This is the single largest architectural liability in the repo.

### 8.2 Decision Required

**Option A — Extract to a sibling repo (recommended).**
- Create `ambicuity/openclaw-kindx-integration` (or whatever the canonical home is).
- Copy `openclaw-integration/` there with full git history (`git filter-repo` or `git subtree split`).
- Replace the directory in this repo with a top-level reference (link in README, optionally a git submodule if the integration tests are run together).
- Remove `npm run test:openclaw-integration` from `npm run test:all` and from `package.json`. Or, if the integration test is essential to KINDX correctness, keep a CI workflow that clones the sibling repo on demand.

**Option B — Consume via a published package.**
- Publish a thin `@ambicuity/kindx-openclaw` package with just the integration surface (probably an MCP server config helper + adapter). Everything else stays out of this repo.
- Requires identifying what minimal contract KINDX needs to expose to make OpenClaw's integration work without vendoring.

**Option C — Define a stable extension model first, then any partner integration plugs in via it.**
- Define `engine/extensions/` with a documented plugin contract (registration shape, lifecycle hooks, MCP tool injection).
- Migrate Arch and OpenClaw to that contract over time.
- This is the largest scope; do not bundle into W4.

### 8.3 Recommendation

**Option A**, immediately. The repo size alone is a strong signal that the wrong default was chosen. A 1.2 GB sibling subtree wasn't a deliberate design — it was the path of least resistance during integration work. Extracting it now is mostly mechanical.

Option C is the right *long-term* answer but is itself a major workstream that should not be coupled to fixing the immediate symptom.

### 8.4 Risk and Mitigation

| Risk | Mitigation |
|---|---|
| Loss of git history during extraction | Use `git filter-repo --subdirectory-filter openclaw-integration/`. Verify history is preserved before deleting from this repo. |
| Breaking OpenClaw's CI that depends on this repo's structure | Coordinate with OpenClaw maintainers; this is not a unilateral change. |
| Integration test coverage gap | Either (a) keep the integration test running against the published kindx package in the sibling repo, or (b) write a minimal in-repo smoke test that exercises the OpenClaw adapter surface only. |

### 8.5 Done Definition for W4

- `openclaw-integration/` directory removed from this repo.
- Sibling repo created with preserved history (verify `git log --follow` works for at least 3 representative files).
- `npm run test:openclaw-integration` script and its dependencies removed from root `package.json`.
- `npm run test:all` no longer references it.
- A short paragraph in root README under "Integrations" links to the sibling repo.
- `du -sh .git` of this repo drops measurably (target: > 50% reduction).

---

## 9. Sequencing and Dependencies

```
W4 (extract openclaw-integration)
  └─ unblocks: nothing, but should land first because it lowers cost of every subsequent clone/CI run

W1 (decompose repository.ts)
  └─ depends on: §4 baseline capture
  └─ unblocks: future feature work that touches retrieval

W3 (Arch prove-or-prune)
  └─ independent of W1 and W4; can run in parallel
  └─ Option C requires extension model (out of scope here)

W2 (Python decision)
  └─ independent; smallest scope; can land any time
```

**Recommended order:**
1. **Pre-program baseline capture** (§4) — required before W1.
2. **W4** — biggest blast-radius reduction, no engineering risk.
3. **W2** — single decision + small documentation PR.
4. **W3** — feature decision; whichever option, scope is bounded.
5. **W1** — largest engineering effort; benefits most from a clean repo (W4 done) and from not racing other changes in `engine/`.

Each workstream lands in its own branch, its own PR(s), and is independently revertable.

## 10. Open Questions for User

These need answers before W2 and W3 execution start, but **do not** block W4 or W1 baseline capture:

- **W2:** Is there any data on Python wrapper adoption (PyPI downloads, GitHub stars on a fork, user requests)? Answer determines A vs B vs C.
- **W3:** Is there internal usage of Arch hints with measured recall improvement? Answer determines A vs B.
- **W4:** Who owns `openclaw-integration/` upstream and what is the coordination surface for extracting it?

## 11. What Is Explicitly NOT in This Spec

- A unified plugin/extension API (this is W4 Option C; deferred).
- Improvements to BENCHMARKS.md itself.
- New MCP tools, new retrieval features, new model backends.
- A migration of `engine/inference.ts` (2002 LOC) — separate concern; same pattern as W1 may apply later but is not part of this program.
- Any change to `@ambicuity/kindx-schemas` or `@ambicuity/kindx-client` public types.

## 12. Implementation Plan Hand-off

After this spec is approved, the next step is the `writing-plans` skill — one plan document per workstream, plus one for the baseline-capture PR. Each plan breaks its workstream into PR-sized, individually-reviewable tasks with explicit verification commands.

The plans are produced separately because mixing them produces an unreviewable mega-document. Approval of this spec is approval of the program shape, not of any specific PR's mechanics.
