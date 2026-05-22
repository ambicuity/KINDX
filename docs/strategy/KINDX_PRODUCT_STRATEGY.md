# KINDX Product Strategy

> Local-first, privacy-guaranteed, MCP-native hybrid search engine for personal knowledge bases and agentic workflows.

**Version**: 1.0  
**Last Updated**: 2026-05-22  
**Owner**: @ambicuity  
**Status**: Living document

---

## 1. Executive Summary

KINDX is an on-device document intelligence engine that combines BM25 full-text search, vector similarity, and LLM-powered reranking into a single hybrid retrieval pipeline — all running locally via GGUF models with zero cloud dependencies.

At v1.3.5, KINDX is a production-hardened system with 829+ tests, 19 CI/CD workflows, multi-tenant RBAC, SQLCipher encryption, audit logging, and first-class Model Context Protocol (MCP) support. It ships a CLI, an MCP server (stdio and HTTP), TypeScript SDK packages, and a Docker image.

KINDX occupies a unique position in the landscape: it is the only local-first search engine that is MCP-native, supports structured hybrid retrieval (lex + vec + HyDE with RRF fusion), and ships a custom-trained query-expansion model (Qwen3-1.7B fine-tuned, 92% eval score) — making it fully self-contained with no external API dependencies for core functionality.

**Strategic thesis**: As AI agents become the primary consumers of knowledge bases, the retrieval layer must be local-first, MCP-native, and inference-capable. KINDX is built for this future.

---

## 2. Vision & Mission

### Vision

Be the default knowledge layer for AI agents running on-device — the retrieval engine that every agent framework, coding assistant, and personal knowledge tool integrates with.

### Mission

Provide the fastest, most accurate, and most private hybrid search engine for local document collections, accessible through CLI, MCP, and HTTP interfaces, with no cloud dependencies required.

### Guiding Principles

1. **Privacy is non-negotiable.** All inference runs on-device by default. Remote backends are opt-in, never opt-out.
2. **Retrieval quality is the product.** Hybrid retrieval (BM25 + vector + reranking) must measurably outperform any single-method approach.
3. **MCP is the integration surface.** Every capability must be accessible through MCP tools, making KINDX a drop-in knowledge base for any agent.
4. **Self-contained by default.** The product must work fully offline with bundled models — no API keys, no cloud services, no telemetry.
5. **Production-grade from day one.** Encryption, RBAC, audit logging, backup/restore, and observability are not premium features — they are baseline expectations.

---

## 3. Product Pillars

### Pillar 1: Privacy-First Architecture

All inference (embedding, reranking, query expansion) runs locally via `node-llama-cpp` with GGUF models. No data leaves the machine unless the user explicitly configures a remote backend.

**Key capabilities:**
- Local GGUF model execution (embeddinggemma-300M, qwen3-reranker-0.6B, Qwen3-1.7B)
- SQLCipher database encryption at rest
- No telemetry, no analytics, no phone-home
- Loopback-only HTTP binding by default
- Bearer-token authentication for HTTP MCP

**Why it matters:** Enterprise users and privacy-conscious individuals cannot send documents to cloud APIs. KINDX eliminates this friction entirely.

### Pillar 2: Hybrid Retrieval Excellence

KINDX's retrieval pipeline combines multiple search strategies and fuses results using Reciprocal Rank Fusion (RRF), producing higher-quality results than any single method.

**Pipeline:**
1. Query expansion via fine-tuned LLM (optional)
2. Parallel retrieval: BM25/FTS5 + vector similarity (original + expanded + HyDE queries)
3. RRF fusion with strong-signal preservation
4. Cross-encoder reranking (optional)
5. Position-aware blending (retrieval score + vector score + rerank score)

**Why it matters:** BM25 alone misses semantic matches. Vector search alone misses keyword precision. Hybrid retrieval with LLM reranking delivers the best of all worlds.

### Pillar 3: MCP-Native Agent Integration

KINDX implements the Model Context Protocol natively, exposing all capabilities as MCP tools over both stdio and Streamable HTTP transports.

**MCP tools:**
- `query` — structured hybrid search (lex/vec/hyde subqueries)
- `get` / `multi_get` — document retrieval by path, docid, or glob
- `memory_put` / `memory_search` — scoped agent memory storage
- Maintenance tools (status, diagnostics, memory management)

