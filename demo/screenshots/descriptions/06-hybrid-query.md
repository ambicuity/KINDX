# Screenshot 06: Hybrid Query

## Description

Shows a hybrid search combining BM25 keyword matching and vector semantic similarity, with the `--explain` flag revealing the full scoring breakdown. Hybrid mode uses Reciprocal Rank Fusion (RRF) to merge results from both retrieval methods.

## Command

```bash
$ kindx query my-docs "startup fundraising strategy" --explain
```

## Expected Terminal Output

```
$ kindx query my-docs "startup fundraising strategy" --explain
Hybrid Search: "startup fundraising strategy" (5 results)

  #1  [0.93] kindx://my-docs/fundraising-guide.md
      "Series A fundraising requires a clear narrative around traction,
       market size, and capital efficiency. The most effective strategy
       is to create competitive tension among investors..."
      Retrieval: BM25=16.1 (rank 1) + Vector=0.94 (rank 1) -> RRF=0.93

  #2  [0.86] kindx://my-docs/startup-finance.md
      "Early-stage startups typically raise through SAFEs or convertible
       notes before pricing a round. Your fundraising strategy should
       align runway needs with dilution tolerance..."
      Retrieval: BM25=12.4 (rank 2) + Vector=0.88 (rank 3) -> RRF=0.86

  #3  [0.81] kindx://my-docs/investor-relations.md
      "Building investor relationships 6-12 months before you need
       capital gives you leverage. The best fundraising outcomes come
       from founders who treat it as a long-term strategy..."
      Retrieval: BM25=8.7 (rank 4) + Vector=0.90 (rank 2) -> RRF=0.81

  #4  [0.72] kindx://my-docs/pitch-deck-guide.md
      "Your pitch deck is the centerpiece of any fundraising process.
       Lead with the problem, show traction metrics, and close with
       a clear ask and use-of-funds breakdown..."
      Retrieval: BM25=9.3 (rank 3) + Vector=0.74 (rank 6) -> RRF=0.72

  #5  [0.64] kindx://my-docs/term-sheets.md
      "Understanding term sheet mechanics is critical to fundraising
       strategy. Key terms include valuation cap, discount rate,
       pro-rata rights, and liquidation preferences..."
      Retrieval: BM25=5.1 (rank 7) + Vector=0.82 (rank 4) -> RRF=0.64
```

## Annotations

- **Hybrid score (e.g., 0.93):** The final Reciprocal Rank Fusion (RRF) score. This is not a simple average -- it combines the rank positions from both methods using the formula: `RRF(d) = 1/(k + rank_bm25) + 1/(k + rank_vector)`, normalized to 0-1.
- **`--explain` flag:** Reveals the full retrieval trace for each result, showing both the BM25 score/rank and the vector score/rank, plus how they were fused.
- **Rank agreement:** Result #1 (`fundraising-guide.md`) ranked #1 in both BM25 and vector, giving it the highest RRF score. When both methods agree, confidence is high.
- **Rank disagreement:** Result #3 (`investor-relations.md`) ranked #4 in BM25 but #2 in vector. The hybrid score (0.81) reflects this split -- strong semantic relevance but weaker keyword match. This document likely discusses fundraising concepts without using the exact query terms.
- **Result #4 vs #3:** `pitch-deck-guide.md` ranked higher in BM25 (#3) than vector (#6), while `investor-relations.md` did the opposite. Hybrid search surfaces both, letting each method compensate for the other's blind spots.
- **Why hybrid matters:** A BM25-only search would miss semantically relevant documents that use different terminology. A vector-only search might miss documents with strong exact keyword matches. Hybrid gets the best of both.
