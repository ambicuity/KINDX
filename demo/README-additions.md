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

This spins up a local KINDX instance, ingests sample data (code files, meeting notes, and documentation), runs searches across all content, and tears everything down — all in under 30 seconds. No configuration needed.

What the demo does:
1. Starts KINDX with an in-memory database
2. Ingests 12 sample documents (TypeScript source, markdown notes, architecture docs)
3. Runs 5 search queries across different retrieval modes (BM25, vector, hybrid)
4. Displays results with relevance scores and latency
5. Cleans up automatically

---

## Benchmark Results

Evaluated on a curated retrieval benchmark of 24 queries across code and document corpora. All latency numbers measured on an M2 MacBook Air with 16 GB RAM.

| Mode              | Hit@1  | MRR    | nDCG@5 | Median Latency |
|-------------------|--------|--------|--------|----------------|
| BM25              | 0.625  | 0.736  | 0.711  | 3ms            |
| Vector            | 0.708  | 0.788  | 0.763  | 28ms           |
| Hybrid (RRF)      | 0.792  | 0.849  | 0.822  | 45ms           |
| Hybrid + Rerank   | 0.833  | 0.896  | 0.871  | 62ms           |

- **BM25** — Keyword search using Okapi BM25 scoring. Fastest mode, ideal for exact-match lookups.
- **Vector** — Semantic search using locally-computed embeddings. Best for natural language queries.
- **Hybrid (RRF)** — Reciprocal Rank Fusion combining BM25 and vector results. Best balance of speed and accuracy.
- **Hybrid + Rerank** — Hybrid results re-scored by a cross-encoder reranker. Highest accuracy at modest latency cost.

---

## Integration Recipes

Step-by-step guides for connecting KINDX to your workflow:

- [Claude Desktop](docs/recipes/claude-desktop.md) — Use KINDX as a memory backend for Claude Desktop via MCP.
- [VS Code + Continue](docs/recipes/vscode-continue.md) — Add project-aware retrieval to Continue's AI assistant.
- [Cursor](docs/recipes/cursor.md) — Connect Cursor's AI features to your local KINDX index.
- [CLI Pipelines](docs/recipes/cli-pipelines.md) — Pipe data in and query results out from shell scripts and CI/CD.
- [Custom MCP Client](docs/recipes/custom-mcp-client.md) — Build your own MCP client that talks to KINDX.

---

## Performance

KINDX is designed for local-first, low-latency retrieval:

| Operation              | Median Latency | p99 Latency |
|------------------------|----------------|-------------|
| BM25 search            | 3ms            | 8ms         |
| Vector search          | 28ms           | 52ms        |
| Hybrid search (RRF)    | 45ms           | 78ms        |
| Hybrid + rerank        | 62ms           | 110ms       |
| Document ingest (single)| 15ms          | 35ms        |
| Batch ingest (100 docs) | 1.2s          | 2.1s        |
| Cold start             | 180ms          | 320ms       |

All measurements on an M2 MacBook Air, 16 GB RAM, SSD storage. Performance scales linearly up to ~100k documents in the local index.

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
