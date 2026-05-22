# KINDX Industry Roadmap

**Date:** 2026-05-22
**Status:** Draft
**Branch:** `feature/industry-roadmap-doc`
**Author:** Industry analysis (evidence-based)

---

## 1. Executive Summary

The AI industry is moving from chatbots to agents. Agents need memory, tools, context, permissions, observability, and safety. MCP is becoming the standard integration layer for agent-tool communication. RAG is evolving from basic vector retrieval toward hybrid, graph, agentic, corrective, and memory-augmented knowledge systems. Local-first is becoming a privacy and trust differentiator as users and enterprises demand data sovereignty. KINDX is well-positioned at the intersection of these trends but must act within a 6-12 month window before the market consolidates.

**Evidence:** KINDX's MCP server (`engine/protocol.ts`), hybrid retrieval pipeline (`engine/repository/retrieval/`), memory subsystem (`engine/memory.ts`), and local-first architecture (SQLite, GGUF models) align directly with these industry directions.

---

## 2. Industry Trends

### 2.1 MCP Standardization and Enterprise Readiness

**Trend:** MCP is moving from experimental to production. Transport layers are being hardened. Auth and policy frameworks are emerging. Enterprise governance requirements are being defined.

**Evidence for KINDX:** KINDX already has MCP server with stdio and HTTP transports (`engine/protocol.ts`), control-plane policies (`engine/mcp-control-plane.ts`), and RBAC (`engine/rbac.ts`). This puts KINDX ahead of most competitors.

### 2.2 Agent-to-Agent and Tool-to-Agent Communication

**Trend:** Agents are moving from single-turn interactions to multi-turn, multi-agent workflows. Agent-to-agent communication protocols are being standardized. Tools are becoming first-class participants in agent workflows.

**Evidence for KINDX:** `engine/subagent-contract.ts` defines subagent contracts. `engine/instruction-layering.ts` handles layered instructions. But multi-agent isolation (named indexes) is missing.

### 2.3 Local-First AI

**Trend:** Users and enterprises are demanding local-first AI for privacy, cost, offline capability, and data sovereignty. Bring-your-own-model is becoming a standard requirement. Local inference is becoming viable for production use cases.

**Evidence for KINDX:** KINDX is local-first by default. All inference via local GGUF models (`engine/inference.ts`). No telemetry. No cloud dependency. This is KINDX's strongest positioning.

### 2.4 Agent Memory as Infrastructure

**Trend:** Agent memory is evolving from simple key-value stores to structured, lifecycle-managed, auditable knowledge systems. Memory consolidation, decay, importance scoring, and cross-session continuity are becoming standard requirements.

**Evidence for KINDX:** `engine/memory.ts` has semantic dedup, TTL, supersession, and bulk operations. But lifecycle management (decay, consolidation, importance scoring) is incomplete.

### 2.5 Hybrid Retrieval as Baseline

**Trend:** Pure vector search is being replaced by hybrid retrieval (BM25 + vector + reranking). Reciprocal Rank Fusion is becoming standard. Query expansion and HyDE are being adopted. Reranking is moving from optional to expected.

**Evidence for KINDX:** KINDX's hybrid pipeline (BM25 + vector + RRF + reranking + query expansion) is production-grade and benchmarked. This is KINDX's strongest technical differentiator.

### 2.6 Corrective/Self-Improving RAG

**Trend:** RAG systems are adding feedback loops — agents can signal "this result wasn't useful" and the system adapts. Corrective RAG, self-RAG, and adaptive retrieval are active research areas.

**Evidence for KINDX:** No feedback loop exists. Open issue for corrective RAG. `engine/memory.ts` has supersession logic that could inform feedback.

### 2.7 Graph and Structured Retrieval

**Trend:** Document relationships (links, citations, dependencies) are being used to augment retrieval. Graph RAG (Microsoft) and knowledge graph integration are gaining traction. Structured data (tables, schemas) is being integrated with unstructured retrieval.

**Evidence for KINDX:** `engine/link-extractor.ts` extracts internal links. `engine/repository.ts` has `getGraphConnectedCandidates()`. But graph retrieval is not a first-class feature.

### 2.8 Multimodal RAG

