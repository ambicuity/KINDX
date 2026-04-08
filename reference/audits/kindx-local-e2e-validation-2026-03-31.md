# KINDX Local Offline E2E Validation Report

Date: 2026-03-31 (America/Chicago)
Scope: KINDX core only (excluded `openclaw-integration`)
Mode: Local offline validation

## 1) Environment Readiness

- Repo state preserved (dirty worktree, no reverts/reset).
- Runtime:
  - `node v25.8.0`
  - `npm 11.11.0`
- Key note: local model runtime required `KINDX_CPU_ONLY=1` for manual embed/query flows on this host.

## 2) Architecture Map (KINDX Core)

### Component boundaries

- CLI Orchestrator: `engine/kindx.ts`
  - Command routing and UX surface (`collection`, `search`, `vsearch`, `query`, `get`, `multi-get`, `status`, `watch`, `mcp`, `embed`, `update`, `cleanup`, `verify-wipe`, `memory`, `migrate`, `skill install`).
- MCP Server: `engine/protocol.ts`
  - Server factory and transport layers.
  - Registered resource: `kindx://{+path}`.
  - Registered tools: `query`, `get`, `multi_get`, `status`, `memory_put`, `memory_search`, `memory_history`, `memory_stats`, `memory_mark_accessed`.
- Storage/Retrieval Engine: `engine/repository.ts`
  - Index schema bootstrap, FTS/vector search, hybrid fusion/rerank, document retrieval, status/health.
- Runtime DB abstraction: `engine/runtime.ts`
  - SQLite open and `sqlite-vec` loading.
- LLM/Embedding/Rerank runtime: `engine/inference.ts`
  - `LlamaCpp` class, session management (`withLLMSession`), query expansion, embeddings, rerank.
- Watcher daemon: `engine/watcher.ts`
  - Chokidar-based incremental indexing.
- Catalog config: `engine/catalogs.ts`
  - Collection config read/write and include/update command metadata.
- Rendering/output formats: `engine/renderer.ts`
  - JSON/CSV/XML/Markdown/files formatting and context fields.

### Primary data flow

- Index/update flow:
  1. CLI `collection add`/`update` in `engine/kindx.ts`
  2. File ingest/update in `engine/repository.ts`
  3. Schema tables: `content`, `documents`, `documents_fts`, `content_vectors`, `vectors_vec`, `llm_cache`, memory schema
- Vector flow:
  1. CLI `embed` (`engine/kindx.ts`)
  2. Chunk/tokenize + embed (`engine/repository.ts` + `engine/inference.ts`)
  3. Persist vectors in `content_vectors` + `vectors_vec`
- Query flow (hybrid):
  1. CLI `query` / MCP tool `query`
  2. Expansion (`expandQuery`), BM25 (`searchFTS`), vector (`searchVec`), fusion (`reciprocalRankFusion`), rerank (`rerank`)
  3. Render via `engine/renderer.ts`
- Document fetch flow:
  - `get`/`multi-get` CLI and MCP tool/resource path resolution to `findDocument`/`findDocuments` + formatter.

## 3) Automated Validation Results

### Full offline suite

Command:

```bash
npm test
```

Result:

- `Test Files: 14 passed (14)`
- `Tests: 590 passed (590)`
- `Duration: 136.23s`

### Focused critical rerun (reproducibility)

Command:

```bash
npx vitest run specs/command-line.test.ts specs/mcp.test.ts specs/inference.test.ts specs/memory.test.ts specs/store.test.ts specs/repository-paths.test.ts --reporter=verbose
```

Result:

- `Test Files: 6 passed (6)`
- `Tests: 437 passed (437)`
- `Duration: 112.30s`

## 4) Manual User-Journey E2E (Local)

### Proof command set executed

