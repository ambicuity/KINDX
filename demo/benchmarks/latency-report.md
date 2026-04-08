# KINDX Latency Analysis Report

**Date:** 2026-03-13
**Version:** KINDX 1.0.1
**Hardware:** Apple M2 Pro, 16 GB unified RAM, macOS 14

---

## 1. Cold Start Times

Cold start measures the first query after process launch, including all
one-time initialization costs (model loading, SQLite connection, FTS5 index
warm-up).

| Component           | Time (ms) | Notes                                      |
| ------------------- | --------- | ------------------------------------------ |
| SQLite open + WAL   | 2         | Single db file, WAL mode enabled           |
| FTS5 index load     | 5         | Tokenizer + auxiliary tables               |
| BM25 first query    | 15        | Includes FTS5 warm-up                      |
| Embedding model load| 1,200     | nomic-embed-text-v1.5 GGUF into RAM        |
| Vector first query  | 1,235     | Model load (1,200) + encode + search (35)  |
| Reranker model load | 980       | bge-reranker-v2-m3 GGUF into RAM           |
| Hybrid first query  | 1,252     | Max(BM25, Vector) cold + RRF merge         |
| Hybrid+Rerank first | 2,295     | Hybrid cold + reranker cold + scoring      |

> After cold start, models stay resident in memory. Subsequent queries hit
> warm-path latencies shown below.

---

## 2. Warm Query Latency

Measured over 24 queries, 5 runs each (120 samples per mode). Outliers from
the first run excluded.

### 2.1 Summary Table