**Trend:** RAG is expanding beyond text to images, audio, video, and structured data. Vision RAG (image understanding + retrieval) is a fast-growing area. Multimodal embedding models are becoming practical.

**Evidence for KINDX:** `engine/ingestion.ts` handles PDF/DOCX text extraction. No image, audio, or video support. Open issue for multimodal pipeline.

### 2.9 Retrieval Observability/Evaluation

**Trend:** Retrieval quality is being measured, tracked, and optimized. Evaluation harnesses, A/B testing, and quality dashboards are becoming standard. Users want to understand why a result was returned.

**Evidence for KINDX:** `engine/ir-metrics.ts` has MRR/NDCG computation. `BENCHMARKS.md` has comprehensive spec. But no automated CI gate, no per-query tracking, no quality dashboard.

### 2.10 Security and Prompt/Tool Injection

**Trend:** As agents become more capable, security is becoming critical. Prompt injection via retrieved documents, tool injection via MCP, and memory poisoning are active attack vectors. Defense-in-depth is being adopted.

**Evidence for KINDX:** `engine/rbac.ts`, `engine/encryption.ts`, `engine/audit.ts` exist. But no prompt injection defense, no tool injection defense, no input sanitization for document content.

### 2.11 Context Engineering

**Trend:** "Context engineering" is replacing "prompt engineering." The focus is shifting from crafting prompts to managing the entire context window — what goes in, what stays out, how to prioritize, how to compress. Retrieval is a context engineering problem.

**Evidence for KINDX:** KINDX's retrieval pipeline is a context engineering tool — it selects the most relevant context for agents. Query expansion, reranking, and score blending are context engineering techniques.

### 2.12 Personal Knowledge Bases for AI Agents

**Trend:** Users want their AI agents to have access to their personal knowledge — notes, documents, emails, bookmarks, code. Personal knowledge management is merging with agent memory.

**Evidence for KINDX:** KINDX indexes local documents and provides them to agents via MCP. This is exactly the personal knowledge base for AI agents use case.

### 2.13 Workspace/Team Memory

**Trend:** Teams are sharing agent memory across members. Workspace-level memory with per-user scoping and collaboration features is emerging. Enterprise deployments require multi-tenant memory.

**Evidence for KINDX:** `engine/rbac.ts` has multi-tenant RBAC. But no workspace concept, no shared memory pools, no collaboration features.

---

## 3. Implications for KINDX

| Trend | Why It Matters | KINDX Readiness | Gap | Recommended Response | Priority |
|-------|---------------|-----------------|-----|---------------------|----------|
| MCP standardization | KINDX's MCP-native design becomes more valuable | High (protocol.ts, mcp-control-plane.ts) | Auth, rate limiting, governance | Harden control plane, add OAuth2 | P0 |
| Agent-to-agent comms | Multi-agent workflows need isolation | Medium (subagent-contract.ts) | Named indexes, session isolation | Implement named indexes | P0 |
| Local-first AI | Privacy/trust differentiator | High (local GGUF, no telemetry) | Cold start, model management | Optimize cold start, add model CLI | P1 |
| Agent memory as infra | Memory lifecycle is a differentiator | Medium (memory.ts) | Decay, consolidation, importance | Implement memory lifecycle | P1 |
| Hybrid retrieval as baseline | KINDX's pipeline is ahead of market | High (retrieval/) | Larger eval corpus, CI gate | Add retrieval quality CI gate | P1 |
| Corrective RAG | Agents need to give feedback | Low | No feedback loop | Implement feedback tool | P1 |
| Graph retrieval | Document relationships augment search | Low (link-extractor.ts) | First-class graph retrieval | Add graph-augmented recall | P2 |
| Multimodal RAG | Images/audio/video in knowledge bases | Low (text-only ingestion) | Vision/audio ingestion | Add multimodal pipeline | P2 |
| Retrieval observability | Users need to understand ranking | Medium (ir-metrics.ts, --explain) | Dashboard, per-query tracking | Add quality dashboard | P2 |
| Security/injection | Agents are attack targets | Medium (rbac, encryption, audit) | Prompt injection defense | Add input sanitization | P0 |
| Context engineering | Retrieval IS context engineering | High (retrieval pipeline) | Framing, documentation | Position as context engineering tool | P1 |
| Personal knowledge | KINDX's core use case | High (local indexing, MCP) | Onboarding, UX | Fix onboarding, add wizard | P0 |
| Workspace/team memory | Enterprise adoption requires it | Medium (rbac.ts) | Workspace concept, shared memory | Add workspace mode | P2 |