1. `./bin/kindx collection add <path> --name docs`
2. `./bin/kindx collection list`
3. `./bin/kindx collection show docs`
4. `./bin/kindx update`
5. `./bin/kindx embed`
6. `./bin/kindx search "authentication bearer" --json`
7. `./bin/kindx vsearch "ranked docs endpoint" --json`
8. `./bin/kindx query "how auth tokens work" --json`
9. `./bin/kindx get docs/readme.md`
10. `./bin/kindx multi-get "*.md" --json`
11. `./bin/kindx status --json`
12. `./bin/kindx verify-wipe --json`
13. `./bin/kindx mcp --http --port 8200` + `curl /health`
14. `./bin/kindx collection remove docs`

### Manual run outcomes

- Collection lifecycle: pass.
- Update/index refresh: pass.
- BM25 search + get + multi-get + status + verify-wipe: pass.
- Vector/hybrid (`embed`, `vsearch`, `query`) behavior:
  - Fails on default host config due Metal context init.
  - Passes with `KINDX_CPU_ONLY=1`.
- MCP HTTP daemon from CLI:
  - Could not bind in this sandbox (`listen EPERM ::1:<port>`), so CLI-level HTTP daemon runtime validation is inconclusive in this environment.

## 5) Feature-to-Validation Matrix

| Feature | Automated Coverage | Manual E2E | Status |
|---|---|---|---|
| Collection lifecycle (`add/list/show/remove/rename`) | `specs/command-line.test.ts` | Executed add/list/show/remove | Pass |
| Refresh/index update (`update`, stale deactivation) | `specs/command-line.test.ts`, `specs/store.test.ts` | Executed `update` | Pass |
| Vectorization (`embed`) | `specs/inference.test.ts`, `specs/store.test.ts`, `specs/evaluation.test.ts` | Executed `embed` | Pass with `KINDX_CPU_ONLY=1`; fail on default host config |
| BM25 search (`search`) | `specs/command-line.test.ts`, `specs/evaluation-bm25.test.ts`, `specs/store.test.ts` | Executed `search --json` | Pass |
| Vector search (`vsearch`) | `specs/store.test.ts`, `specs/evaluation.test.ts` | Executed `vsearch --json` | Pass with `KINDX_CPU_ONLY=1` |
| Hybrid + rerank (`query`) | `specs/mcp.test.ts`, `specs/inference.test.ts`, `specs/evaluation.test.ts` | Executed `query --json` | Pass with `KINDX_CPU_ONLY=1` |
| Document retrieval (`get`) | `specs/command-line.test.ts`, `specs/mcp.test.ts`, `specs/store.test.ts` | Executed `get` | Pass |
| Bulk retrieval (`multi-get`, filters/limits) | `specs/command-line.test.ts`, `specs/mcp.test.ts`, `specs/store.test.ts` | Executed `multi-get --json` | Pass |
| Output contracts (json/csv/xml/files/md) | `specs/renderer.test.ts`, `specs/command-line.test.ts` | JSON manually checked | Pass (automated full-format coverage) |
| MCP tools/resources/prompts surface | `specs/mcp.test.ts` | CLI daemon runtime blocked by sandbox | Pass in automated; manual daemon inconclusive |
| Status/health/cache maintenance | `specs/command-line.test.ts`, `specs/store.test.ts`, `specs/mcp.test.ts` | Executed `status`, `verify-wipe` | Pass |

## 6) High-Confidence Gaps / Risks

1. Host-runtime fragility for local LLM backend (manual `embed` failed without `KINDX_CPU_ONLY=1` on this machine).
2. CLI MCP HTTP daemon runtime could not be validated in this sandbox due port bind EPERM on `::1`; transport tests still pass in Vitest.
3. Manual proof flow discovered command-surface drift risk (`index`/`vector` no longer valid top-level commands; replaced by `update`/`embed`).

## 7) Ship Decision (Local Offline Scope)

Decision: **Conditional ship** for local offline use.

- Quality signal is strong (`590/590` full + `437/437` targeted critical rerun).
- Condition A: For hosts exhibiting Metal backend init failures, document/use `KINDX_CPU_ONLY=1` fallback.
- Condition B: Validate CLI `mcp --http` bind behavior in a non-restricted host environment (outside this sandbox).

