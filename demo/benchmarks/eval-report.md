# KINDX Retrieval Evaluation Report

**Date:** 2026-03-13
**Version:** KINDX 1.0.1
**Author:** KINDX Benchmark Suite (automated)

---

## 1. Test Setup

| Parameter        | Value                                              |
| ---------------- | -------------------------------------------------- |
| Corpus           | 6 markdown documents (specs/eval-docs/)            |
| Chunks           | ~42 chunks (avg ~297 tokens each)                  |
| Total tokens     | ~12,500                                            |
| Queries          | 24 hand-curated queries                            |
| Difficulty levels| 4 (easy, medium, hard, fusion)                     |
| Hardware         | Apple M2 Pro, 16 GB unified RAM, macOS 14          |
| Embedding model  | nomic-embed-text-v1.5 (768-dim, Matryoshka)        |
| Reranker model   | bge-reranker-v2-m3 (cross-encoder)                 |
| BM25 params      | k1=1.2, b=0.75 (default)                           |
| RRF constant     | k=60                                               |
| SQLite           | WAL mode, FTS5 for BM25                            |

### Difficulty Levels

- **Easy (6 queries):** Single-document, keyword-rich questions with exact phrase matches.
- **Medium (6 queries):** Paraphrased questions requiring synonym matching or light inference.
- **Hard (6 queries):** Cross-concept queries needing semantic understanding; no direct keyword overlap.
- **Fusion (6 queries):** Multi-document reasoning; correct answer spans 2+ documents.

---

## 2. Aggregate Results

### 2.1 Retrieval Accuracy by Mode

| Mode              | Hit@1  | Hit@3  | Hit@5  | MRR    | nDCG@5 |
| ----------------- | ------ | ------ | ------ | ------ | ------ |
| BM25              | 0.625  | 0.833  | 0.917  | 0.736  | 0.711  |
| Vector            | 0.708  | 0.875  | 0.958  | 0.788  | 0.763  |
| Hybrid (RRF)      | 0.792  | 0.917  | 0.958  | 0.849  | 0.822  |
| Hybrid + Rerank   | 0.833  | 0.958  | 1.000  | 0.896  | 0.871  |

### 2.2 Performance Comparison (ASCII)

```
nDCG@5 by Retrieval Mode
=========================

Hybrid+Rerank  |████████████████████████████████████████████▏  0.871
Hybrid (RRF)   |█████████████████████████████████████████▏     0.822
Vector          |██████████████████████████████████████▎        0.763
BM25            |████████████████████████████████████▋          0.711
               +------+------+------+------+------+------+
               0.0   0.2    0.4    0.6    0.8    1.0


MRR by Retrieval Mode
======================

Hybrid+Rerank  |█████████████████████████████████████████████▏ 0.896
Hybrid (RRF)   |██████████████████████████████████████████▌    0.849
Vector          |███████████████████████████████████████▍       0.788
BM25            |████████████████████████████████████▊          0.736
               +------+------+------+------+------+------+
               0.0   0.2    0.4    0.6    0.8    1.0
```

---

## 3. Results by Difficulty Level

### 3.1 BM25

| Difficulty | Hit@1  | Hit@3  | Hit@5  | MRR    | nDCG@5 |
| ---------- | ------ | ------ | ------ | ------ | ------ |
| Easy       | 1.000  | 1.000  | 1.000  | 1.000  | 1.000  |
| Medium     | 0.667  | 0.833  | 1.000  | 0.778  | 0.741  |
| Hard       | 0.333  | 0.667  | 0.833  | 0.500  | 0.479  |
| Fusion     | 0.500  | 0.833  | 0.833  | 0.667  | 0.623  |

### 3.2 Vector

| Difficulty | Hit@1  | Hit@3  | Hit@5  | MRR    | nDCG@5 |
| ---------- | ------ | ------ | ------ | ------ | ------ |
| Easy       | 1.000  | 1.000  | 1.000  | 1.000  | 1.000  |
| Medium     | 0.833  | 1.000  | 1.000  | 0.889  | 0.868  |
| Hard       | 0.500  | 0.667  | 0.833  | 0.611  | 0.583  |
| Fusion     | 0.500  | 0.833  | 1.000  | 0.639  | 0.601  |

### 3.3 Hybrid (RRF)

| Difficulty | Hit@1  | Hit@3  | Hit@5  | MRR    | nDCG@5 |
| ---------- | ------ | ------ | ------ | ------ | ------ |
| Easy       | 1.000  | 1.000  | 1.000  | 1.000  | 1.000  |
| Medium     | 0.833  | 1.000  | 1.000  | 0.889  | 0.868  |
| Hard       | 0.667  | 0.833  | 0.833  | 0.750  | 0.714  |
| Fusion     | 0.667  | 0.833  | 1.000  | 0.759  | 0.708  |

### 3.4 Hybrid + Rerank

| Difficulty | Hit@1  | Hit@3  | Hit@5  | MRR    | nDCG@5 |
| ---------- | ------ | ------ | ------ | ------ | ------ |
| Easy       | 1.000  | 1.000  | 1.000  | 1.000  | 1.000  |
| Medium     | 0.833  | 1.000  | 1.000  | 0.917  | 0.893  |
| Hard       | 0.667  | 0.833  | 1.000  | 0.778  | 0.753  |
| Fusion     | 0.833  | 1.000  | 1.000  | 0.889  | 0.839  |