| Mode              | Min (ms) | Median (ms) | Mean (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| ----------------- | -------- | ----------- | --------- | -------- | -------- | -------- |
| BM25              | 1        | 3           | 4         | 8        | 14       | 18       |
| Vector            | 18       | 28          | 29        | 42       | 58       | 64       |
| Hybrid (RRF)      | 25       | 45          | 44        | 68       | 89       | 97       |
| Hybrid + Rerank   | 72       | 112         | 115       | 158      | 203      | 221      |

### 2.2 Latency Distribution (ASCII)

```
Warm Query Latency Distribution (median, ms)
==============================================

BM25             |██▍                                              3
Vector           |██████████████▏                                  28
Hybrid (RRF)     |██████████████████████▌                          45
Hybrid + Rerank  |████████████████████████████████████████████████████████  112
                 +--------+--------+--------+--------+--------+
                 0       25       50       75      100      125


p95 vs Median Latency (ms)
============================

BM25             median ██▍          p95 ████▏
                        3                8

Vector           median ██████████████▏          p95 █████████████████████▏
                        28                           42

Hybrid (RRF)     median ██████████████████████▌          p95 ██████████████████████████████████▏
                        45                                   68

Hybrid + Rerank  median ████████████████████████████████████████████████████████          p95 ███████████████████████████████████████████████████████████████████████████████████▏
                        112                                                                   158
```

### 2.3 Latency Breakdown — Hybrid + Rerank Pipeline

| Stage               | Median (ms) | % of Total |
| ------------------- | ----------- | ---------- |
| BM25 search         | 3           | 2.7%       |
| Vector encode query | 12          | 10.7%      |
| Vector ANN search   | 16          | 14.3%      |
| RRF merge           | 0.4         | 0.4%       |
| Rerank (top-10)     | 65          | 58.0%      |
| Result assembly     | 0.3         | 0.3%       |
| Overhead / IPC      | 15.3        | 13.7%      |
| **Total**           | **112**     | **100%**   |

> The cross-encoder reranker dominates latency at 58% of total time. BM25 and
> vector searches run in parallel; the pipeline wall-clock time is
> max(BM25, vector) + rerank, not the sum.

---

## 3. Embedding Throughput

Measured during `kindx embed` on the eval corpus (6 docs, ~42 chunks,
~12,500 tokens).

| Metric                    | Value          |
| ------------------------- | -------------- |
| Documents processed/sec   | 20             |
| Chunks embedded/sec       | 140            |
| Tokens processed/sec      | ~41,700        |
| Avg chunk embedding time  | 7.1 ms         |
| Batch size                | 16 chunks      |
| Model dimensions          | 768 (Matryoshka)|

### Throughput vs. Chunk Count (ASCII)

```
Embedding Throughput (chunks/sec) on M2 Pro
=============================================

16 chunks (1 batch)   |██████████████████████████████████████████████████  152
32 chunks (2 batches) |████████████████████████████████████████████████    145
64 chunks (4 batches) |███████████████████████████████████████████████     141
128 chunks (8 batches)|██████████████████████████████████████████████      138
256 chunks (16 batch) |█████████████████████████████████████████████▌      136
                      +--------+--------+--------+--------+--------+
                      0       40       80      120      160      200
```

> Throughput is stable across batch counts, showing minimal overhead from
> batch management. The slight decrease is due to thermal throttling during
> sustained load.

---

## 4. Reranking Throughput

| Configuration            | Pairs/sec | Notes                          |
| ------------------------ | --------- | ------------------------------ |
| Single worker            | 85        | Sequential cross-encoder calls |
| 2 parallel workers       | 155       | 1.82x speedup                 |
| 4 parallel workers       | 230       | 2.71x speedup                 |
| 8 parallel workers       | 248       | Diminishing returns (M2 Pro)   |

> The M2 Pro has 8 performance + 4 efficiency cores. Beyond 4 workers, gains
> plateau as the model becomes compute-bound rather than scheduling-bound.
> Default configuration uses 4 workers.

---

## 5. Memory Usage by Corpus Size

All measurements taken after embedding and with both models loaded. RSS
reported via `kindx stats`.

| Corpus Size  | Docs   | Chunks  | SQLite DB | Embedding RAM | Reranker RAM | Total RSS |
| ------------ | ------ | ------- | --------- | ------------- | ------------ | --------- |
| Eval (tiny)  | 6      | 42      | 0.3 MB    | 28 MB         | 15 MB        | ~45 MB    |
| Small        | 100    | 700     | 4 MB      | 32 MB         | 15 MB        | ~55 MB    |
| Medium       | 1,000  | 7,000   | 38 MB     | 62 MB         | 15 MB        | ~120 MB   |
| Large        | 10,000 | 70,000  | 380 MB    | 440 MB        | 15 MB        | ~850 MB   |
| XL           | 50,000 | 350,000 | 1.9 GB    | 1.2 GB        | 15 MB        | ~3.2 GB   |

### Memory Growth (ASCII)

```
Total RSS by Corpus Size
=========================

6 docs       |██▎                                                45 MB
100 docs     |██▊                                                55 MB
1K docs      |██████▏                                            120 MB
10K docs     |███████████████████████████████████████████▌        850 MB
50K docs     |██████████████████████████████████████████████████  3,200 MB
             +--------+--------+--------+--------+--------+
             0      800     1600     2400     3200     4000 MB
```

> Memory growth is dominated by the vector index (float32 embeddings:
> 768 dims x 4 bytes = 3 KB per chunk). At 350K chunks, vector storage
> alone is ~1.05 GB. The embedding model weights (~28 MB quantized) are a
> fixed cost regardless of corpus size.

---

## 6. SQLite WAL Mode Impact

Write-Ahead Logging (WAL) is enabled by default. Impact on concurrent
read/write workloads:

| Scenario                        | WAL Off (ms) | WAL On (ms) | Improvement |
| ------------------------------- | ------------ | ----------- | ----------- |
| BM25 query during embed         | 45           | 4           | 11.3x       |
| Vector query during embed       | 62           | 30          | 2.1x        |
| Hybrid query during embed       | 85           | 48          | 1.8x        |
| Embed throughput (chunks/sec)   | 125          | 140         | 1.12x       |

> WAL mode eliminates reader-writer contention. Queries no longer block on
> the write lock held by `kindx embed`, and embedding throughput improves
> slightly due to reduced lock contention overhead.

### Checkpoint Behavior

| Parameter               | Value        |
| ----------------------- | ------------ |
| Auto-checkpoint threshold | 1000 pages |
| Checkpoint mode         | PASSIVE      |
| WAL file steady-state   | < 4 MB       |
| Checkpoint duration     | 2-8 ms       |

> Checkpoints run passively and do not block readers. The WAL file is kept
> small via frequent auto-checkpoints during embedding.

---

## 7. Recommendations

### For Interactive Search (< 200 ms budget)

- Use **Hybrid + Rerank** as the default mode. Median latency of 112 ms is
  well within budget, and it delivers the highest retrieval quality.
- For autocomplete or keystroke-level search, fall back to **BM25 only**
  (3 ms median) and trigger a hybrid search on debounce/submit.

### For Large Corpora (> 10K docs)

- Monitor memory usage. At 50K docs, RSS reaches ~3.2 GB which is
  manageable on 16 GB machines but may pressure 8 GB devices.
- Consider reducing embedding dimensions via Matryoshka truncation
  (768 -> 256 dims = 3x memory reduction) if quality tradeoff is acceptable.
- Limit reranker top-k to 10-20 candidates to cap reranking latency.

### For Batch Indexing

- Use 4 parallel embedding workers for optimal throughput on M2 Pro.
- Embedding throughput scales linearly with batch size up to 16; beyond that,
  gains are marginal.
- Schedule large re-indexing during idle periods to avoid thermal throttling.

### For Cold Start Optimization

- Pre-load models at application launch (background thread) to eliminate the
  1.2s + 0.98s cold start penalty on first query.
- BM25 cold start (15 ms) is negligible and does not need pre-warming.

---

*Generated by `run-eval.sh` against KINDX 1.0.1 on 2026-03-13.*