**Why it matters:** MCP is becoming the standard protocol for agent-tool integration. KINDX works out-of-the-box with Claude Desktop, Cursor, Continue, and any MCP-compatible agent.

### Pillar 4: Self-Contained Intelligence

KINDX ships a custom-trained query-expansion model (Qwen3-1.7B fine-tuned with LoRA, 92% eval score) that runs locally and improves retrieval quality without external API calls.

**Training pipeline:**
- SFT training with LoRA on Qwen3-1.7B
- 5-dimension reward function (Format, Diversity, HyDE, Quality, Entity)
- GGUF conversion for direct deployment
- Evaluation harness with IR metrics (MRR, NDCG, Precision, Recall)

**Why it matters:** Query expansion is the highest-leverage retrieval improvement, but most systems rely on cloud LLMs for it. KINDX delivers this capability locally with a purpose-trained model.

---

## 4. Target Users & Personas

### Persona 1: Individual Developer / Power User

**Profile:** Software engineer or researcher with a personal knowledge base (notes, documentation, code repos) who wants fast, private search without cloud dependencies.

**Needs:**
- Index local markdown/code collections
- Search via CLI or integrate with their editor
- Run fully offline
- Simple setup (npm install, done)

**Current fit:** Excellent. KINDX's CLI, `init` command, and MCP integration with Cursor/Continue directly serve this persona.

### Persona 2: AI Agent Builder

**Profile:** Developer building agents (LangChain, AutoGPT, custom frameworks) who needs a retrieval-augmented generation (RAG) knowledge base.

**Needs:**
- MCP tool interface for agent integration
- Structured queries (lex + vec + hyde)
- Scoped agent memory (short-term and long-term)
- TypeScript/Python SDK

**Current fit:** Strong. MCP tools, `@ambicuity/kindx-client`, and the LangChain retriever wrapper serve this persona. Subagent contracts provide orchestration primitives.

### Persona 3: Enterprise Team

**Profile:** Team deploying KINDX as a shared knowledge base with multiple users, requiring access control and data isolation.

**Needs:**
- Multi-tenant isolation
- Role-based access control (admin/editor/viewer)
- Encryption at rest
- Audit logging
- Backup/restore
- Docker deployment

**Current fit:** Strong. RBAC, SQLCipher encryption, audit logging, multi-arch Docker images, and Prometheus metrics are all shipped.

### Persona 4: Research / ML Practitioner

**Profile:** ML engineer or researcher studying retrieval systems, running experiments, or training custom models.

**Needs:**
- IR evaluation metrics (MRR, NDCG, Precision, Recall)
- Benchmark infrastructure
- Model fine-tuning pipeline
- Retrieval trace and debugging

**Current fit:** Good. `ir-metrics.ts`, benchmark suite, training pipeline, and RRF trace logging serve this persona.

---

## 5. Competitive Landscape

### Direct Competitors

| Feature | KINDX | ChromaDB | LanceDB | Khoj | AnythingLLM | PrivateGPT |
|---------|-------|----------|---------|------|-------------|------------|
| **Local-first** | ✅ Full | ✅ Full | ✅ Full | ⚠️ Optional | ⚠️ Optional | ✅ Full |
| **Hybrid retrieval** | ✅ BM25+Vec+Rerank | ❌ Vec only | ❌ Vec only | ✅ BM25+Vec | ⚠️ Basic | ⚠️ Basic |
| **MCP native** | ✅ Stdio+HTTP | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **CLI interface** | ✅ Full | ⚠️ Minimal | ⚠️ Minimal | ✅ Full | ❌ No | ❌ No |
| **Custom LLM training** | ✅ Shipped | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **Multi-tenant RBAC** | ✅ Shipped | ❌ No | ❌ No | ❌ No | ⚠️ Basic | ❌ No |
| **Encryption at rest** | ✅ SQLCipher | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| **Node.js / TypeScript** | ✅ Native | ❌ Python | ❌ Rust/Python | ❌ Python | ❌ Python | ❌ Python |
| **GGUF model support** | ✅ node-llama-cpp | ❌ No | ❌ No | ⚠️ Via API | ✅ Ollama | ✅ llama.cpp |
| **Query expansion** | ✅ Fine-tuned | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |

### KINDX's Competitive Moat

