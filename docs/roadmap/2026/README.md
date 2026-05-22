# KINDX 2026 Roadmap

This directory holds the **roadmap-level** feature designs for KINDX 2026. Each
document defines a single moat-building investment that can be implemented
independently on its own Git branch and merged back into `main` without
blocking the others.

Roadmap docs are **complementary** to (not a replacement for) the
implementation specs under [`../../superpowers/specs/`](../../superpowers/specs/).
Specs cover narrower implementation slices (named indexes, retrieval feedback
loop, cold-start ANN, multimodal pipeline). Roadmap docs sit one tier above
them, defining product scope, competitive positioning, full CLI/MCP/HTTP
surface, schema/storage impact, file-by-file implementation, test matrices,
acceptance gates, risks, non-goals, and merge notes.

## The five 2026 designs

| # | Slug | Branch | Theme |
|---|------|--------|-------|
| 1 | [context-observability-evals](./context-observability-evals.md) | `feat/context-observability-evals` | Production RAG observability + reproducible evals + local dashboard. |
| 2 | [provenance-trust-freshness](./provenance-trust-freshness.md) | `feat/provenance-trust-freshness` | Verifiable provenance, trust scoring, freshness SLAs on every result. |
| 3 | [agent-workspace-memory-graph](./agent-workspace-memory-graph.md) | `feat/agent-workspace-memory-graph` | Local graph-RAG over scoped agent memory — entities, relations, traversal. |
| 4 | [a2a-agent-interoperability](./a2a-agent-interoperability.md) | `feat/a2a-agent-interoperability` | Google A2A surface + MCP↔A2A bridge for the 2026 agent fabric. |
| 5 | [local-first-multimodal-ingestion](./local-first-multimodal-ingestion.md) | `feat/local-first-multimodal-ingestion` | Native audio + video + screenshot ingestion, fully offline by default. |

## Suggested merge order

1. `provenance-trust-freshness` — adds additive metadata fields downstream
   features read.
2. `context-observability-evals` — eval/trace surface measures the new
   provenance signals and benchmarks the other branches.
3. `agent-workspace-memory-graph` — graph entities can carry provenance and
   show up in traces.
4. `local-first-multimodal-ingestion` — media segments inherit provenance,
   trust, and observability surfaces.
5. `a2a-agent-interoperability` — exposes everything above to peer agents and
   benefits from full trust/observability instrumentation.

## Conventions

- All schemas added to `packages/kindx-schemas` are **additive** — no breaking
  changes to existing Zod types.
- All SQLite changes ship as forward-only migrations under `engine/migrations/`
  guarded by `KINDX_SCHEMA_VERSION`.
- All new CLI commands support `--json` output for agentic consumers.
- All new MCP tools register through `engine/tool-registry.ts` so branches
  append rather than edit shared lines in `engine/protocol.ts`.
- Local-first remains the default. Remote OpenAI-compatible backends are
  always optional and gated behind explicit opt-in (`KINDX_LOCAL_ONLY=1` is
  the default in 2026 builds).
- All new endpoints respect the existing RBAC/loopback rules in
  `engine/rbac.ts` and reuse the audit log in `engine/audit.ts`.
