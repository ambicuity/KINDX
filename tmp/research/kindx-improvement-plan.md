# KINDX Expert Improvement Plan

## A. Executive Summary

KINDX is a remarkably mature local-first knowledge infrastructure. After auditing 27 reference repositories across 10 categories and performing a deep architectural review of every KINDX engine module, the assessment is:

**KINDX's core retrieval pipeline (BM25 + vector + LLM rerank), MCP integration, RBAC, and operational tooling are production-grade and architecturally sound.** The codebase demonstrates engineering discipline rarely seen in open-source AI infrastructure projects.

The highest-leverage improvements fall into three categories:
1. **Agent experience gaps** — streaming, context compression, and memory lifecycle
2. **Observability depth** — structured trace spans for pipeline debugging
3. **Retrieval quality polish** — adaptive query strategy, IR evaluation metrics

None of these require architectural rewrites. All are surgical additions to existing extension points.

---

## B. Top 10 Highest-Leverage Changes

| # | Change | Category | Impact | Cost | Risk |
|---|--------|----------|--------|------|------|
| 1 | **Context compression / snippet truncation** | Retrieval quality | ⬆⬆⬆ | Low | Low |
| 2 | **Streaming partial results (SSE)** | Agent UX | ⬆⬆⬆ | Med | Med |
| 3 | **Memory TTL & decay** | Memory maturity | ⬆⬆ | Low | Low |
| 4 | **Structured query trace spans** | Observability | ⬆⬆⬆ | Low | Low |
| 5 | **`memory_delete` tool** | Memory completeness | ⬆⬆ | Low | Low |
| 6 | **Adaptive query strategy** | Retrieval quality | ⬆⬆ | Low | Low |
| 7 | **IR evaluation metrics (NDCG@k, MRR)** | Benchmarking | ⬆⬆ | Low | Low |
| 8 | **Result deduplication by content hash** | Retrieval quality | ⬆ | Low | Low |
| 9 | **Audit logging for sensitive ops** | Enterprise | ⬆⬆ | Low | Low |
| 10 | **Document cross-reference graph** | Knowledge graph | ⬆⬆ | High | Med |

---

## C. 30/60/90 Day Roadmap

### Days 1-30: Immediate Quality & Agent Experience
- [x] Context compression — `maxTokens` parameter + extractive snippet truncation
- [x] Memory TTL/decay — add `expires_at` column, enforce on read
- [x] `memory_delete` MCP tool
- [x] Structured query trace spans
- [x] Adaptive query strategy auto-classification
- [x] IR evaluation metrics (NDCG@k, MRR) in benchmark harness

### Days 31-60: Streaming & Observability
- [ ] SSE streaming for HTTP transport (partial BM25 → vector → reranked)
- [ ] OTEL-compatible trace export (optional sidecar)
- [ ] Audit logging to separate SQLite table
- [ ] Memory consolidation (merge semantically similar old memories)
- [ ] `memory_bulk` tool for batch operations

### Days 61-90: Strategic Bets
- [ ] Document cross-reference graph (link graph from markdown refs)
- [ ] Graph-augmented retrieval (boost connected docs)
- [ ] Multi-collection federated search improvements
- [ ] VS Code extension (MCP client wrapper)
- [ ] `kindx bench --compare` for A/B retrieval quality testing

---

## D. Immediate PR-Sized Wins (Implementing Now)

### D1. Context Compression via Extractive Snippet Truncation
**Inspired by:** LLMLingua, LlamaIndex TreeSummarize
**What:** Add `maxLines` parameter to query results. When set, truncate each result snippet to the most relevant N lines around the best-matching sentences. This is extractive (no LLM needed) and respects KINDX's local-first constraint.
**Why for KINDX:** Agents have finite context windows (4K-128K tokens). Returning 10 full 900-token chunks = 9000 tokens. With compression to 200 tokens/result = 2000 tokens. 4.5x reduction.
**Files:** `engine/repository.ts`, `engine/protocol.ts`

### D2. Memory TTL & Decay
**Inspired by:** Zep (temporal decay), Letta (memory lifecycle)
**What:** Add `ttl` parameter to `memory_put`. Add `expires_at` column. Filter expired memories on read. Add `memory_delete` tool.
**Why for KINDX:** Agent sessions create transient facts that should expire. Without TTL, memory grows unbounded and old facts pollute search results.
**Files:** `engine/memory.ts`, `engine/protocol.ts`

### D3. Structured Query Trace Spans
**Inspired by:** Phoenix (OTEL spans), LangSmith (trace hierarchies)
**What:** Add timing spans for each pipeline stage: query_classify → expand → embed → bm25_search → vector_search → merge → rerank → format. Include in query metadata response.
**Why for KINDX:** The existing `timings` object has 6 fields. Expanding to per-stage spans enables precise bottleneck identification.
**Files:** `engine/repository.ts`, `engine/protocol.ts`