1. **Only MCP-native search engine.** MCP is the emerging standard for agent-tool integration. First-mover advantage is significant.
2. **Hybrid retrieval with RRF fusion.** Most competitors offer vector-only or basic BM25+vector. KINDX's multi-strategy pipeline with query expansion and cross-encoder reranking is more sophisticated.
3. **Self-contained with custom models.** Ships with a fine-tuned query-expansion model. No other local search engine trains and ships its own models.
4. **Node.js/TypeScript ecosystem.** The AI/ML tooling landscape is Python-dominated. KINDX serves the JavaScript/TypeScript developer ecosystem directly.
5. **Production enterprise features.** RBAC, encryption, audit logging, and multi-tenancy are typically absent from open-source local search tools.

### Competitor Response Strategy

- **If competitors add MCP:** KINDX's head start in MCP tool design, session management, and control-plane policy gives it a 6-12 month lead.
- **If competitors add hybrid retrieval:** KINDX's fine-tuned query expansion model and RRF implementation are non-trivial to replicate.
- **If Python tools add Node.js SDKs:** KINDX's native TypeScript engine has lower integration friction and smaller footprint than Python wrappers.

---

## 6. Technical Strategy & Architecture Evolution

### Current Architecture (v1.3.5)

```
CLI (kindx.ts)
  ├── Repository (decomposed into engine/repository/)
  │   ├── Content CRUD, FTS5, Vector search, Embeddings
  │   ├── Retrieval orchestration (hybrid, structured, RRF, rerank)
  │   └── Sharding, LLM cache, context annotations
  ├── Inference (inference.ts + remote-llm.ts)
  │   ├── Local GGUF via node-llama-cpp
  │   └── Remote OpenAI-compatible backend
  ├── Protocol (protocol.ts)
  │   ├── MCP stdio transport
  │   ├── MCP Streamable HTTP transport
  │   └── RBAC + bearer-token auth
  ├── Memory (memory.ts)
  ├── RBAC (rbac.ts)
  ├── Encryption (encryption.ts)
  ├── Sharding (sharding.ts)
  └── Infrastructure (audit, diagnostics, backup, session, watcher)
```

### Architecture Evolution Priorities

#### Priority 1: Repository Decomposition (In Progress)

`repository.ts` was the largest file (~3600 lines). Active decomposition into focused modules is underway:
- `content.ts`, `indexing.ts`, `fts.ts`, `vec.ts`, `embeddings.ts`
- `retrieval/hybrid.ts`, `retrieval/rrf.ts`, `retrieval/rerank.ts`
- `types.ts`, `store-init.ts`, `collections.ts`

**Goal:** Each module has one clear purpose, well-defined interfaces, and can be understood independently.

#### Priority 2: ANN Sharding for Large Collections

Sharding infrastructure exists (`sharding.ts`, 1205 lines). Next steps:
- ANN (Approximate Nearest Neighbor) centroid routing for sharded collections
- Configurable probe counts and shortlist sizes
- Benchmark validation against flat vector search

**Goal:** Support 100K+ document collections with sub-second retrieval.

#### Priority 3: Observability & Metrics

Prometheus metrics endpoint exists (`/metrics`). Evolution:
- Per-query trace spans (partially implemented via RRF trace)
- Retrieval pipeline timing breakdown
- Model inference latency tracking
- Collection health dashboards

**Goal:** Full observability for production deployments.

#### Priority 4: Model Training Pipeline Maturation

Training infrastructure exists (`training/`). Evolution:
- Automated evaluation against held-out test sets
- A/B testing framework for model variants
- Continuous training on user query logs (opt-in)
- Support for additional model architectures (beyond Qwen3)

**Goal:** Iteratively improve retrieval quality through model evolution.

---

## 7. Product Roadmap

### Near-Term (Q2–Q3 2026)

| Milestone | Description | Impact |
|-----------|-------------|--------|
| **Repository decomposition complete** | Finish breaking `repository.ts` into focused modules with clear boundaries | Maintainability, contributor onboarding |
| **v2.0 schema migration** | Finalize SQLite schema v2 with improved vector storage and sharding | Performance, scalability |
| **ANN shard routing** | Implement approximate nearest neighbor routing for sharded collections | Large collection support |
| **MCP control-plane v2** | Enhanced tool policy, provenance tracking, per-project configuration | Enterprise multi-tenant |
| **Retrieval quality benchmarks** | Enforced quality gates in CI (MRR, NDCG thresholds) | Regression prevention |
| **Documentation overhaul** | Comprehensive API docs, integration guides, architecture decision records | Developer adoption |