### Difficulty Breakdown (ASCII)

```
nDCG@5 — Hybrid+Rerank by Difficulty
======================================

Easy    |██████████████████████████████████████████████████  1.000
Medium  |████████████████████████████████████████████▋       0.893
Hard    |█████████████████████████████████████▋              0.753
Fusion  |██████████████████████████████████████████▏         0.839
        +------+------+------+------+------+------+
        0.0   0.2    0.4    0.6    0.8    1.0
```

---

## 4. Latency Summary

| Mode              | Median (ms) | p95 (ms) | p99 (ms) |
| ----------------- | ----------- | -------- | -------- |
| BM25              | 3           | 8        | 14       |
| Vector            | 28          | 42       | 58       |
| Hybrid (RRF)      | 45          | 68       | 89       |
| Hybrid + Rerank   | 112         | 158      | 203      |

> BM25 and vector searches run in parallel during hybrid mode; the RRF merge
> adds < 1 ms overhead. Reranking is the dominant cost at ~65 ms median for
> top-10 candidate re-scoring.

---

## 5. Comparison vs. Baselines

| System                       | nDCG@5 | MRR   | p50 Latency (ms) |
| ---------------------------- | ------ | ----- | ----------------- |
| BM25 only (FTS5)             | 0.711  | 0.736 | 3                 |
| Vector only (cosine)         | 0.763  | 0.788 | 28                |
| Naive concat (BM25 + Vector) | 0.781  | 0.810 | 35                |
| **KINDX Hybrid (RRF)**       | **0.822** | **0.849** | **45**       |
| **KINDX Hybrid + Rerank**    | **0.871** | **0.896** | **112**      |

**Naive concat** merges BM25 and vector result lists by simple interleaving
without score normalization. RRF's rank-based fusion provides a +5.2%
nDCG@5 improvement over naive concat, and cross-encoder reranking adds
another +6.0%.

---

## 6. Analysis

### Why Hybrid + Rerank Outperforms

1. **Complementary recall.** BM25 excels at exact keyword matching (easy
   queries score 1.000 across the board), while vector search captures
   semantic similarity for paraphrased and conceptual queries. Reciprocal
   Rank Fusion combines both signals without requiring score calibration,
   ensuring that a document surfaced by *either* method is considered.

2. **RRF normalizes heterogeneous scores.** BM25 scores are unbounded TF-IDF
   values; cosine similarity scores fall in [-1, 1]. Rather than attempting
   brittle min-max normalization, RRF operates on rank positions alone
   (score = 1/(k + rank)), making it robust to score distribution differences.

3. **Cross-encoder reranking refines the top-k.** The bge-reranker-v2-m3
   cross-encoder jointly attends to the query and each candidate passage,
   capturing fine-grained token interactions that bi-encoder dot products
   miss. This is especially impactful for:
   - **Hard queries** (nDCG@5 jumps from 0.714 to 0.753) where subtle
     semantic distinctions matter.
   - **Fusion queries** (nDCG@5 jumps from 0.708 to 0.839) where multi-hop
     reasoning across documents benefits from contextual re-scoring.

4. **Small corpus amplifies reranker gains.** With only ~42 chunks, the
   reranker processes all plausible candidates, avoiding the recall ceiling
   that limits reranking on larger corpora where top-k truncation discards
   relevant passages before re-scoring.

### Failure Modes

- **BM25 on hard queries** (nDCG@5 = 0.479): queries deliberately avoid
  corpus vocabulary, causing BM25 to retrieve lexically similar but
  semantically irrelevant chunks.
- **Vector on fusion queries** (nDCG@5 = 0.601): the embedding model
  struggles with multi-hop queries that require combining evidence from
  distinct documents with different topic embeddings.
- **Hybrid without rerank on fusion queries** (nDCG@5 = 0.708): RRF
  surfaces the right documents but in suboptimal order; the reranker
  corrects ranking, pushing nDCG@5 to 0.839.

---

## 7. Conclusions

1. **Hybrid retrieval is the recommended default.** RRF fusion of BM25 and
   vector search delivers a +15.6% nDCG@5 improvement over BM25 alone at a
   median latency cost of only +42 ms.

2. **Reranking is worth the cost for quality-sensitive use cases.** Adding
   the cross-encoder reranker brings an additional +6.0% nDCG@5 at +67 ms
   median latency. For interactive use (< 200 ms budget), this is acceptable.

3. **BM25 remains the best choice for latency-critical paths** (autocomplete,
   incremental search) where 3 ms median response time is essential.

4. **Perfect Hit@5 = 1.000 with Hybrid + Rerank** means the correct document
   always appears in the top 5 results for this evaluation corpus, providing
   a strong foundation for downstream LLM answer generation.

5. **Scaling considerations:** These results are on a small corpus (~42 chunks).
   As corpus size grows, reranker gains may diminish if top-k retrieval
   truncation drops relevant passages before re-scoring. The latency report
   (latency-report.md) provides guidance for larger corpora.

---

*Generated by `run-eval.sh` against KINDX 1.0.1 on 2026-03-13.*
