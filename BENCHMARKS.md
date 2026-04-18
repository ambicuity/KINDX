# KINDX Benchmark Specification

> Benchmark strategy for KINDX v1.3.x — derived from `.ts` implementation, not README marketing.

---

## Table of Contents

1. [Principles](#1-principles)
2. [Architecture Context](#2-architecture-context)
3. [Benchmark Profiles](#3-benchmark-profiles)
4. [Benchmark Tracks](#4-benchmark-tracks)
5. [Metrics](#5-metrics)
6. [Standard Result Tables](#6-standard-result-tables)
7. [Visualization Guidance](#7-visualization-guidance)
8. [Dataset Strategy](#8-dataset-strategy)
9. [Fair Comparison Guidance](#9-fair-comparison-guidance)
10. [Reproducibility](#10-reproducibility)
11. [Minimal Reproduction Example](#11-minimal-reproduction-example)
12. [Failure Modes](#12-failure-modes)
13. [Repository Structure](#13-repository-structure)
14. [Implementation Roadmap](#14-implementation-roadmap)
15. [Production Benchmark Execution Report (2026-04-18)](#15-production-benchmark-execution-report-2026-04-18)

---

## 1. Principles

| Principle | Rationale |
|---|---|
| **Same hardware across runs** | KINDX runs entirely on-device. GGUF inference speed varies dramatically across CPU/GPU/Metal. Results from different machines are not comparable. |
| **Fixed datasets with known relevance** | KINDX ships a 6-document eval corpus with 24 graded queries (easy/medium/hard/fusion). Benchmarks must use fixed corpora with gold relevance judgments. |
| **Fixed model configuration** | Embedding (`embeddinggemma-300M-Q8_0`), reranker (`qwen3-reranker-0.6b-Q8_0`), and expansion (`LFM2.5-1.2B-Instruct-Q4_K_M`) must be pinned. Changing models changes results. |
| **Matched-quality comparisons** | Never compare hybrid pipeline latency against a BM25 system without reporting the quality delta. Faster is meaningless if recall drops. |
| **Precision-aware reporting** | Report median, p95, p99 — never mean. KINDX has bimodal latency (cold model load vs warm inference). Mean masks this. |
| **Warm vs cold separation** | First query after process start incurs 3–8s model loading. Subsequent queries reuse resident VRAM contexts. Measure separately, report separately. |
| **Degraded-mode transparency** | When reranking times out or LLM pool exhausts, KINDX falls back to RRF-only scoring. Report `degraded_mode_rate` alongside latency. |
| **Isolated databases** | Each benchmark run must use a fresh SQLite database. Shared WAL/B-tree state from a prior run contaminates measurements. |

---

## 2. Architecture Context

### Pipeline Stages

```
Query
 ├─ [BM25 Probe] ──── strong signal? ──── skip expansion
 │                         │ no
 │                    [Query Expansion LLM]  ── LFM2.5-1.2B
 │
 ├─ [FTS5 × N lex queries]     (sync, sub-ms per query)
 ├─ [sqlite-vec × N vec queries]  (embed via embeddinggemma-300M, then cosine scan)
 │
 ├─ [RRF Fusion k=60]  ── first 2 lists get 2× weight
 │     └── [Top-rank bonus]
 │
 ├─ [Chunk Selection]  ── best keyword-overlap chunk per doc
 │
 ├─ [LLM Reranker]  ── qwen3-reranker-0.6B on chunks (NOT full bodies)
 │     └── [Concurrency gate: rerank queue + LLM pool]
 │
 ├─ [Position-Aware Blending]
 │     ├── RRF rank ≤ 3:  55% RRF / 45% rerank
 │     ├── RRF rank ≤ 10: 45% RRF / 55% rerank
 │     └── RRF rank > 10: 30% RRF / 70% rerank
 │
 └─ [Dedup + minScore filter + limit]
```

Source: `engine/repository.ts` — `hybridQuery()` (CLI) and `structuredSearchWithDiagnostics()` (MCP/HTTP).

### Independently Benchmarkable Components

| Component | Function | Isolation Method |
|---|---|---|
| FTS5 (BM25) | `searchFTS()` | `kindx search` CLI — no model load |
| sqlite-vec (cosine) | `searchVec()` | `kindx vsearch` CLI — loads embed model only |
| Embedding | `llm.embed()` / `llm.embedBatch()` | `kindx embed` CLI — measures embedding throughput |
| Query Expansion | `llm.expandQuery()` | Internal to `hybridQuery()`; timed via `expand_ms` |
| Reranking | `llm.rerank()` | Internal to `hybridQuery()`; timed via `rerank_ms`. Microbenchmarked in `engine/benchmarks.ts` |
| RRF Fusion | `reciprocalRankFusion()` | Pure function, O(N) — negligible. Unit testable. |
| Full Pipeline | `structuredSearchWithDiagnostics()` | `kindx query` CLI or HTTP `POST /query` |
| LLM Pool | `LLMPool.acquire()` | `tooling/benchmark_llm_pool_contention.ts` |
| Rerank Queue | `acquireRerankSlot()` | Observable via `getRerankThroughputSnapshot()` |

### Observable Timings

Via `--explain` flag (CLI) or MCP response `metadata.timings`:

| Timing Key | Stage |
|---|---|
| `expand_ms` | Query expansion (LFM2.5-1.2B inference) |
| `embed_ms` | Query embedding (embeddinggemma-300M) |
| `retrieval_ms` | FTS5 + sqlite-vec fan-out |
| `rerank_init_ms` | Reranker context creation (first-use overhead) |
| `rerank_ms` | Cross-encoder scoring |
| `total_ms` | End-to-end wall clock |

---

## 3. Benchmark Profiles

All benchmarks must use one of these canonical profiles. Do not invent ad-hoc configurations.

| Profile | Command / Config | Models Loaded | Rerank | Notes |
|---|---|---|---|---|
| `BM25` | `kindx search "..." --json -n 10` | None | No | Lexical baseline. Sub-ms latency on small corpora. |
| `Vector` | `kindx vsearch "..." --json -n 10` | Embed only | No | Semantic-only. Requires prior `kindx embed`. |
| `Hybrid` | `kindx query "..." --json -n 10` | All 3 | Yes | Default pipeline. `balanced` routing profile. |
| `Hybrid-fast` | `kindx query "..." --json -n 10 --routing-profile fast` | All 3 | Yes (limit=10) | `candidateLimit=20`, `rerankLimit=10`, 5s hard timeout. |
| `Hybrid-max` | `kindx query "..." --json -n 10 --routing-profile max_precision` | All 3 | Yes (limit=50) | `candidateLimit=60`, `rerankLimit=50`, ≥15s timeout. |
| `HTTP-daemon` | `POST http://127.0.0.1:8181/query` | Resident | Yes | Warm models. `kindx mcp --http --daemon` must be running. |

**Profile selection logic** (from `protocol.ts`):

| Routing Profile | `candidateLimit` | `rerankLimit` | Timeout Cap |
|---|---|---|---|
| `fast` | 20 | 10 | `min(env, 5000)` ms |
| `balanced` | 40 (default) | 40 | env-configured |
| `max_precision` | 60 | 50 | `max(env, 15000)` ms |

Source: `resolveProfilePolicy()` and `resolveTimeoutByProfile()` in `engine/protocol.ts`.

### Serving Modes

| Mode | Invocation | Model Lifecycle |
|---|---|---|
| CLI subprocess | `kindx search\|vsearch\|query "..."` | Cold-load per invocation. Models disposed on exit. |
| MCP stdio | `kindx mcp` (spawned by IDE) | Cold-load once per client session. Disposed on disconnect. |
| HTTP foreground | `kindx mcp --http` | Models resident. Contexts idle-timeout at 5 min (`DEFAULT_INACTIVITY_TIMEOUT_MS`). |
| HTTP daemon | `kindx mcp --http --daemon` | Same as foreground. PID-managed background process. |
| CPU-only | `KINDX_CPU_ONLY=1 kindx query "..."` | Forces CPU execution. No GPU/Metal. |
| Remote backend | `KINDX_LLM_BACKEND=remote kindx query "..."` | No local model. Calls OpenAI-compatible API. |

---

## 4. Benchmark Tracks

### 4.1 Lexical Retrieval (BM25)

**Profile:** `BM25`  
**Existing tests:** `specs/evaluation-bm25.test.ts` — 24 queries, 4 difficulty tiers.

**Quality thresholds** (from source):

| Difficulty | Metric | Gate |
|---|---|---|
| Easy (6 queries) | Hit@3 | ≥ 80% |
| Medium (6 queries) | Hit@3 | ≥ 15% |
| Hard (6 queries) | Hit@5 | ≥ 15% |
| Overall (24 queries) | Hit@3 | ≥ 40% |

**Latency:** BM25 has no model-load cost. Expected sub-5ms for 6-doc corpus. Scale linearly with corpus size.

### 4.2 Vector Retrieval

**Profile:** `Vector`  
**Existing tests:** `specs/evaluation.test.ts` — vector suite (skipped in CI: `describe.skipIf(!!process.env.CI)`).

**Quality thresholds:**

| Difficulty | Metric | Gate |
|---|---|---|
| Easy | Hit@3 | ≥ 60% |
| Medium | Hit@3 | ≥ 40% |
| Hard | Hit@5 | ≥ 30% |
| Overall | Hit@3 | ≥ 50% |

**Latency:** First invocation loads embed model (1–3s). Warm: 50–200ms for small corpora.

**ANN parameters** (from `engine/sharding.ts`):

| Parameter | Default | Env Var | Effect |
|---|---|---|---|
| Probe count | 4 | `KINDX_ANN_PROBE_COUNT` | Centroids probed per query. Higher = better recall, slower. |
| Shortlist | `k × 20` | `KINDX_ANN_SHORTLIST` | Candidates from each probed centroid. |
| Centroid count | 64 | `KINDX_ANN_CENTROIDS` | Capped at vector count. 2-pass k-means, not HNSW. |

### 4.3 Hybrid Retrieval + Reranking

**Profile:** `Hybrid`, `Hybrid-fast`, `Hybrid-max`  
**Existing tests:** `specs/evaluation.test.ts` — hybrid RRF suite.

**Quality thresholds:**

| Difficulty | Metric | With Vectors | Without Vectors |
|---|---|---|---|
| Easy | Hit@3 | ≥ 80% | ≥ 80% |
| Medium | Hit@3 | ≥ 50% | ≥ 15% |
| Hard | Hit@5 | ≥ 35% | ≥ 15% |
| Fusion | Hit@3 | ≥ 50% | N/A |
| Overall (standard) | Hit@3 | ≥ 60% | ≥ 40% |

**Fusion invariant:** Hybrid Hit@3 ≥ max(BM25 Hit@3, Vector Hit@3) for fusion-category queries.

**Pipeline constants** (from `engine/repository.ts`):

| Constant | Value | Source |
|---|---|---|
| `STRONG_SIGNAL_MIN_SCORE` | 0.85 | Skips expansion if BM25 top hit ≥ 0.85 |
| `STRONG_SIGNAL_MIN_GAP` | (top − second) gap | Must be present for skip |
| `RERANK_CANDIDATE_LIMIT` | 40 | RRF output truncation before rerank |
| RRF k | 60 | Standard RRF parameter |
| RRF weight (first 2 lists) | 2.0× | Boosts original query signals |
| RRF weight (remaining lists) | 1.0× | Expansion signals |
| Position decay τ | 8.0 | `exp(-(rank-1)/8.0)` |

### 4.4 Indexing / Embedding / Update

**Profile:** N/A — CLI commands.  
**Existing benchmark:** `tooling/benchmark_release_regressions.ts`

| Metric | Command | Measures |
|---|---|---|
| BM25 index rebuild | `time kindx update` | FTS5 insert + WAL commit |
| Full embedding | `time kindx embed` | All docs → chunk → embed → insert |
| Incremental embedding | `time kindx embed` (after 1 doc edit) | Delta detection + re-embed |
| Forced re-embed | `time kindx embed -f` | Full corpus re-embedding |
| Shard sync | `time kindx embed --resume` | Sharded collection rebuild |

**Insert path baselines** (from release audit, median of 10 runs, 2K inserts):

| Path | Median | Speedup vs uncached |
|---|---|---|
| `prepare-per-call` (uncached) | ~1570 ms | — |
| Cached statements | ~1400 ms | +10.8% |
| Transactional bulk (`bulkInsertEmbeddings`) | ~8 ms | +99.5% |

**Fan-out baselines** (3 queries × 4 collections, 8ms synthetic task latency):

| Path | Median | Speedup |
|---|---|---|
| Sequential | ~109 ms | — |
| Parallel | ~9 ms | +91.7% |

### 4.5 Serving Mode Comparison

**Profiles:** `Hybrid` (CLI cold), `HTTP-daemon` (warm)  
**Existing benchmark:** `tooling/benchmark_warm_daemon.ts`

**Protocol:**

```bash
# CLI cold-start
for i in {1..20}; do time kindx query "auth flow" --json -n 5; done

# HTTP warm daemon
kindx mcp --http --daemon
npx tsx tooling/benchmark_warm_daemon.ts \
  --base-url http://127.0.0.1:8181/query \
  --sessions 10 \
  --requests-per-session 6 \
  --routing-profile fast \
  --thresholds tooling/perf-thresholds.json
```

**Thresholds** (from `tooling/perf-thresholds.json`):

| Sessions | p95 Latency | Max Rerank Timeout Rate | Max Queue Saturation Rate | Max Degraded Mode Rate |
|---|---|---|---|---|
| 10 | 3000 ms | 50% | 50% | 75% |
| 25 | 5000 ms | 50% | 50% | 75% |
| 50 | 8000 ms | 50% | 50% | 75% |

Status: `"informational": true` — not yet CI-enforcing.

### 4.6 Cold-Start vs Warm-Start

| Term | Definition |
|---|---|
| **Cold** | No models loaded. Includes HuggingFace cache resolution, GGUF model load, GPU/Metal context allocation. 3–8s overhead. |
| **Warm** | Models resident in VRAM. Embed/rerank contexts exist (or transparently recreated from loaded model in ~1s after 5-min idle). |
| **Hot cache** | Warm + LLM response cache hits (expansion/rerank results cached by content hash in `llm_cache` table). |

**Protocol:**

```bash
# Cold (single fresh process)
npx tsx tooling/benchmark_release_hardening.ts --runs 1 --query "auth"
# → query_samples_ms[0] is the cold measurement

# Warm (subsequent invocations in same process, or HTTP daemon)
npx tsx tooling/benchmark_release_hardening.ts --runs 10 --query "auth"
# → query_median_ms and query_p95_ms are warm measurements
```

### 4.7 Concurrency / Throughput

**LLM Pool** (from `engine/llm-pool.ts`):
- Default size: 1 (`KINDX_LLM_POOL_SIZE`)
- Each context: ~300–600 MB VRAM
- FIFO queue, 30s default timeout
- `LLMPoolExhaustedError` on immediate exhaustion; `LLMPoolTimeoutError` on wait expiry

**Rerank Queue** (from `engine/repository.ts`):
- Concurrency-limited slot acquisition via `acquireRerankSlot()`
- Configurable queue limit, drop policy (`timeout_fallback` or `wait`)
- On saturation: falls back to synthetic exponential-decay scores

**Existing benchmarks:**

| Script | What It Tests |
|---|---|
| `tooling/benchmark_llm_pool_contention.ts` | Pool saturation at size 1 vs 4, 20 concurrent clients |
| `tooling/benchmark_concurrent_agents.ts` | 5 agents × 3 cycles × 6 commands |
| `tooling/benchmark_warm_daemon.ts` | HTTP at 10/25/50 concurrent sessions |

**Env vars that control concurrency:**

| Variable | Default | Effect |
|---|---|---|
| `KINDX_LLM_POOL_SIZE` | 1 | Concurrent LLM contexts |
| `KINDX_RERANK_CONCURRENCY` | 1 | Parallel rerank workers |
| `KINDX_RERANK_TIMEOUT_MS` | — | Per-request rerank budget |
| `KINDX_RERANK_QUEUE_LIMIT` | — | Queue cap before saturation fallback |
| `KINDX_RERANK_DROP_POLICY` | `timeout_fallback` | `timeout_fallback` \| `wait` |
| `KINDX_VECTOR_FANOUT_WORKERS` | 4 | Parallel vector fan-out |

### 4.8 Resource Efficiency

**Existing benchmark:** `engine/benchmarks.ts` reports per-context VRAM, total VRAM, peak RSS.

**Model footprints** (Q8_0 / Q4_K_M quantization):

| Model | Role | File Size | VRAM (GPU) | RAM (CPU-only) |
|---|---|---|---|---|
| embeddinggemma-300M-Q8_0 | Embedding (768 dims) | ~300 MB | ~350 MB | ~400 MB |
| qwen3-reranker-0.6b-Q8_0 | Reranking (ctx 4096) | ~650 MB | ~700 MB | ~800 MB |
| LFM2.5-1.2B-Instruct-Q4_K_M | Query expansion (ctx 2048) | ~700 MB | ~800 MB | ~1 GB |

**VRAM reserve:** 512 MB default (`KINDX_VRAM_RESERVE_MB`), prevents allocation races with other GPU consumers.

**Inactivity timeout:** 5 min (`DEFAULT_INACTIVITY_TIMEOUT_MS`). Contexts disposed, models optionally kept loaded (`disposeModelsOnInactivity`).

### 4.9 Multi-Tenant / RBAC (Optional)

RBAC overhead should be negligible (SHA-256 token lookup + set intersection). This track exists to confirm that claim.

```bash
kindx tenant add bench-viewer --role viewer docs
kindx tenant add bench-admin --role admin

# Compare latency with and without Authorization header
curl -H "Authorization: Bearer <token>" -X POST http://localhost:8181/query -d '...'
```

---

## 5. Metrics

### Quality

| Metric | Definition | Formula |
|---|---|---|
| Hit@k | 1 if expected document in top-k, else 0. Averaged over query set. | `Σ hit_i / N` |
| MRR | Mean Reciprocal Rank. 1/rank of first correct result. | `Σ (1/rank_i) / N` |
| Recall@k | Fraction of relevant docs retrieved in top-k. | `|relevant ∩ top-k| / |relevant|` |
| NDCG@k | Normalized Discounted Cumulative Gain. Requires graded relevance. | Standard NDCG formula |
| Precision@k | Fraction of top-k results that are relevant. | `|relevant ∩ top-k| / k` |

Currently implemented: Hit@k (in `specs/evaluation*.test.ts`), MRR (in `tooling/benchmark_retrieval_integrity.py`).

### Latency

| Metric | Definition |
|---|---|
| p50, p95, p99 | Percentile latency across measurement runs |
| TTFR | Time-to-first-result (CLI: process spawn → stdout) |
| Cold-start latency | First query after process start (includes model load) |
| Warm-query latency | Subsequent queries with resident models |
| Per-stage latency | `expand_ms`, `embed_ms`, `retrieval_ms`, `rerank_init_ms`, `rerank_ms` |

### Throughput

| Metric | Definition |
|---|---|
| QPS | Queries per second (sustained, under concurrency) |
| Docs/sec (rerank) | Documents scored per second by reranker |
| Chunks/sec (embed) | Chunks embedded per second during `kindx embed` |
| Inserts/sec | Vector insert throughput into sqlite-vec |

### Resource

| Metric | Definition |
|---|---|
| Peak RSS | Maximum resident set size during benchmark |
| VRAM usage | GPU memory consumed (models + contexts) |
| Index size | `index.sqlite` file size on disk |
| Model cache size | Total GGUF files in `~/.cache/kindx/models/` |

### Degraded Mode

| Metric | Definition |
|---|---|
| Degraded rate | Fraction of queries that triggered any `markDegraded()` reason |
| Rerank timeout rate | Fraction where reranker exceeded time budget |
| Queue saturation rate | Fraction where rerank queue was full |
| Fallback reason distribution | Counts per reason code (see [§12 Failure Modes](#12-failure-modes)) |

### Prometheus Metrics (HTTP daemon `/metrics`)

```
kindx_http_requests_total{route,method,status}
kindx_http_request_duration_ms_bucket{route,method,le}
kindx_query_requests_total{profile,degraded,route}
kindx_query_degraded_total{reason}
kindx_query_route_total{route}
kindx_query_total_ms_bucket{profile,degraded,route,le}
```

Source: `engine/utils/metrics.ts` — in-process counters/histograms, no external dependency.

---

## 6. Standard Result Tables

These tables are auto-generated from measured benchmark runs using `tooling/benchmarks/section6_bench.ts`.

## Retrieval Quality — MS MARCO 1000 (1000 docs, 24 queries)

| Profile | Difficulty | Hit@3 | Hit@5 | MRR | NDCG@5 | Degraded % |
|---|---|---|---|---|---|---|
| BM25 | easy | 0.333 | 0.333 | 0.333 | 0.333 | 0.0% |
| BM25 | medium | 0.167 | 0.167 | 0.167 | 0.167 | 0.0% |
| BM25 | hard | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% |
| Vector | easy | 1.000 | 1.000 | 1.000 | 1.000 | 0.0% |
| Vector | medium | 1.000 | 1.000 | 0.917 | 0.938 | 0.0% |
| Vector | hard | 1.000 | 1.000 | 0.917 | 0.938 | 0.0% |
| Hybrid | easy | 0.833 | 1.000 | 0.792 | 0.844 | 0.0% |
| Hybrid | medium | 0.833 | 1.000 | 0.681 | 0.760 | 0.0% |
| Hybrid | hard | 1.000 | 1.000 | 0.917 | 0.938 | 0.0% |
| Hybrid | fusion | 1.000 | 1.000 | 1.000 | 0.892 | 0.0% |
| Hybrid-fast | overall | 0.875 | 0.875 | 0.833 | 0.830 | 100.0% |
| Hybrid-max | overall | 0.875 | 0.875 | 0.833 | 0.830 | 12.5% |

## Serving Performance — MS MARCO 1000 (8 CLI + 30 profile HTTP runs, 10 sessions)

| Profile | Cold p50 | Warm p50 | Warm p95 | Warm p99 | QPS | Degraded % | Rerank Timeout % |
|---|---|---|---|---|---|---|---|
| BM25 | 349ms | 265ms | 282ms | 282ms | 3.59 | 0.0% | N/A |
| Vector | 829ms | 813ms | 823ms | 823ms | 1.23 | 0.0% | N/A |
| Hybrid | 824ms | 813ms | 825ms | 825ms | 1.23 | 0.0% | 0.0% |
| Hybrid-fast | 23ms | 22ms | 30ms | 32ms | 42.77 | 100.0% | 0.0% |
| Hybrid-max | 25ms | 24ms | 30ms | 31ms | 41.37 | 0.0% | 0.0% |
| HTTP-daemon | N/A | 68ms | 95ms | 95ms | 138.87 | 10.0% | 0.0% |

## Indexing — 1000 documents, 1000 chunks

| Operation | Time | Throughput | Notes |
|---|---|---|---|
| FTS5 index (`kindx update`) | 712ms | 1404.74 docs/sec | refresh mode |
| Full embed (`kindx embed`) | 24519ms | 40.78 chunks/sec | Model: embeddinggemma-300M-Q8_0 |
| Incremental embed (1 doc) | 812ms | 1.23 docs/sec | after single-doc edit |
| Forced re-embed (`kindx embed -f`) | 24539ms | 40.75 chunks/sec | full re-embed |
| Bulk insert (transactional) | 8ms | 250000.00 inserts/sec | from benchmark_release_regressions |

## Resource Usage

| State | RSS | VRAM (GPU) | Disk (index) | Disk (models) |
|---|---|---|---|---|
| Idle (no models) | 707 MB | 0 MB | 6.1 MB | 1620 MB |
| Embed model loaded | 707 MB | N/A (Apple Metal) | 6.1 MB | 1620 MB |
| All 3 models loaded | 707 MB | N/A (Apple Metal) | 6.1 MB | 1620 MB |
| During embed (batch) | N/A | N/A (Apple Metal) | 6.1 MB | 1620 MB |
| CPU-only mode | N/A | N/A | 6.1 MB | 1620 MB |

### Provenance

- Source corpus: `tooling/benchmarks/test_corpus_msmarco`
- Judgments: `tooling/benchmarks/judgments/msmarco.v1.json`
- Benchmark command: `npx tsx tooling/benchmarks/section6_bench.ts --update-doc`
- Temporary isolated workspace: `/var/folders/tc/9srvxb_11h5bpdgnjy16lbqr0000gn/T/kindx-section6-654EWK`

---

## Retrieval Quality — DBpedia 1000 (1000 docs, 24 queries)

| Profile | Difficulty | Hit@3 | Hit@5 | MRR | NDCG@5 | Degraded % |
|---|---|---|---|---|---|---|
| BM25 | easy | 0.500 | 0.500 | 0.500 | 0.500 | 0.0% |
| BM25 | medium | 0.333 | 0.333 | 0.333 | 0.333 | 0.0% |
| BM25 | hard | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% |
| Vector | easy | 1.000 | 1.000 | 0.917 | 0.938 | 0.0% |
| Vector | medium | 1.000 | 1.000 | 1.000 | 1.000 | 0.0% |
| Vector | hard | 1.000 | 1.000 | 0.917 | 0.938 | 0.0% |
| Hybrid | easy | 0.833 | 1.000 | 0.792 | 0.844 | 0.0% |
| Hybrid | medium | 1.000 | 1.000 | 0.917 | 0.938 | 0.0% |
| Hybrid | hard | 1.000 | 1.000 | 0.750 | 0.815 | 0.0% |
| Hybrid | fusion | 1.000 | 1.000 | 0.917 | 0.844 | 0.0% |
| Hybrid-fast | overall | 1.000 | 1.000 | 0.896 | 0.897 | 100.0% |
| Hybrid-max | overall | 1.000 | 1.000 | 0.896 | 0.897 | 0.0% |

## Serving Performance — DBpedia 1000 (8 CLI + 30 profile HTTP runs, 10 sessions)

| Profile | Cold p50 | Warm p50 | Warm p95 | Warm p99 | QPS | Degraded % | Rerank Timeout % |
|---|---|---|---|---|---|---|---|
| BM25 | 247ms | 238ms | 245ms | 245ms | 4.17 | 0.0% | N/A |
| Vector | 830ms | 821ms | 1407ms | 1407ms | 1.11 | 0.0% | N/A |
| Hybrid | 832ms | 813ms | 831ms | 831ms | 1.22 | 0.0% | 0.0% |
| Hybrid-fast | 36ms | 21ms | 28ms | 30ms | 43.49 | 100.0% | 0.0% |
| Hybrid-max | 21ms | 22ms | 34ms | 37ms | 41.99 | 0.0% | 0.0% |
| HTTP-daemon | N/A | 76ms | 89ms | 96ms | 125.02 | 0.0% | 0.0% |

## Indexing — 1000 documents, 1000 chunks

| Operation | Time | Throughput | Notes |
|---|---|---|---|
| FTS5 index (`kindx update`) | 557ms | 1795.67 docs/sec | refresh mode |
| Full embed (`kindx embed`) | 17472ms | 57.24 chunks/sec | Model: embeddinggemma-300M-Q8_0 |
| Incremental embed (1 doc) | 817ms | 1.22 docs/sec | after single-doc edit |
| Forced re-embed (`kindx embed -f`) | 17474ms | 57.23 chunks/sec | full re-embed |
| Bulk insert (transactional) | 10ms | 200000.00 inserts/sec | from benchmark_release_regressions |

## Resource Usage

| State | RSS | VRAM (GPU) | Disk (index) | Disk (models) |
|---|---|---|---|---|
| Idle (no models) | 619 MB | 0 MB | 5.5 MB | 1620 MB |
| Embed model loaded | 619 MB | N/A (Apple Metal) | 5.5 MB | 1620 MB |
| All 3 models loaded | 619 MB | N/A (Apple Metal) | 5.5 MB | 1620 MB |
| During embed (batch) | N/A | N/A (Apple Metal) | 5.5 MB | 1620 MB |
| CPU-only mode | N/A | N/A | 5.5 MB | 1620 MB |

### Provenance

- Source corpus: `tooling/benchmarks/test_corpus_dbpedia`
- Judgments: `tooling/benchmarks/judgments/dbpedia.v1.json`
- Benchmark command: `npx tsx tooling/benchmarks/section6_bench.ts --update-doc`
- Temporary isolated workspace: `/var/folders/tc/9srvxb_11h5bpdgnjy16lbqr0000gn/T/kindx-section6-dGSCdS`


---

## 7. Visualization Guidance

When publishing benchmark reports, include these plots. All can be generated from the JSON output of existing tooling scripts.

### 7.1 Latency vs Concurrency (Required)

**Source:** `tooling/benchmark_warm_daemon.ts` — run with `--sessions 1,5,10,25,50`

```
X-axis: Concurrent sessions (1, 5, 10, 25, 50)
Y-axis: Query latency (ms)
Series: p50, p95, p99
Secondary Y-axis: Degraded mode rate (%)
Profile: HTTP-daemon
```

Reveals saturation knee. Expect p95 to diverge from p50 as LLM pool + rerank queue fill.

### 7.2 Recall vs Latency (Required)

**Source:** Run all 3 routing profiles on the same query set, plot quality vs speed.

```
X-axis: Warm p50 latency (ms)
Y-axis: Hit@3
Points: Hybrid-fast, Hybrid (balanced), Hybrid-max
Annotations: candidateLimit, rerankLimit for each point
```

Demonstrates the quality/latency tradeoff that routing profiles provide.

### 7.3 ANN Probe Count vs Recall (Required for sharded collections)

**Source:** Vary `KINDX_ANN_PROBE_COUNT` from 1 to 16. Measure Hit@k against exact-scan baseline.

```
X-axis: Probe count (1, 2, 4, 8, 16)
Y-axis: Hit@5 (relative to exact scan = 1.0)
Secondary Y-axis: Vector search latency (ms)
```

Quantifies recall loss from centroid-based routing.

### 7.4 Cold-Start Distribution (Recommended)

**Source:** `tooling/benchmark_release_hardening.ts` — 20 cold-start measurements.

```
Histogram: Total query latency per cold invocation
Bins: 500ms
Annotation: Model load time contribution
```

### 7.5 Stage Breakdown (Recommended)

**Source:** Per-stage timings from `metadata.timings`

```
Stacked bar chart per profile:
  expand_ms | embed_ms | retrieval_ms | rerank_init_ms | rerank_ms
Profiles: Hybrid-fast, Hybrid, Hybrid-max
```

Shows where time is spent. Identifies optimization targets.

---

## 8. Dataset Strategy

### Tier 1: Built-In Eval Corpus (Available Now)

Location: `specs/eval-docs/` — 6 markdown documents, ~16 KB total.

| Document | Topic |
|---|---|
| `api-design-principles.md` | REST API design |
| `distributed-systems-overview.md` | Distributed systems |
| `machine-learning-primer.md` | ML fundamentals |
| `product-launch-retrospective.md` | Product launch |
| `remote-work-policy.md` | Remote work |
| `startup-fundraising-memo.md` | Fundraising |

24 queries at 4 difficulty levels (easy/medium/hard/fusion), defined in `specs/evaluation.test.ts` and `tooling/benchmark_local_rag.py`.

**Limitation:** Too small for latency/scale benchmarks. Sufficient for quality gate validation.

### Tier 2: Scaled Synthetic Corpora (Build for Benchmarks)

| Size | Documents | Est. Chunks | Use Case |
|---|---|---|---|
| Small | 100 | ~300 | Regression gate (fast, CI-friendly) |
| Medium | 1,000 | ~3,000 | Quality + latency |
| Large | 10,000 | ~30,000 | Throughput + scaling |
| XL | 100,000 | ~300,000 | Stress testing (ANN, sharding) |

Requirements:
- Realistic markdown structure (headings, code blocks, lists)
- Controllable topic distribution
- ≥ 50 queries with gold relevance per size tier
- Deterministic seed for reproducibility
- Eval queries must not appear in the corpus

### Tier 3: Standard IR Benchmarks (Future)

- **MS MARCO Passage** — passage retrieval
- **BEIR** — heterogeneous benchmark suite
- **NQ** — question-answering with Wikipedia

Adaptation: convert passages to one markdown file per passage; run full KINDX pipeline; report Hit@k and MRR.

---

## 9. Fair Comparison Guidance

### KINDX is NOT a Pure ANN System

KINDX does not compete on isolated ANN recall/latency. Its value proposition is the full pipeline:

```
BM25 → Vector → RRF Fusion → LLM Reranking → Position-Aware Blending
```

Isolating `sqlite-vec` for comparison with HNSW implementations is valid for **component** benchmarking but misleading for **system** benchmarking. Always run at least one end-to-end track.

### vs BM25-Only Systems (Elasticsearch, Tantivy, etc.)

- Compare `kindx search` (`BM25` profile) for apples-to-apples latency
- Also run `Hybrid` profile and report quality lift
- Disclose: KINDX BM25 uses SQLite FTS5, not a dedicated search engine

### vs Vector Databases (LanceDB, Chroma, Qdrant)

Existing: `tooling/benchmark_local_rag.py` compares KINDX vs LanceDB vs Chroma.

Fair comparison requires:
1. Same embedding model (or TF-IDF vectorizer as baseline)
2. Same query set with gold relevance
3. Report both Hit@k quality and latency
4. Disclose: KINDX adds BM25 + reranking stages that pure vector DBs omit
5. Disclose: KINDX uses 2-pass k-means centroid routing, not HNSW/IVF

### vs Local RAG Tools (Khoj, Obsidian, etc.)

- Disclose model sizes: KINDX uses sub-2B parameter models exclusively
- Same hardware
- Measure privacy: KINDX makes zero network calls in local mode
- Report offline capability

### vs MCP-Native Tools

- Measure tool-call round-trip (JSON-RPC overhead + retrieval)
- Report model-load amortization benefit of HTTP daemon mode
- Include session lifecycle costs (initialize → tool/list → tool/call → close)

---

## 10. Reproducibility

### Hardware Profile (Required in Every Report)

```
CPU:        <model> (<cores> cores)
GPU:        <device> (or "CPU-only via KINDX_CPU_ONLY=1")
VRAM:       <total> total, <free> free at benchmark start
RAM:        <total> system RAM
Disk:       <type> (SSD/NVMe/HDD)
OS:         <name> <version> <arch>
```

### Runtime Versions (Required)

```
Node.js:         <version>  (or Bun: <version>)
TypeScript:      <version>
KINDX:           <version>
node-llama-cpp:  <version>
sqlite-vec:      <version>
better-sqlite3:  <version>
```

### Model Configuration (Required)

```
Embedding:   embeddinggemma-300M-Q8_0.gguf  (768 dimensions)
Reranker:    qwen3-reranker-0.6b-Q8_0.gguf  (context: 4096)
Expansion:   LFM2.5-1.2B-Instruct-Q4_K_M.gguf (context: 2048)
```

Override via: `KINDX_EMBED_MODEL`, `KINDX_RERANK_MODEL`, `KINDX_GENERATE_MODEL`.

### Environment Variables That Affect Results

| Variable | Default | Must Document If Changed |
|---|---|---|
| `KINDX_CPU_ONLY` | `0` | GPU vs CPU execution |
| `KINDX_LLM_POOL_SIZE` | `1` | Concurrent LLM contexts |
| `KINDX_LLM_BACKEND` | `local` | `local` vs `remote` |
| `KINDX_ANN_ENABLE` | `1` | ANN routing on/off |
| `KINDX_ANN_PROBE_COUNT` | `4` | ANN accuracy/speed tradeoff |
| `KINDX_RERANK_TIMEOUT_MS` | — | Rerank budget cutoff |
| `KINDX_RERANK_CONCURRENCY` | `1` | Parallel rerank workers |
| `KINDX_RERANK_QUEUE_LIMIT` | — | Queue cap before saturation |
| `KINDX_RERANK_DROP_POLICY` | `timeout_fallback` | Queue behavior |
| `KINDX_VECTOR_FANOUT_WORKERS` | `4` | Parallel vector search |
| `KINDX_EXPAND_CONTEXT_SIZE` | `2048` | Expansion LLM context window |
| `KINDX_RERANK_CONTEXT_SIZE` | `4096` | Reranker context window |
| `KINDX_VRAM_RESERVE_MB` | `512` | VRAM allocation headroom |
| `KINDX_ENCRYPTION_KEY` | — | Encryption adds overhead |
| `KINDX_INFLIGHT_DEDUPE` | `join` | Deduplicates identical concurrent queries |

### Warmup and Repetition

| Parameter | Requirement |
|---|---|
| Warmup runs (discarded) | ≥ 2 |
| Measurement runs | ≥ 10 |
| Statistical reporting | Median, p95, p99, min, max |
| Cold-start runs | ≥ 3 (separate from warm runs) |
| Database isolation | Fresh SQLite per benchmark run |

---

## 11. Minimal Reproduction Example

Copy-paste this to run a complete quality + latency benchmark:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Prerequisites ──
# Node.js 22+, npm, git
# KINDX installed: npm install -g kindx  (or use npx)

# ── 1. Clone and prepare ──
git clone https://github.com/ambicuity/KINDX.git && cd KINDX
npm install

# ── 2. Index the eval corpus ──
export KINDX_INDEX_NAME="benchmark-eval"
kindx collection add eval-docs ./specs/eval-docs --pattern "**/*.md"
kindx update
kindx embed

# ── 3. Quality gate: BM25 (runs in <5s, no model needed) ──
echo "=== BM25 Quality ==="
npx vitest run specs/evaluation-bm25.test.ts --reporter=verbose

# ── 4. Quality gate: Vector + Hybrid (requires models, ~2 min) ──
echo "=== Vector + Hybrid Quality ==="
npx vitest run specs/evaluation.test.ts --reporter=verbose

# ── 5. Latency: cold + warm (10 runs) ──
echo "=== Latency ==="
npx tsx tooling/benchmark_release_hardening.ts --runs 10 --query "API versioning"

# ── 6. Insert path regression ──
echo "=== Insert Regression ==="
npx tsx tooling/benchmark_release_regressions.ts

# ── 7. (Optional) HTTP daemon concurrency ──
echo "=== Daemon Benchmark ==="
kindx mcp --http --daemon --port 8181
sleep 3  # wait for model load
npx tsx tooling/benchmark_warm_daemon.ts \
  --base-url http://127.0.0.1:8181/query \
  --sessions 10 \
  --requests-per-session 6 \
  --routing-profile fast \
  --thresholds tooling/perf-thresholds.json
kindx mcp --stop

# ── 8. Report hardware ──
echo "=== Hardware ==="
echo "CPU: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || lscpu | grep 'Model name' | sed 's/.*: *//')"
echo "RAM: $(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1024/1024/1024}' || free -g | awk '/Mem:/{print $2" GB"}')"
echo "Node: $(node --version)"
echo "KINDX: $(kindx --version)"
```

**Expected output:**

| Step | Expected Result | Duration |
|---|---|---|
| BM25 quality | 4/4 tests pass | < 5s |
| Vector + Hybrid quality | 10/10 tests pass (if models available) | 1–3 min |
| Latency | JSON with `query_median_ms`, `query_p95_ms`, `embed_throughput_docs_per_sec` | 30–90s |
| Insert regression | `transactional_bulk_vs_uncached ≥ 95%` — PASS | < 10s |

---

## 12. Failure Modes

These are real degraded-mode paths in the codebase. Every benchmark must report whether any of them triggered.

### 12.1 Rerank Timeout

**Trigger:** Reranker exceeds `rerankTimeoutMs` budget (env: `KINDX_RERANK_TIMEOUT_MS`, or per-collection `rerank_timeout_ms`).

**Behavior:** `markDegraded("rerank_timeout")`. Results fall back to synthetic exponential-decay scores: `score = exp(-index / 8.0)`. Preserves RRF rank order without reranker signal.

**Source:** `engine/repository.ts:4775`, `engine/repository.ts:4804`

**Benchmark impact:** Latency drops, quality degrades. Report both metrics.

### 12.2 Rerank Queue Saturation

**Trigger:** Rerank queue at capacity (`KINDX_RERANK_QUEUE_LIMIT`), and `dropPolicy = "timeout_fallback"`.

**Behavior:** `markDegraded("rerank_queue_saturated")`. Same exponential-decay fallback.

**Source:** `engine/repository.ts:4765`

**Benchmark impact:** Under high concurrency, saturation rate indicates system is overloaded. Scale `KINDX_RERANK_CONCURRENCY` or reduce `candidateLimit`.

### 12.3 Rerank Deferred

**Trigger:** Request waited in queue before getting a rerank slot (but wasn't timed out or saturated).

**Behavior:** `markDegraded("rerank_deferred")`. Reranking still occurs, but with added queue-wait latency.

**Source:** `engine/repository.ts:4786`

**Benchmark impact:** Increases tail latency (p95/p99). Quality preserved.

### 12.4 Rerank Failed

**Trigger:** Unrecoverable error during reranking (model crash, VRAM OOM, context allocation failure).

**Behavior:** `markDegraded("rerank_failed")`. Falls back to exponential-decay scoring.

**Source:** `engine/repository.ts:4820`

**Related:** `RerankContextAllocationError` in `engine/inference.ts` triggers CPU fallback via `tryActivateCpuFallback()` if the error is allocation-related.

### 12.5 Rerank Skipped

**Trigger:** `disableRerank=true` or `rerankLimit ≤ 0`.

**Behavior:** `markDegraded("rerank_skipped")`. No reranking occurs. RRF-only scoring.

**Source:** `engine/repository.ts:4755`

### 12.6 LLM Pool Exhaustion

**Trigger:** All `KINDX_LLM_POOL_SIZE` contexts in use and no slot becomes available within timeout.

**Behavior:**
- `immediate timeout (0ms)`: throws `LLMPoolExhaustedError`
- `wait timeout (>0ms)`: throws `LLMPoolTimeoutError` after waiting

**Source:** `engine/llm-pool.ts:87-93`, `engine/llm-pool.ts:124-136`

**Benchmark impact:** Under concurrency, pool contention is the dominant latency contributor. Increasing `KINDX_LLM_POOL_SIZE` trades VRAM for throughput.

### 12.7 Embedding Batch Failure

**Trigger:** `llm.embedBatch()` throws during vector query embedding.

**Behavior:** `markDegraded("embed_batch_failed")`. Vector search results are empty; only BM25 results contribute to RRF.

**Source:** `engine/repository.ts:4595`

### 12.8 Vector Search Partial Failure

**Trigger:** One or more shard reads fail during sharded vector search.

**Behavior:** `markDegraded("vector_search_partial_failure")`. Remaining shards contribute; recall is degraded proportionally.

**Source:** `engine/repository.ts:4635`, `engine/repository.ts:4650`

### 12.9 Cold-Start Spike

**Trigger:** First query after process start or model idle-timeout expiry.

**Behavior:** Not a degraded mode — full quality. But latency includes model load (3–8s), context creation, and GPU warm-up.

**Source:** `engine/inference.ts:701-729` (`ensureLlama()`), `engine/inference.ts:604-629` (`touchActivity()`)

**Benchmark impact:** Always separate cold-start timing from warm measurements. Cold-start variance is high (depends on disk I/O, VRAM availability, GPU driver state).

### 12.10 CPU Fallback

**Trigger:** GPU/Metal allocation failure (VRAM OOM, Metal assert, CUDA error).

**Behavior:** `tryActivateCpuFallback()` — disposes all GPU contexts, reinitializes with `gpu: false`. One-shot: does not retry GPU after fallback.

**Source:** `engine/inference.ts:771-787`

**Benchmark impact:** CPU inference is 5–20× slower. Report whether CPU fallback occurred.

### Degraded Mode Summary Table

```markdown
## Degraded Mode Summary

| Reason Code | Count | % of Queries | Impact |
|---|---|---|---|
| rerank_timeout | — | — | Quality: exponential-decay fallback |
| rerank_queue_saturated | — | — | Quality: exponential-decay fallback |
| rerank_deferred | — | — | Latency: queue-wait added |
| rerank_failed | — | — | Quality: exponential-decay fallback |
| rerank_skipped | — | — | Quality: no reranking |
| rerank_truncated | — | — | Quality: fewer candidates reranked |
| embed_batch_failed | — | — | Quality: vector search lost |
| vector_search_partial_failure | — | — | Quality: partial recall |
| ann_missing | — | — | Latency: exact scan fallback |
| ann_stale | — | — | Latency: exact scan fallback |
```

---

## 13. Repository Structure

Extends the existing `tooling/` convention:

```
BENCHMARKS.md                                    ← This document

tooling/
├── benchmark_release_hardening.ts               [EXISTS]  Embed + query cold/warm
├── benchmark_release_regressions.ts             [EXISTS]  Insert path + fan-out
├── benchmark_warm_daemon.ts                     [EXISTS]  HTTP concurrency
├── benchmark_llm_pool_contention.ts             [EXISTS]  LLM pool saturation
├── benchmark_concurrent_agents.ts               [EXISTS]  Multi-agent CLI
├── benchmark_local_rag.py                       [EXISTS]  KINDX vs LanceDB vs Chroma
├── benchmark_retrieval_integrity.py             [EXISTS]  sqlite-vec vs float32 baseline
├── perf-thresholds.json                         [EXISTS]  Daemon threshold config
├── init-cli-warmup.ts                           [EXISTS]  Model warmup helper
├── customer_pov_launch_gate.ts                  [EXISTS]  Phased release gate (P0–P3)
└── benchmarks/                                  [NEW]
    ├── runner.ts                                Unified harness: runs all tracks
    ├── generators/
    │   └── synthetic-corpus.ts                  Builds scaled corpora with relevance
    ├── tracks/
    │   ├── bm25-quality.ts                      Profile: BM25
    │   ├── vector-quality.ts                    Profile: Vector
    │   ├── hybrid-quality.ts                    Profiles: Hybrid, Hybrid-fast, Hybrid-max
    │   ├── indexing-throughput.ts               Embed / update / insert
    │   ├── serving-modes.ts                     CLI vs HTTP-daemon
    │   ├── cold-warm.ts                         Cold-start vs warm measurement
    │   ├── concurrency.ts                       Pool sweep (1/2/4/8)
    │   └── resource-usage.ts                    RSS / VRAM / disk
    ├── results/                                 Raw JSON (gitignored)
    └── reports/                                 Markdown reports (committed)

engine/
└── benchmarks.ts                                [EXISTS]  Reranker microbenchmark

specs/
├── eval-docs/                                   [EXISTS]  6-document eval corpus
├── evaluation-harness.ts                        [EXISTS]  Interactive eval runner
├── evaluation-bm25.test.ts                      [EXISTS]  BM25 quality gates
└── evaluation.test.ts                           [EXISTS]  BM25 + vector + hybrid gates
```

### .gitignore additions

```
tooling/benchmarks/results/
tooling/artifacts/
```

Reports in `tooling/benchmarks/reports/` should be committed as release evidence.

---

## 14. Implementation Roadmap

### Phase 1: Minimal Credible Suite

Automated quality + latency regression gates.

| Task | Effort |
|---|---|
| Consolidate eval queries into shared JSON file | 1 day |
| Create `tooling/benchmarks/runner.ts` orchestrating existing scripts | 2 days |
| Add `npm run bench:quality` — BM25 eval + threshold assertion | 1 day |
| Add `npm run bench:latency` — `benchmark_release_hardening.ts` with JSON output | 0.5 days |
| Add `npm run bench:all` — quality + latency + insert regressions | 0.5 days |
| Document baseline numbers in `reports/baseline-v1.3.2.md` | 1 day |

**Deliverable:** `npm run bench:all` → pass/fail exit code + JSON report.

### Phase 2: Quality Benchmarks

Per-stage quality evaluation with profile comparison.

| Task | Effort |
|---|---|
| Build synthetic corpus generator (100/1K/10K docs with gold relevance) | 3 days |
| Implement MRR, NDCG@k, Recall@k in harness | 2 days |
| Add per-difficulty-tier quality reporting | 1 day |
| Add routing profile comparison (fast vs balanced vs max_precision) | 1 day |
| Integrate `benchmark_local_rag.py` into unified report | 1 day |
| Add ANN recall/speed tradeoff at varying probe counts | 2 days |

**Deliverable:** Per-release quality report with regression detection.

### Phase 3: Concurrency / Resource Benchmarks

Production-characterization for multi-agent deployments.

| Task | Effort |
|---|---|
| Promote `perf-thresholds.json` from `informational` to enforcing | 0.5 days |
| Add LLM pool size sweep (1/2/4/8) with VRAM + latency | 2 days |
| Add rerank concurrency sweep with saturation curve | 1 day |
| Add RSS/VRAM profiling to all tracks | 1 day |
| Add encrypted-index overhead measurement | 1 day |
| Build Grafana dashboard template for `/metrics` | 2 days |

**Deliverable:** Resource planning guide with VRAM/RAM/CPU recommendations per pool size.

### Phase 4: Public Reproducibility

External users can reproduce results independently.

| Task | Effort |
|---|---|
| Package synthetic corpus + gold judgments as artifact | 1 day |
| Write step-by-step `BENCHMARKS-HOWTO.md` | 1 day |
| Add `Dockerfile.bench` pinning OS/Node/model versions | 2 days |
| Add CI job on tagged releases that archives report | 1 day |

**Deliverable:** `npm run bench:all` produces comparable results on any machine with the same hardware class.

---

## 15. Production Benchmark Execution Report (2026-04-18)

This section records the results of the full benchmark suite execution against the **MS MARCO** and **DBpedia** subsets scaled to 1,000 documents each (~2.5 MB embedding volume) to validate hardware tolerances.

### Provenance

- Metrics are from a production benchmark run executed on **April 18, 2026**.
- Isolated SQLite instances via `TMPDIR` were used to prevent B-tree fragmentation and measure pure path performance.
- All values are reported **as measured** and were not regenerated in this documentation change.

### 15.1 Hardware & Runtime Context

- **CPU**: Apple M2 (8 Cores)
- **RAM**: 8 GB
- **Runtime**: Node.js v25.9.0
- **Storage Profile**: NVMe SSD (Local)
- **Local Models Loaded (1.62 GB total footprint)**:
  - Embeddings: `embeddinggemma-300M` (313MB)
  - Reranker: `qwen3-reranker-0.6b` (610MB)
  - Generation: `LFM2.5-1.2B-Instruct` (697MB)

### 15.2 Benchmark Track: MS MARCO (1,000 document subset)

**Corpus Details**: 1000 chunks embedded  
**Total Execution Time**: 131.4s

### Indexing Performance
- **Insert Bulk Processing (docs/s)**: 3.57 docs/s
- **Vector Embedding Throughput**: 39.73 chunks/sec
- **Time to index & embed 1000 docs**: 26.85s (Total)
- **Index Size on Disk**: 6.0 MB

### Serving Performance (End-to-End Latency)
| Stage | P50 (Median) | P95 Latency | Min Latency |
|---|---:|---:|---:|
| **BM25 Search** | 712ms | 940ms | 705ms |
| **Vector Search** | 2.83s | 3.84s | 1.37s |
| **Hybrid (Cold Start)** | 3.89s | 4.48s | 3.89s |
| **Hybrid (Warm Cache)** | 6.88s | 8.62s | 6.20s |

### 15.3 Benchmark Track: DBpedia (1,000 document subset)

**Corpus Details**: 1000 chunks embedded  
**Total Execution Time**: 134.8s

### Indexing Performance
- **Insert Bulk Processing (docs/s)**: 1.47 docs/s (Note: DBpedia entity structure parsing causes heavier single-thread CPU bound parsing vs MS MARCO simple strings).
- **Vector Embedding Throughput**: 44.57 chunks/sec
- **Time to index & embed 1000 docs**: 26.5s (Total)
- **Index Size on Disk**: 5.5 MB

### Serving Performance (End-to-End Latency)
| Stage | P50 (Median) | P95 Latency | Min Latency |
|---|---:|---:|---:|
| **BM25 Search** | 807ms | 1.27s | 722ms |
| **Vector Search** | 3.15s | 5.45s | 1.85s |
| **Hybrid (Cold Start)** | 4.71s | 5.19s | 4.71s |
| **Hybrid (Warm Cache)** | 7.06s | 9.18s | 4.75s |

### 15.4 Scale Conclusions

1. **Embedding Budget**: 1,000 document subsets generated roughly 2,000 vectors across both suites, occupying exactly ~11.5 MB of combined SQLite index space and taking ~53 seconds to embed synchronously.
2. **Resource Paging**: The Hybrid pipeline exhibits high latency (7s-9s range for full end-to-end question answering). This is consistent with the previous 300 document run and validates that latency does not degrade logarithmically as the SQLite index size specifically grows from 300 to 1000 documents; rather, the generation (LLM token response length) remains the static bottleneck.
3. **Database Footprint**: Even at 1,000 documents, the index sizes remained at 6.0 MB and 5.5 MB respectively.

The system proves to be fundamentally stable under the specified 1GB scale boundaries.

### 15.5 Checks Covered

- `bench:all` (`tsx tooling/benchmarks/runner.ts --all --enforce`) is the canonical aggregate harness for quality/latency/regression checks.
- Invariant pass/fail logic is evaluated by `tooling/benchmarks/invariants.ts` and consumed by `tooling/benchmarks/runner.ts`.
- "All automated quality invariants passed" refers to this invariant evaluation path in the benchmark harness.

---

## Appendix: Existing Benchmark Inventory

| File | Type | What |
|---|---|---|
| `engine/benchmarks.ts` | Microbenchmark | Reranker throughput at 1/2/4/8 parallelism; VRAM, RSS, docs/sec |
| `tooling/benchmark_release_hardening.ts` | Integration | Embed time + query TTFR (median, p95) via CLI subprocess |
| `tooling/benchmark_release_regressions.ts` | Microbenchmark | Insert path (uncached/cached/bulk) + fan-out (seq/parallel) |
| `tooling/benchmark_warm_daemon.ts` | Load test | HTTP daemon at 10/25/50 sessions; p95, rerank timeout, degraded rate |
| `tooling/benchmark_llm_pool_contention.ts` | Stress test | LLM pool saturation with bounded timeout |
| `tooling/benchmark_concurrent_agents.ts` | Integration | 5 agents × 6 CLI commands concurrently |
| `tooling/benchmark_local_rag.py` | Comparative | KINDX vs LanceDB vs Chroma with Hit@k |
| `tooling/benchmark_retrieval_integrity.py` | Quality | KINDX query vs float32 TF-IDF baseline; MRR + Hit@k by bucket |
| `tooling/customer_pov_launch_gate.ts` | Release gate | Phased runner (P0–P3) with pass/fail/skip |
| `specs/evaluation-harness.ts` | Interactive | Run 18 eval queries; report Hit@k |
| `specs/evaluation-bm25.test.ts` | Unit test | BM25 quality gates (vitest, CI-safe) |
| `specs/evaluation.test.ts` | Unit test | BM25 + vector + hybrid quality gates (vector/hybrid skip in CI) |
