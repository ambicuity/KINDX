# KINDX -- Known Issues and Backlog

This document tracks known issues and planned improvements inherited from the project's initial codebase analysis. These are intended to be filed as GitHub Issues once the repository is live.

---

## Bug Fixes

### 1. Reranker context size too small for longer document chunks

**Labels:** `bug`, `good first issue`

The reranker's context window (2048 tokens) truncates longer document chunks during re-ranking, leading to incomplete assessments. Documents with longer sections may receive inaccurate relevance scores because the reranker only sees a portion of the content.

**Suggested fix:** Make the reranker context size configurable via environment variable (`KINDX_RERANK_CONTEXT_SIZE`) and increase the default to 4096 tokens.

**Affected file:** `engine/inference.ts`

---

### 2. BM25 search fails on snake_case identifiers

**Labels:** `bug`

The FTS5 term sanitizer (`sanitizeFTS5Term`) strips underscores from search queries, causing `snake_case` identifiers like `my_function_name` to be tokenized as separate words. This breaks exact-match searches for code identifiers.

**Suggested fix:** Preserve underscores within terms during FTS5 sanitization, or use FTS5 tokenizer configuration that treats underscores as word characters.

**Affected file:** `engine/repository.ts`

---

### 3. `kindx embed` crashes when first chunk exceeds context size

**Labels:** `bug`

When the first chunk of a document exceeds the EmbeddingGemma context window, the embed command crashes instead of gracefully skipping the oversized chunk.

**Suggested fix:** Add a try-catch around the embedding call and skip chunks that exceed the model's context size, logging a warning.

**Affected file:** `engine/repository.ts`, `engine/inference.ts`

---

### 4. Reranker crashes on CJK content (context size overflow)

**Labels:** `bug`

CJK (Chinese, Japanese, Korean) text has a higher token-to-character ratio, causing the reranker's 2048-token context to overflow more frequently. This manifests as crashes during `kindx query` on CJK content.

**Suggested fix:** Implement proper token-count estimation before reranking, and truncate the input to fit the context window instead of crashing.

**Affected file:** `engine/inference.ts`

---

## Enhancements

### 5. Re-index on search (stale data detection)

**Labels:** `enhancement`

When a user runs a search and some documents have been modified since the last index, automatically detect and re-index the stale documents before returning results.

**Suggested fix:** Compare file modification timestamps with stored mtimes during search, and trigger a targeted re-index for changed files.

**Affected files:** `engine/repository.ts`, `engine/kindx.ts`

---

### 6. Update specific collection

**Labels:** `enhancement`

The `kindx update` command currently re-indexes all collections. Add support for updating a specific collection by name.

```bash
kindx update --collection notes
```

**Affected file:** `engine/kindx.ts`

---

### 7. Unified env var configuration for model paths and tuning

**Labels:** `enhancement`, `architecture`

Consolidate all model configuration into a unified environment variable scheme or configuration file, covering:
- Model paths (embed, rerank, generate)
- Embedding format and dimensionality
- Context sizes
- Batch sizes

**Affected files:** `engine/inference.ts`, `engine/kindx.ts`

---

### 8. Force CPU execution on older GPU architectures

**Labels:** `enhancement`

Users with older NVIDIA GPUs (e.g., Pascal architecture) cannot use KINDX because `node-llama-cpp` defaults to GPU execution which fails on unsupported architectures.

**Suggested fix:** Add a `--cpu` flag or `KINDX_CPU_ONLY=1` environment variable to force CPU-only execution.

**Affected file:** `engine/inference.ts`

---

### 9. Provide pre-built binaries for low-memory environments

**Labels:** `enhancement`, `distribution`

Installation via npm requires compiling native modules, which fails on servers with less than 2GB RAM (OOM killer). Provide pre-built Linux binaries (x86_64 and ARM64) as GitHub Release assets.

**Affected files:** `tooling/release.sh`, `.github/workflows/release-please.yml`

---

### 10. Address deprecated `prebuild-install` dependency

**Labels:** `chore`, `dependencies`

The `prebuild-install@7.1.3` dependency is no longer maintained. Evaluate alternatives or ensure the build pipeline does not rely on it for production installations.

**Affected file:** `package.json`

---

### 11. Collection mask update command

**Labels:** `enhancement`

Add the ability to update the glob mask for an existing collection without removing and re-adding it.

```bash
kindx collection update-mask notes "**/*.md,**/*.txt"
```

**Affected files:** `engine/catalogs.ts`, `engine/kindx.ts`

---

## Filing Issues

Once the KINDX repository is live on GitHub, each item above should be filed as a separate issue using the appropriate template:

- **Bugs 1-4:** Use the `Bug Report` template
- **Enhancements 5-11:** Use the `Feature Request` template

Apply the labels listed under each item.

---

### 12. `kindx watch` — Real-Time Incremental Indexing

**Labels:** `enhancement`, `strategic`

**Context:** No competitor in the local-first RAG space offers live incremental indexing for desktop corpora. This is a first-mover differentiator that moves KINDX from a "batch indexer" to a live knowledge substrate for agents.

**Problem:** Currently, users must manually run `kindx update` after editing files. In agentic pipelines where documents change frequently (meeting notes, code, logs), stale retrieval is a silent correctness failure.

**Proposed solution:** Implement a `kindx watch` daemon mode using Node.js `fs.watch` / `chokidar`:

1. Subscribe to filesystem events on all registered collection paths
2. Debounce changes (e.g., 500 ms) and trigger targeted re-index (not full re-index) per changed file
3. Update FTS5 and vector indexes atomically per changed file using an existing SQLite WAL transaction
4. Expose `kindx_index_freshness` field in `kindx_status` MCP tool to report last-updated timestamp per collection

**Affected files:** `engine/repository.ts`, `engine/kindx.ts`, `engine/protocol.ts`

**Implementation notes:**
- `chokidar` (MIT, stable) is the recommended watcher — handles macOS FSEvents, Linux inotify, and Windows ReadDirectoryChangesW uniformly
- Debounce rapid saves (e.g., editor auto-save storms) before triggering re-index to avoid redundant embed calls
- Re-embedding should be skipped if the file hash hasn't changed (content-addressed storage already handles this)

