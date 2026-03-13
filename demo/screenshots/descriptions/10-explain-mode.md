# Screenshot 10: Explain Mode

## Description

Shows the full retrieval trace produced by `--explain` mode on a hybrid query. This is the most detailed output mode, revealing exactly how KINDX scored and ranked each result across both BM25 and vector retrieval pipelines.

## Command

```bash
$ kindx query my-docs "distributed consensus" --explain --top 3
```

## Expected Terminal Output

```
$ kindx query my-docs "distributed consensus" --explain --top 3
Hybrid Search: "distributed consensus" (3 results)

  ── Retrieval Trace ──────────────────────────────────────────────

  BM25 Pipeline:
    Query terms: ["distributed", "consensus"]
    Index stats: 34 docs, 18,293 terms, avgDL=538.0
    Top 5 by BM25:
      rank 1  [18.7] kindx://my-docs/consensus-algorithms.md
      rank 2  [14.3] kindx://my-docs/distributed-systems.md
      rank 3  [11.1] kindx://my-docs/raft-implementation.md
      rank 4  [ 7.6] kindx://my-docs/cap-theorem.md
      rank 5  [ 4.2] kindx://my-docs/event-sourcing.md

  Vector Pipeline:
    Query embedding: 384 dims, norm=1.00
    Similarity: cosine
    Top 5 by vector:
      rank 1  [0.95] kindx://my-docs/consensus-algorithms.md
      rank 2  [0.91] kindx://my-docs/raft-implementation.md
      rank 3  [0.87] kindx://my-docs/distributed-systems.md
      rank 4  [0.83] kindx://my-docs/paxos-notes.md
      rank 5  [0.79] kindx://my-docs/cap-theorem.md

  Fusion (RRF, k=60):
    Combined rankings:
      kindx://my-docs/consensus-algorithms.md  BM25=#1 + Vec=#1 -> 0.97
      kindx://my-docs/distributed-systems.md   BM25=#2 + Vec=#3 -> 0.88
      kindx://my-docs/raft-implementation.md   BM25=#3 + Vec=#2 -> 0.88

  ── Results ────────────────────────────────────────────────────

  #1  [0.97] kindx://my-docs/consensus-algorithms.md
      "Distributed consensus is the problem of getting multiple nodes to
       agree on a single value. Algorithms like Raft and Paxos solve this
       by electing a leader and replicating a log of state transitions
       across the cluster..."
      Retrieval: BM25=18.7 (rank 1) + Vector=0.95 (rank 1) -> RRF=0.97

  #2  [0.88] kindx://my-docs/distributed-systems.md
      "A distributed system is one in which components on networked
       computers coordinate by passing messages. Consensus protocols
       are the foundation for strong consistency guarantees..."
      Retrieval: BM25=14.3 (rank 2) + Vector=0.87 (rank 3) -> RRF=0.88

  #3  [0.88] kindx://my-docs/raft-implementation.md
      "Raft decomposes consensus into leader election, log replication,
       and safety. Our implementation uses heartbeat intervals of 150ms
       and election timeouts randomized between 300-500ms..."
      Retrieval: BM25=11.1 (rank 3) + Vector=0.91 (rank 2) -> RRF=0.88

  ── Timing ─────────────────────────────────────────────────────
    BM25 search:     1.2ms
    Vector search:   3.8ms
    Fusion:          0.1ms
    Total:           5.1ms
```

## Annotations

- **Retrieval Trace header:** The `--explain` flag activates the full trace, showing the internal workings of both retrieval pipelines before the final results.
- **BM25 Pipeline section:**
  - **Query terms:** Shows how the query was tokenized for keyword matching.
  - **Index stats:** Corpus-level statistics (document count, term count, average document length) that influence BM25 scoring.
  - **Top 5 by BM25:** The raw BM25 ranking before fusion. Scores are TF-IDF based.
- **Vector Pipeline section:**
  - **Query embedding:** Confirms the embedding dimensions and normalization.
  - **Similarity metric:** Cosine similarity is used for all vector comparisons.
  - **Top 5 by vector:** The raw vector ranking before fusion. Note rank differences vs BM25 -- `paxos-notes.md` appears in vector top 5 (rank 4) but not in BM25 top 5, showing how semantic search catches related concepts that lack exact keyword matches.
- **Fusion section:**
  - **RRF with k=60:** Reciprocal Rank Fusion with the standard k parameter of 60. The formula is `score(d) = sum(1 / (k + rank_i))` across both pipelines.
  - **Rank agreement:** `consensus-algorithms.md` was #1 in both pipelines, producing the highest fused score (0.97).
  - **Rank ties:** Results #2 and #3 have identical RRF scores (0.88) because their ranks swap between pipelines (BM25 #2/#3 vs Vector #3/#2). Tie-breaking uses the higher vector score.
- **Timing section:** Per-pipeline latency breakdown. Vector search is typically slower than BM25 due to distance computation, but both are sub-5ms on indexed collections. Fusion overhead is negligible.
- **Use case:** Explain mode is designed for debugging retrieval quality, tuning collection content, and building trust in the ranking. It is not intended for agent consumption -- agents should use the default output or `--json`.
