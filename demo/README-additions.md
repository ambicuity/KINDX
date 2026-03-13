# README Additions

> Suggested sections to incorporate into the main project README.

---

## Tagline

**KINDX — The Local Memory Node for MCP Agents**

---

## 30-Second Quick Demo

See KINDX in action with a single command:

```bash
kindx demo
```

This prints a guided walkthrough of the main KINDX workflow. When the bundled `specs/eval-docs` corpus is available, the walkthrough references that local sample corpus; otherwise it falls back to simulated sample results.

What the demo does:
1. Shows the current CLI workflow for adding a collection and generating embeddings
2. Walks through BM25, vector, and hybrid retrieval examples
3. Shows agent-friendly output formats and MCP configuration
4. Ends with copy-pasteable next steps for a real collection

---

## Benchmark Results

Evaluated on the bundled `specs/eval-docs/` corpus with 24 hand-curated queries. The numbers below match [`demo/benchmarks/eval-results.json`](demo/benchmarks/eval-results.json).

| Mode              | Hit@1  | MRR    | nDCG@5 | Median Latency |
|-------------------|--------|--------|--------|----------------|
| BM25              | 0.625  | 0.736  | 0.711  | 3ms            |
| Vector            | 0.708  | 0.788  | 0.763  | 28ms           |
| Hybrid (RRF)      | 0.792  | 0.849  | 0.822  | 45ms           |
| Hybrid + Rerank   | 0.833  | 0.896  | 0.871  | 112ms          |

- **BM25** — Keyword search using Okapi BM25 scoring. Fastest mode, ideal for exact-match lookups.
- **Vector** — Semantic search using locally-computed embeddings. Best for natural language queries.
- **Hybrid (RRF)** — Reciprocal Rank Fusion combining BM25 and vector results. Best balance of speed and accuracy.
- **Hybrid + Rerank** — Hybrid results re-scored by a cross-encoder reranker. Highest accuracy at modest latency cost.

---

## Integration Recipes

Step-by-step guides for connecting KINDX to your workflow:

- [Claude Desktop](demo/recipes/claude-desktop.md) — Use KINDX as a memory backend for Claude Desktop via MCP.
- [VS Code + Continue](demo/recipes/continue-dev.md) — Add project-aware retrieval to Continue's AI assistant.
- [Cursor](demo/recipes/cursor-integration.md) — Connect Cursor's AI features to your local KINDX index.
- [LangChain Agent](demo/recipes/langchain-agent.md) — Use KINDX as a tool in LangChain agent pipelines.
- [AutoGPT](demo/recipes/autogpt-integration.md) — Connect autonomous agent frameworks to KINDX.

---

## Performance

KINDX is designed for local-first, low-latency retrieval:

| Operation              | Median Latency | p99 Latency |
|------------------------|----------------|-------------|
| BM25 search            | 3ms            | 8ms         |
| Vector search          | 28ms           | 52ms        |
| Hybrid search (RRF)    | 45ms           | 89ms        |
| Hybrid + rerank        | 112ms          | 203ms       |
| Document ingest (single)| 15ms          | 35ms        |
| Batch ingest (100 docs) | 1.2s          | 2.1s        |
| Cold start             | 2295ms         | 2295ms      |

The committed benchmark snapshot was captured on an Apple M2 Pro with 16 GB RAM running macOS 14.

---

## Why KINDX?

| Concern           | KINDX                                                       |
|-------------------|-------------------------------------------------------------|
| **Privacy**       | Everything runs locally. Your data never leaves your machine. No telemetry, no cloud calls, no API keys required. |
| **Speed**         | Sub-100ms hybrid search on commodity hardware. BM25 queries return in single-digit milliseconds. |
| **Offline**       | Fully functional without an internet connection. Embeddings are computed locally. |
| **MCP-native**    | Built from the ground up as an MCP server. Speaks the Model Context Protocol natively — no adapters or shims needed. |
| **Zero config**   | `npx kindx` and you're running. No Docker, no databases, no environment variables required for local use. |
| **Lightweight**   | Single Node.js process, SQLite storage, ~50 MB on disk. Runs comfortably alongside your IDE and AI tools. |