### Mid-Term (Q4 2026 – Q1 2027)

| Milestone | Description | Impact |
|-----------|-------------|--------|
| **Plugin system** | Allow custom retrieval strategies, extractors, and renderers | Extensibility |
| **Web UI dashboard** | Collection management, search interface, metrics visualization | Non-CLI users |
| **Multi-modal support** | Image and audio indexing with CLIP/Whisper models | Broader content types |
| **Query analytics** | Query pattern analysis, result quality feedback loop | Retrieval improvement |
| **Federated search** | Query across multiple KINDX instances | Team collaboration |
| **Model marketplace** | Community-contributed GGUF models for embedding/reranking | Ecosystem growth |

### Long-Term (2027+)

| Milestone | Description | Impact |
|-----------|-------------|--------|
| **KINDX Cloud (optional)** | Managed hosting for teams wanting zero-setup deployments | Revenue stream |
| **Agent memory federation** | Shared memory across agent instances with conflict resolution | Multi-agent systems |
| **Streaming ingestion** | Real-time document processing beyond file watching | High-throughput use cases |
| **Custom training UI** | Web-based fine-tuning interface for query expansion models | ML practitioner access |

---

## 8. Go-to-Market & Distribution

### Primary Channels

#### npm Registry
- **Package**: `@ambicuity/kindx`
- **Strategy**: Be the top result for "local search engine", "MCP server", "RAG tool" on npm
- **Actions**: Maintain high-quality README, comprehensive changelog, semantic versioning

#### Docker / OCI Registry
- **Image**: `ghcr.io/ambicuity/kindx`
- **Strategy**: Multi-arch images (amd64/arm64) for one-command deployment
- **Actions**: Keep images small, documented, and security-scanned

#### MCP Ecosystem
- **Integrations**: Claude Desktop, Cursor, Continue, LM Studio
- **Strategy**: Be listed as a recommended MCP server in each ecosystem's documentation
- **Actions**: Maintain `demo/recipes/` with integration guides, contribute to MCP ecosystem docs

#### Developer Community
- **GitHub**: `github.com/ambicuity/KINDX`
- **Strategy**: Active issue management, good-first-issues, contributor ladder
- **Actions**: Respond within 48h, maintain CONTRIBUTING.md, celebrate contributors

### Growth Tactics

1. **Content marketing**: Technical blog posts on hybrid retrieval, MCP integration, local-first AI
2. **Conference talks**: Present at AI/ML and developer tooling conferences
3. **Competitive benchmarking**: Publish fair comparison results (already have `demo/comparisons/`)
4. **Integration showcases**: Video demos with popular agent frameworks
5. **Community building**: GitHub Discussions, Discord/Slack community

---

## 9. Success Metrics & KPIs

### Adoption Metrics

| Metric | Current Baseline | 6-Month Target | 12-Month Target |
|--------|-----------------|----------------|-----------------|
| npm weekly downloads | TBD | 500 | 2,000 |
| GitHub stars | TBD | 500 | 2,000 |
| GitHub forks | TBD | 50 | 200 |
| Active contributors (monthly) | 1 | 5 | 15 |
| Docker pulls (monthly) | TBD | 200 | 1,000 |

### Quality Metrics

| Metric | Current Baseline | Target |
|--------|-----------------|--------|
| Test suite pass rate | 100% | 100% (gate) |
| Test count | 829+ | 1,000+ |
| BM25 MRR@10 | Tracked in benchmarks | ≥ 0.45 |
| Hybrid NDCG@10 | Tracked in benchmarks | ≥ 0.55 |
| Retrieval latency p95 | Tracked in benchmarks | ≤ 200ms |
| Retrieval latency p99 | Tracked in benchmarks | ≤ 500ms |

### Reliability Metrics

| Metric | Current Baseline | Target |
|--------|-----------------|--------|
| CI green rate | Tracked | ≥ 95% |
| Security scan pass rate | 100% | 100% (gate) |
| Mean time to patch (critical) | ≤ 7 days | ≤ 3 days |
| Backup/restore success rate | 100% | 100% (gate) |

### Community Metrics

| Metric | Target |
|--------|--------|
| Issue response time | ≤ 48 hours |
| PR review time | ≤ 72 hours |
| First-interaction welcome rate | 100% |
| Contributor retention (3-month) | ≥ 50% |