---

## 4. MCP Direction

### What KINDX Should Prepare For

| MCP Trend | KINDX Preparation | Timeline |
|-----------|------------------|----------|
| **Better transport scalability** | KINDX already has HTTP transport. Need connection pooling and load testing. | 0-3 months |
| **Server discovery** | Implement `kindx://capabilities` MCP resource for structured discovery. | 0-3 months |
| **Auth and policy** | Add OAuth2, API keys, rate limiting to MCP server. Currently bearer-token only. | 3-6 months |
| **Agent communication** | Implement named indexes and session isolation for multi-agent workflows. | 3-6 months |
| **Task semantics** | MCP is adding task-level semantics (long-running operations, progress reporting). KINDX should support these. | 6-12 months |
| **Enterprise governance** | Add audit logging, compliance reporting, data retention policies. | 6-12 months |
| **Tool safety** | Add input sanitization, output validation, resource limits for MCP tools. | 0-3 months |
| **Capability manifests** | Implement structured capability discovery (tools, query types, models, config). | 0-3 months |

**Evidence:** `engine/protocol.ts` (MCP server), `engine/mcp-control-plane.ts` (control plane), `engine/session.ts` (sessions), `engine/tool-registry.ts` (tool factory).

---

## 5. RAG Direction

### The Evolution from Naive Vector RAG

```
Naive Vector RAG (2023)
  └─ Basic embedding + cosine similarity
  └─ Chroma, Pinecone, Weaviate

Hybrid RAG (2024)
  └─ BM25 + vector + fusion
  └─ KINDX, Weaviate (BM25+vector), LlamaIndex (via integrations)

Agentic RAG (2024-2025)
  └─ Agents decide when/how to retrieve
  └─ Query routing, multi-step retrieval
  └─ KINDX (structured search with routing profiles)

Corrective RAG (2025)
  └─ Agents provide feedback on retrieval quality
  └─ System adapts based on feedback
  └─ KINDX (planned), research prototypes

Graph RAG (2025)
  └─ Document relationships augment retrieval
  └─ Knowledge graphs, link graphs
  └─ Microsoft GraphRAG, KINDX (partial via link-extractor)

Memory-Augmented RAG (2025-2026)
  └─ Agent memory as first-class retrieval source
  └─ Scoped, lifecycle-managed, auditable
  └─ KINDX (memory.ts), M3 Memory

Evaluable RAG (2026)
  └─ Retrieval quality is measured, tracked, optimized
  └─ Evaluation harnesses, quality dashboards
  └─ KINDX (BENCHMARKS.md, ir-metrics.ts)
```

**KINDX Position:** KINDX is at the "Hybrid RAG + Agentic RAG" stage, with partial "Memory-Augmented RAG" and "Evaluable RAG." The next steps are "Corrective RAG" (feedback loop) and "Graph RAG" (document link graph).

**Evidence:** `engine/repository/retrieval/hybrid.ts` (hybrid RRF), `engine/repository/retrieval/structured.ts` (agentic routing), `engine/memory.ts` (memory-augmented), `engine/ir-metrics.ts` (evaluable), `engine/link-extractor.ts` (partial graph).

---

## 6. Local-First Direction

### Why Local-First Matters

| Reason | Description | KINDX Advantage |
|--------|-------------|-----------------|
| **Privacy** | Data never leaves the machine. No telemetry. No cloud dependency. | Default mode makes zero network requests. |
| **Cost** | No cloud API fees. No per-query pricing. No data storage fees. | All inference via local GGUF models. |
| **Offline capability** | Works without internet. No dependency on cloud services. | Fully offline after model download. |
| **Developer trust** | Developers trust local tools more than cloud services. | Open-source, auditable, no black boxes. |
| **Enterprise data boundaries** | Enterprises need data to stay within their boundaries. | Local-first with optional cloud features. |
| **Bring-your-own-model** | Users can use their own GGUF models. | `KINDX_EMBED_MODEL`, `KINDX_RERANK_MODEL`, `KINDX_EXPAND_MODEL` env vars. |
| **Personal knowledge ownership** | Users own their data. No vendor lock-in. | SQLite database is portable. Standard format. |