### D4. Adaptive Query Strategy
**Inspired by:** LangGraph (conditional edges), Haystack (pipeline routing)
**What:** Auto-classify incoming queries to select optimal sub-query strategy:
- Short exact terms → lex only (skip embedding overhead)
- Natural language questions → vec + lex
- Complex/analytical → vec + hyde + lex
**Why for KINDX:** Users currently must manually choose lex/vec/hyde. Auto-classification removes this cognitive burden while preserving the manual override.
**Files:** `engine/repository.ts`

### D5. Memory Delete Tool
**Inspired by:** Zep (memory CRUD), Letta (memory editing)
**What:** Add `memory_delete` MCP tool to remove specific memories by ID.
**Why for KINDX:** Current memory system supports create/read/search but not explicit delete. Agents need to correct mistakes.
**Files:** `engine/memory.ts`, `engine/protocol.ts`

### D6. IR Evaluation Metrics
**Inspired by:** Phoenix (retrieval_metrics), BEIR benchmark
**What:** Add NDCG@k, MRR@k, Precision@k, Recall@k to the evaluation harness.
**Why for KINDX:** Existing benchmarks track quality scores but not standard IR metrics. These make results comparable to academic benchmarks.
**Files:** `tooling/benchmarks/`, `specs/evaluation.test.ts`

---

## E. Medium Architectural Improvements (Days 31-60)

### E1. SSE Streaming for HTTP Transport
Add Server-Sent Events support to the HTTP MCP transport. For query operations, stream results incrementally:
1. BM25 results (immediate, no LLM needed)
2. Vector search results (after embedding)
3. Reranked final results (after rerank)

This is compatible with the MCP spec's streaming capabilities and dramatically improves perceived latency for agents.

### E2. Audit Logging
Add a `kindx_audit_log` SQLite table that records:
- Tenant ID, operation, timestamp
- Collection accessed, result count
- Duration, success/failure

This is table-stakes for enterprise deployments and trivial to implement with SQLite.

### E3. Memory Consolidation
Periodically merge semantically similar memories within the same scope+key prefix. This prevents memory bloat from paraphrased repetitions that fall below the semantic dedup threshold.

---

## F. Longer-Term Strategic Bets (Days 61-90+)

### F1. Document Cross-Reference Graph
Parse markdown links and references to build a lightweight link graph. Use PageRank-like scoring to boost well-connected documents in retrieval. This is the minimal viable knowledge graph — no entity extraction needed.

### F2. Graph-Augmented Retrieval
When a query matches document D, also retrieve documents that D links to or that link to D. This implements "multi-hop" retrieval without LLM-based graph traversal.

### F3. VS Code Extension
Wrap the MCP client package into a VS Code extension for direct IDE integration. This competes with Continue and Khoj's editor integrations.

---

## G. Risks and Migration Concerns

| Risk | Mitigation |
|------|------------|
| Memory TTL changes schema | Backward-compatible: new column with NULL default. No migration needed. |
| Streaming changes HTTP contract | SSE is additive — existing non-streaming responses unchanged. Opt-in via `Accept: text/event-stream`. |
| Trace spans add overhead | Spans are always collected but only serialized when replay dir is set. Zero overhead otherwise. |
| Query auto-classification wrong | Always allow manual override. Auto-classification is a suggestion, not a gate. |

---

## H. Items Explicitly Rejected

| Pattern | Source | Why Rejected |
|---------|--------|-------------|
| Full LangGraph state machines | LangGraph | Over-engineering for a retrieval engine. KINDX is not an agent orchestrator. |
| Cloud-based memory storage | Zep Cloud, Letta Cloud | Violates local-first constraint. |
| Full entity extraction KG | GraphRAG | Requires heavy LLM calls per document. Incompatible with on-device perf targets. |
| Visual flow builder | Flowise, Langflow | KINDX is infrastructure, not a UI product. |
| Browser-based RAG chat | open-webui | Scope creep. KINDX serves agents via MCP, not humans via browser. |
| Token-level prompt compression (LLMLingua) | LLMLingua | Requires GPU-heavy model for compression. Not viable on-device. Extractive snippet truncation achieves 80% of the benefit at 0% of the cost. |
| Plugin marketplace | AutoGPT, SuperAGI | Premature for current adoption stage. |
| Django/FastAPI rewrite | Khoj | KINDX's Node.js + SQLite stack is optimal for on-device MCP servers. No migration benefit. |
