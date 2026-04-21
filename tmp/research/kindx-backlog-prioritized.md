# KINDX Prioritized Backlog

## Scoring Framework (1-5 each, higher = better)

| # | Title | User Impact | Agent Impact | Perf Impact | Enterprise | Impl Cost (inv) | Maint Burden (inv) | Strategic Fit | **Total** | Priority |
|---|-------|------------|-------------|------------|-----------|-----------------|-------------------|--------------|-----------|----------|
| 1 | Context compression (maxLines) | 4 | 5 | 4 | 3 | 5 | 5 | 5 | **31** | P0 |
| 2 | Structured query trace spans | 3 | 4 | 2 | 5 | 5 | 5 | 5 | **29** | P0 |
| 3 | Memory TTL & decay | 3 | 5 | 3 | 4 | 4 | 4 | 5 | **28** | P0 |
| 4 | memory_delete tool | 3 | 5 | 1 | 3 | 5 | 5 | 5 | **27** | P0 |
| 5 | Adaptive query strategy | 4 | 4 | 4 | 2 | 4 | 4 | 5 | **27** | P0 |
| 6 | IR eval metrics (NDCG/MRR) | 2 | 2 | 1 | 3 | 5 | 5 | 5 | **23** | P1 |
| 7 | Result dedup by content hash | 3 | 3 | 2 | 2 | 5 | 5 | 4 | **24** | P1 |
| 8 | Audit logging | 1 | 1 | 1 | 5 | 5 | 4 | 4 | **21** | P1 |
| 9 | SSE streaming (HTTP) | 4 | 5 | 3 | 3 | 2 | 3 | 5 | **25** | P1 |
| 10 | Memory consolidation | 2 | 4 | 2 | 3 | 3 | 3 | 4 | **21** | P2 |
| 11 | Document link graph | 3 | 4 | 2 | 2 | 2 | 3 | 4 | **20** | P2 |
| 12 | Graph-augmented retrieval | 3 | 4 | 2 | 2 | 2 | 2 | 4 | **19** | P2 |
| 13 | VS Code extension | 4 | 3 | 1 | 2 | 2 | 2 | 4 | **18** | P3 |
| 14 | memory_bulk tool | 2 | 3 | 2 | 2 | 4 | 4 | 4 | **21** | P2 |

## Implementation Order (This Session)

1. ✅ Context compression — `maxLines` on query results
2. ✅ Memory TTL & `memory_delete` tool
3. ✅ Structured query trace spans  
4. ✅ Adaptive query auto-classification
5. ✅ Result deduplication improvements