**Evidence:** `engine/inference.ts` (local GGUF), `engine/runtime.ts` (SQLite), `.env.example` (model configuration), `SECURITY.md` (security posture).

---

## 7. Strategic Bets for KINDX

### Bet 1: MCP-Native Local Knowledge Runtime

**Bet:** KINDX becomes the default knowledge runtime for MCP-compatible agents. Any agent that speaks MCP can query KINDX for private, hybrid-retrieved context.

**Why:** MCP is becoming the standard agent-tool protocol. Local-first is a privacy differentiator. No competitor owns "MCP-native local knowledge."

**Risk:** MCP may be superseded by another protocol. But the underlying need (agents need tools) is durable.

**Evidence:** `engine/protocol.ts` (MCP server), `engine/mcp-control-plane.ts` (control plane), `capabilities/kindx/SKILL.md` (agent skill).

### Bet 2: Agent Memory with Lifecycle and Auditability

**Bet:** KINDX's memory subsystem becomes the standard for agent memory — scoped, lifecycle-managed, auditable, and MCP-integrated.

**Why:** Agent memory is becoming infrastructure. Simple key-value stores are insufficient. Lifecycle management (decay, consolidation, importance) is the next frontier.

**Risk:** Competitors could add memory APIs. But KINDX's head start (semantic dedup, TTL, supersession) is significant.

**Evidence:** `engine/memory.ts` (memory subsystem), `engine/audit.ts` (audit log).

### Bet 3: Explainable Hybrid Retrieval

**Bet:** KINDX's retrieval pipeline becomes the benchmark for explainable, auditable retrieval. Users and agents can always understand why a result was returned.

**Why:** Trust requires explainability. Black-box retrieval is a liability for enterprise adoption.

**Risk:** Explainability adds complexity. But it is a differentiator, not a cost.

**Evidence:** `engine/repository/retrieval/rrf.ts` (`buildRrfTrace()`), `engine/ir-metrics.ts` (MRR/NDCG), `--explain` flag.

### Bet 4: Secure Multi-Agent Named Indexes

**Bet:** KINDX's named index isolation becomes the standard for multi-agent data security. Each agent gets its own index with RBAC, encryption, and audit logging.

**Why:** Multi-agent workflows require data isolation. Enterprise deployments need per-team or per-agent indexes. No competitor offers this.

**Risk:** Named indexes add complexity. But they are required for enterprise adoption.

**Evidence:** `engine/rbac.ts` (RBAC), `engine/encryption.ts` (encryption), `engine/audit.ts` (audit), `engine/sharding.ts` (sharding).

### Bet 5: Benchmarked Offline RAG Quality

**Bet:** KINDX's benchmark infrastructure becomes the authority for local RAG quality. Published, reproducible, comparable benchmarks drive credibility.

**Why:** No competitor has a public, reproducible RAG benchmark suite. KINDX's 9 scripts, comparison harness, and published results are unique.

**Risk:** Benchmarks require maintenance. But they are a trust-building asset.

**Evidence:** `tooling/benchmarks/` (9 scripts), `demo/benchmarks/` (results), `BENCHMARKS.md` (specification).

---

## 8. Anti-Bets / What to Avoid

| Anti-Bet | Why Avoid | When to Revisit |
|----------|-----------|-----------------|
| **Compete directly as generic vector DB** | Chroma, Qdrant, LanceDB own this market. KINDX's value is the full stack, not just vector search. | Only if vector DB adoption exceeds all other use cases. |
| **Become only a LangChain wrapper** | LangChain is a framework, not a product. KINDX should be standalone, with LangChain as an integration. | Only if LangChain becomes the dominant agent platform. |
| **Overbuild SaaS before local dev adoption** | Local-first is the core value proposition. Cloud hosting contradicts the positioning. | After 10K+ active local users. |
| **Add multimodal before stable text pipeline** | Multimodal is high-risk, high-complexity. Text pipeline must be rock-solid first. | After text retrieval quality CI gate is stable. |
| **Ignore security** | Security incidents destroy trust. Prompt injection and memory poisoning are real threats. | Never. Security is always a priority. |