---

## 10. Risks & Mitigations

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **SQLite scaling limits** (>1M documents) | Medium | High | Sharding with ANN routing (in progress). Evaluate DuckDB/Parquet for analytics workloads. |
| **GGUF model quality ceiling** | Medium | Medium | Training pipeline supports model iteration. Remote LLM backend as fallback. Track benchmark trends. |
| **node-llama-cpp compatibility** | Low | High | Pin tested versions. Remote LLM backend as escape hatch. Contribute upstream fixes. |
| **sqlite-vec stability** | Low | Medium | FTS5 as fallback. Track upstream releases. Maintain vector index integrity tests. |
| **MCP protocol evolution** | Medium | Medium | Active participation in MCP spec discussions. Abstract transport layer. |

### Ecosystem Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **MCP adoption stalls** | Low | High | HTTP API as independent surface. CLI remains fully functional without MCP. |
| **Competing protocols emerge** | Medium | Medium | Protocol abstraction layer. MCP is well-positioned (Anthropic-backed, growing adoption). |
| **Python ecosystem dominance** | Medium | Low | KINDX's TypeScript focus is a differentiator, not a weakness. Node.js ecosystem is large. |

### Community Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Bus factor (single maintainer)** | High | Critical | Active contributor recruitment. Clear documentation. Path to maintainership in GOVERNANCE.md. |
| **Contribution velocity** | Medium | Medium | Good-first-issues program. Difficulty ladder. CodeRabbit/Gemini for automated review. |
| **Sponsorship/funding** | Medium | Medium | GitHub Sponsors. Optional managed hosting (KINDX Cloud). Consulting/services revenue. |

### Security Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Supply chain compromise** | Low | Critical | Dependabot auto-merge for patches. Trivy scanning. SBOM generation. Sigstore signing. |
| **Path traversal / injection** | Low | High | `path-safety.ts` utility. Timing-safe comparisons. Comprehensive security tests. |
| **Model supply chain** | Low | High | Pin model sources. Checksum verification. Document trusted model providers. |

---

## Appendix A: KINDX Technical Differentiators

1. **Hybrid Retrieval Pipeline**: BM25 (FTS5) + Vector (sqlite-vec) + LLM query expansion + cross-encoder reranking, fused with Reciprocal Rank Fusion (k=60) and position-aware blending.
2. **Custom-Trained Query Expansion**: Qwen3-1.7B fine-tuned with LoRA (rank 16, 5 epochs, lr 2e-4), achieving 92% average eval score across 5 reward dimensions.
3. **MCP-Native Architecture**: Full MCP implementation with stdio and Streamable HTTP transports, session management, bearer-token auth, and RBAC scoping.
4. **Cross-Runtime SQLite**: Unified database layer supporting both Node.js (better-sqlite3) and Bun (bun:sqlite) with automatic detection.
5. **Bounded LLM Pool**: FIFO-fair concurrency pool for LLM inference, preventing resource exhaustion under load.
6. **Resilient Store**: Auto-recycling stale/corrupt SQLite connections with read-only retry safety.

## Appendix B: Release History

| Version | Date | Highlights |
|---------|------|------------|
| v1.3.5 | 2026-05-09 | Reliability hardening, PR2/PR3 security fixes, schema drops |
| v1.3.4 | 2026-04-21 | OpenClaw integration CI, memory lifecycle, audit/chunker |
| v1.3.3 | 2026-04-21 | Memory TTL, memory_delete, query trace, adaptive classification |
| v1.3.2 | 2026-04-11 | Customer POV launch gate, RBAC hardening |
| v1.3.1 | 2026-04-08 | Lockfile regeneration, dependency alignment |
| v1.3.0 | 2026-04-08 | MCP control plane, subagent contracts, instruction layering, Arch integration |

## Appendix C: References

- [README](../../README.md) — Getting started, CLI reference, configuration
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — Contributor setup and workflow
- [SECURITY.md](../../SECURITY.md) — Vulnerability reporting and security policy
- [GOVERNANCE.md](../../GOVERNANCE.md) — Project governance model
- [BENCHMARKS.md](../../BENCHMARKS.md) — Benchmark methodology and results
- [CHANGELOG.md](../../CHANGELOG.md) — Full release history
- [AGENT.md](../../AGENT.md) — AI agent development instructions