---

## 9. 12-Month Industry-Aligned Roadmap

### Now (0-30 days)

| Initiative | Industry Trend | Evidence |
|------------|---------------|----------|
| Fix onboarding (kindx init wizard) | Personal knowledge bases for AI agents | `demo/cli-demos/basic-workflow.sh` (8 steps) |
| Golden demo video | Personal knowledge bases for AI agents | `demo/video-scripts/` (scripts exist, no videos) |
| Security posture doc | Security and prompt/tool injection | `SECURITY.md` (105 lines) |
| Capability manifest design | MCP standardization | Open issue |

### 30 Days (30-90 days)

| Initiative | Industry Trend | Evidence |
|------------|---------------|----------|
| Named indexes | Agent-to-agent comms | Open issue, `engine/sharding.ts` |
| Session lifecycle | MCP standardization | Open issue, `engine/session.ts` |
| Capability manifest | MCP standardization | Open issue |
| Corrective RAG feedback loop | Corrective/self-improving RAG | Open issue |
| Retrieval quality CI gate | Retrieval observability | `specs/evaluation.test.ts` (informational, not blocking) |

### 90 Days (3-6 months)

| Initiative | Industry Trend | Evidence |
|------------|---------------|----------|
| Multimodal ingestion | Multimodal RAG | Open issue, `engine/ingestion.ts` |
| Graph retrieval | Graph and structured retrieval | `engine/link-extractor.ts` |
| Production MCP auth | MCP enterprise readiness | `engine/protocol.ts` (bearer tokens only) |
| Memory lifecycle | Agent memory as infrastructure | `engine/memory.ts` (TTL but no decay) |
| Input sanitization | Security and prompt injection | No defense exists |

### 6 Months (6-12 months)

| Initiative | Industry Trend | Evidence |
|------------|---------------|----------|
| Sync layer | Local-first + optional sync | No implementation |
| Team/workspace mode | Workspace/team memory | `engine/rbac.ts` (no workspace concept) |
| Hosted optional control plane | Enterprise governance | No hosted infrastructure |
| Ecosystem integrations | Agent framework ecosystem | `python/kindx-langchain/` (thin adapter) |

---

## 10. Branch Plan

| Branch | Document | Status |
|--------|----------|--------|
| `feature/industry-roadmap-doc` | This document | Current |

---

## 11. Acceptance Criteria

- [x] 13 industry trends mapped to KINDX decisions
- [x] Each trend has readiness assessment, gap, and recommended response
- [x] MCP direction analyzed with 8 specific preparations
- [x] RAG evolution mapped with KINDX position identified
- [x] Local-first direction analyzed with 7 specific advantages
- [x] 5 strategic bets defined with rationale and risk
- [x] 5 anti-bets defined with rationale
- [x] 12-month roadmap aligned to industry trends

---

## Appendix: Evidence Sources

| Source | Path | Key Content |
|--------|------|-------------|
| MCP server | `engine/protocol.ts` | MCP tool registration, HTTP/stdio transports |
| Control plane | `engine/mcp-control-plane.ts` | Policy resolution, caching |
| Memory | `engine/memory.ts` | Semantic dedup, TTL, supersession |
| Hybrid retrieval | `engine/repository/retrieval/hybrid.ts` | BM25 + vector + RRF + reranking |
| Subagent contract | `engine/subagent-contract.ts` | Multi-agent contracts |
| Instruction layering | `engine/instruction-layering.ts` | Layered instruction loading |
| Link extractor | `engine/link-extractor.ts` | Document cross-references |
| IR metrics | `engine/ir-metrics.ts` | MRR, NDCG computation |
| Benchmarks | `BENCHMARKS.md` | 1091-line specification |
| Training | `training/` | Query expansion fine-tuning |
| Security | `SECURITY.md` | Security policy |
| RBAC | `engine/rbac.ts` | Multi-tenant RBAC |
| Encryption | `engine/encryption.ts` | SQLCipher support |
| Audit | `engine/audit.ts` | Append-only audit log |
