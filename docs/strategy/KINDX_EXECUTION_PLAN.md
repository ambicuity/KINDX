# KINDX Execution Plan

**Date:** 2026-05-22
**Status:** Draft
**Branch:** `feature/execution-plan-doc`
**Author:** Execution planning (evidence-based)

---

## 1. Executive Summary

### What to Do First

Fix onboarding and ship a golden demo. This is the single highest-impact, lowest-risk work. Users cannot adopt KINDX if they cannot get to their first query in under 2 minutes. The `kindx init` wizard, quickstart guide, and 2-minute demo video will do more for adoption than any technical feature.

### What to Split Across Branches

12 branches across 5 workstreams. Each branch is independently reviewable, testable, and mergeable. No branch depends on more than 2 other branches. The dependency graph is shallow (max depth: 3).

### What to Merge First

1. Docs branches (zero risk, immediate value)
2. Session lifecycle (foundation for all other features)
3. Capability manifest (independent, low risk)
4. Control-plane hardening (depends on session lifecycle)

### What Success Looks Like

After 4 weeks: Onboarding fixed, golden demo published, session lifecycle stable, named indexes designed, benchmark baseline captured, security posture documented. After 8 weeks: Named indexes implemented, capability manifest live, corrective RAG designed, retrieval quality CI gate active. After 12 weeks: Multimodal pipeline started, graph retrieval designed, production MCP auth implemented.

---

## 2. Workstream Overview

### Workstream A: Product + Docs

**Goal:** Fix onboarding, improve documentation, publish competitive analysis and industry roadmap.

**Branches:** `docs/product-strategy`, `docs/competitive-industry-analysis`, `feature/onboarding-golden-demo`

**Dependencies:** None. Can start immediately.

### Workstream B: Core Architecture

**Goal:** Stabilize session lifecycle, implement named indexes, harden control plane.

**Branches:** `feature/session-lifecycle`, `feature/named-indexes`, `feature/control-plane-hardening`

**Dependencies:** Session lifecycle is the foundation for named indexes and control-plane hardening.

### Workstream C: Retrieval Quality + Feedback

**Goal:** Implement corrective RAG feedback loop, add retrieval quality CI gate, capture benchmark baseline.

**Branches:** `feature/retrieval-feedback-loop`, `feature/benchmark-dashboard`

**Dependencies:** Session lifecycle (feedback is session-scoped).

### Workstream D: MCP Security + Multi-Agent

**Goal:** Implement capability manifest, add security posture documentation, harden MCP attack surface.

**Branches:** `feature/capability-manifest`, `feature/cold-start-ann`

**Dependencies:** Named indexes (ANN may be per-index).

### Workstream E: Performance + Benchmarks

**Goal:** Optimize cold start, add ANN for large corpora, publish benchmark dashboard.

**Branches:** `feature/cold-start-ann`, `feature/benchmark-dashboard`

**Dependencies:** Named indexes (ANN may be per-index).

---

## 3. Branch Matrix

| Branch | Workstream | Goal | Files/Directories | Dependencies | Risk | Complexity | Acceptance Criteria | Merge Order |
|--------|-----------|------|-------------------|--------------|------|------------|-------------------|-------------|
| `docs/product-strategy` | A | Product strategy doc | `docs/strategy/KINDX_PRODUCT_STRATEGY.md` | None | Low | Low | Mergeable Markdown doc | 1 |
| `docs/competitive-industry-analysis` | A | Competitive + industry docs | `docs/strategy/KINDX_COMPETITIVE_ANALYSIS.md`, `docs/strategy/KINDX_INDUSTRY_ROADMAP.md` | None | Low | Low | Mergeable Markdown docs | 2 |
| `feature/onboarding-golden-demo` | A | Fix onboarding, golden demo | `engine/commands/init-command.ts`, `README.md`, `demo/` | None | Medium | Medium | `kindx init` works, demo video published | 3 |
| `feature/session-lifecycle` | B | Session lifecycle | `engine/session.ts`, `engine/protocol.ts`, `engine/tool-registry.ts` | None | Medium | Medium | Session cleanup, abort propagation, isolation | 4 |
| `feature/capability-manifest` | D | Capability manifest | `engine/protocol.ts`, `engine/tool-registry.ts` | None | Low | Low | Structured capability discovery via MCP | 5 |
| `feature/control-plane-hardening` | B | Control-plane hardening | `engine/mcp-control-plane.ts`, `engine/protocol.ts` | Session lifecycle | Medium | Medium | Rate limiting, quotas, circuit breakers, audit | 6 |
| `feature/named-indexes` | B | Named indexes | `engine/repository/paths.ts`, `engine/catalogs.ts`, `engine/rbac.ts` | Session lifecycle | High | High | Per-index SQLite DBs, RBAC scoping | 7 |
| `feature/retrieval-feedback-loop` | C | Corrective RAG | `engine/memory.ts`, `engine/repository/retrieval/rerank.ts` | Session lifecycle | Medium | High | Feedback tool, signal storage, ranking adjustment | 8 |
| `feature/benchmark-dashboard` | E | Benchmark dashboard | `tooling/`, `demo/benchmarks/` | None | Low | Medium | CI gate for quality, published results page | 9 |
| `feature/cold-start-ann` | E | Cold start + ANN | `engine/inference.ts`, `engine/repository/vec.ts` | Named indexes | High | High | Daemon preloading, ANN for large corpora | 10 |
| `feature/index-versioning` | B | Index versioning | `engine/audit.ts`, `engine/schema.ts` | Named indexes | High | High | Document versioning, time-travel queries | 11 |
| `feature/multimodal-pipeline` | E | Multimodal pipeline | `engine/ingestion.ts`, `engine/inference.ts` | Cold start | Very High | Very High | Image/audio ingestion, multimodal retrieval | 12 |

---

## 4. Suggested Branches

### 4.1 `docs/product-strategy`

**Goal:** Commit KINDX_PRODUCT_STRATEGY.md to `docs/strategy/`.

**Files:** `docs/strategy/KINDX_PRODUCT_STRATEGY.md`

**Risk:** Zero. Documentation only.

**Complexity:** Low.

**Acceptance Criteria:** Mergeable Markdown doc with product direction, personas, positioning, roadmap, metrics.

### 4.2 `docs/competitive-industry-analysis`

**Goal:** Commit KINDX_COMPETITIVE_ANALYSIS.md and KINDX_INDUSTRY_ROADMAP.md to `docs/strategy/`.

**Files:** `docs/strategy/KINDX_COMPETITIVE_ANALYSIS.md`, `docs/strategy/KINDX_INDUSTRY_ROADMAP.md`

**Risk:** Zero. Documentation only.

**Complexity:** Low.

**Acceptance Criteria:** Mergeable Markdown docs with competitor matrix, differentiation, industry trends, strategic bets.

### 4.3 `feature/onboarding-golden-demo`

**Goal:** Fix onboarding experience and publish golden demo.

**Files:** `engine/commands/init-command.ts` (new), `README.md`, `demo/cli-demos/`, `demo/video-scripts/`, `capabilities/kindx/`

**Risk:** Medium. Touches CLI and docs.

**Complexity:** Medium. `kindx init` wizard needs to: (1) check prerequisites, (2) create default config, (3) download models, (4) verify setup.

**Acceptance Criteria:**
- `kindx init` creates a working config in under 2 minutes.
- Quickstart guide exists with 10-step path to first query.
- Golden demo video (2 min) is published.
- `README.md` has a quickstart section at the top.

### 4.4 `feature/session-lifecycle`

**Goal:** Stabilize KindxSession lifecycle for reliable MCP sessions.

**Files:** `engine/session.ts`, `engine/protocol.ts`, `engine/tool-registry.ts`, `specs/session.test.ts`

**Risk:** Medium. Touches core session management.

**Complexity:** Medium. Requires: (1) per-request abort controllers, (2) session cleanup on transport close, (3) concurrent request isolation, (4) session registry cleanup.

**Acceptance Criteria:**
- Session cleanup is guaranteed on transport close.
- Abort propagation works across all MCP tool calls.
- Concurrent requests on the same session are isolated.
- Session registry properly tracks and cleans up sessions.
- All existing tests pass.

### 4.5 `feature/capability-manifest`

**Goal:** Implement structured capability discovery for agents.

**Files:** `engine/protocol.ts`, `engine/tool-registry.ts`, `specs/mcp.test.ts`

**Risk:** Low. Additive feature.

**Complexity:** Low. Requires a `kindx://capabilities` MCP resource or `capabilities` tool that returns JSON.

**Acceptance Criteria:**
- A `kindx://capabilities` MCP resource exists.
- The manifest lists available tools, supported query types, loaded models, and current configuration.
- The manifest is machine-readable (JSON schema).
- The manifest updates dynamically based on runtime state.
- Tests cover manifest content and dynamic updates.

### 4.6 `feature/control-plane-hardening`

**Goal:** Add rate limiting, quotas, circuit breakers, and audit logging to MCP control plane.

**Files:** `engine/mcp-control-plane.ts`, `engine/protocol.ts`, `engine/audit.ts`, `specs/mcp-control-plane.test.ts`

**Risk:** Medium. Touches core control plane.

**Complexity:** Medium. Requires: (1) per-session rate limiter, (2) per-tool request quotas, (3) circuit breakers for LLM timeouts, (4) audit logging for policy decisions.

**Acceptance Criteria:**
- Per-session rate limiting is enforced.
- Request quotas are configurable per tool.
- Circuit breakers prevent cascade failures on LLM timeouts.
- All policy decisions are audit-logged.
- Tests cover rate limiting, quotas, and circuit breakers.

### 4.7 `feature/named-indexes`

**Goal:** Implement per-agent index isolation with named indexes.

**Files:** `engine/repository/paths.ts`, `engine/repository/store-init.ts`, `engine/catalogs.ts`, `engine/protocol.ts`, `engine/rbac.ts`

**Risk:** High. Major architectural change.

**Complexity:** High. Requires: (1) database-per-index isolation, (2) index lifecycle management (create, delete, migrate), (3) RBAC scoping to indexes, (4) cross-index query federation (optional).

**Acceptance Criteria:**
- Each named index has its own SQLite database.
- Agents are scoped to specific indexes via RBAC.
- Index lifecycle (create, delete, migrate) is managed via CLI and MCP.
- Cross-index queries are possible via explicit opt-in.
- All existing tests pass with default (unnamed) index.

### 4.8 `feature/retrieval-feedback-loop`

**Goal:** Implement corrective RAG feedback loop.

**Files:** `engine/memory.ts`, `engine/repository/retrieval/rerank.ts`, `engine/protocol.ts`, `specs/evaluation.test.ts`

**Risk:** Medium. Touches retrieval pipeline.

**Complexity:** High. Requires: (1) `feedback` MCP tool, (2) feedback signal storage, (3) relevance model updates, (4) ranking adjustment logic.

**Acceptance Criteria:**
- A `feedback` MCP tool accepts result IDs and satisfaction signals.
- Feedback is stored and associated with queries and results.
- Subsequent queries for similar intents use feedback to adjust ranking.
- Feedback metrics are exposed via diagnostics.
- Tests cover feedback storage and ranking adjustment.

### 4.9 `feature/benchmark-dashboard`

**Goal:** Publish benchmark results and add CI gate for quality regressions.

**Files:** `tooling/benchmarks/`, `demo/benchmarks/`, `.github/workflows/ci.yml`

**Risk:** Low. Additive.

**Complexity:** Medium. Requires: (1) CI gate for retrieval quality, (2) published results page, (3) comparison charts.

**Acceptance Criteria:**
- CI blocks PRs that regress retrieval quality by > 5%.
- Benchmark results are published as a GitHub Pages site.
- Comparison charts show KINDX vs competitors.
- Benchmark reproduction instructions are documented.

### 4.10 `feature/cold-start-ann`

**Goal:** Optimize cold start and add ANN for large corpora.

**Files:** `engine/inference.ts`, `engine/repository/vec.ts`, `engine/sharding.ts`, `engine/preloader.ts`

**Risk:** High. Performance-sensitive.

**Complexity:** High. Requires: (1) daemon-mode preloading, (2) lazy model loading, (3) HNSW/ANN index for large corpora, (4) fallback to brute-force.

**Acceptance Criteria:**
- First query latency is under 10 seconds.
- `kindx daemon --preload` preloads models on daemon start.
- For corpora > 10K documents, ANN indexing is available.
- ANN fallback to brute-force is transparent and documented.

### 4.11 `feature/index-versioning`

**Goal:** Implement index versioning and time-travel audit log.

**Files:** `engine/audit.ts`, `engine/schema.ts`, `engine/repository/content.ts`, `engine/backup.ts`

**Risk:** High. Storage-intensive.

**Complexity:** High. Requires: (1) document versioning, (2) index snapshots, (3) time-travel query support, (4) diff command.

**Acceptance Criteria:**
- Document versions are tracked with timestamps.
- A `kindx history` command shows index changes over time.
- A `kindx diff` command shows what changed between two points.
- Audit log entries are queryable by time range and operation type.

### 4.12 `feature/multimodal-pipeline`

**Goal:** Add multimodal ingestion (images, audio, structured data).

**Files:** `engine/ingestion.ts`, `engine/inference.ts`, `engine/schema.ts`, `engine/repository/retrieval/`

**Risk:** Very High. Major new capability.

**Complexity:** Very High. Requires: (1) vision model integration, (2) new content types, (3) multimodal embedding, (4) hybrid retrieval across text and visual content.

**Acceptance Criteria:**
- Images are ingested and described via vision model.
- Image descriptions are indexed and searchable.
- CSV/JSON data is indexed with schema-aware chunking.
- Hybrid retrieval works across text and visual content.

---

## 5. P0 Work (Must Do)

| # | Initiative | Branch | Why P0 | Evidence |
|---|-----------|--------|--------|----------|
| 1 | Onboarding docs + golden demo | `feature/onboarding-golden-demo` | #1 adoption killer | `demo/cli-demos/basic-workflow.sh` (8 steps) |
| 2 | Session lifecycle | `feature/session-lifecycle` | Foundation for all MCP work | `engine/session.ts` (incomplete) |
| 3 | Control-plane hardening | `feature/control-plane-hardening` | Required for production MCP | `engine/mcp-control-plane.ts` (basic) |
| 4 | Named indexes | `feature/named-indexes` | Required for multi-agent | Open issue |
| 5 | Retrieval quality benchmark | `feature/benchmark-dashboard` | Quality regressions ship undetected | `specs/evaluation.test.ts` (informational) |
| 6 | Security posture doc | `docs/product-strategy` | Trust requires transparency | `SECURITY.md` (105 lines) |
| 7 | CI gate for benchmark regression | `feature/benchmark-dashboard` | Quality gate | `tooling/perf-thresholds.json` (informational) |

---

## 6. P1 Work (Should Do)

| # | Initiative | Branch | Why P1 | Evidence |
|---|-----------|--------|--------|----------|
| 1 | Capability manifest | `feature/capability-manifest` | Agent discovery | Open issue |
| 2 | Corrective RAG | `feature/retrieval-feedback-loop` | Retrieval improvement | Open issue |
| 3 | Memory lifecycle | (future branch) | Memory quality | `engine/memory.ts` (TTL but no decay) |
| 4 | Improved observability | (future branch) | Debugging | `engine/utils/logger.ts` (basic) |
| 5 | Client SDK polish | (future branch) | Developer experience | `packages/kindx-client/` (minimal docs) |
| 6 | Docker/install hardening | (future branch) | Cross-platform reliability | `Dockerfile`, `specs/smoke-install.sh` |

---

## 7. P2 Work (Nice to Have)

| # | Initiative | Branch | Why P2 | Evidence |
|---|-----------|--------|--------|----------|
| 1 | HNSW/ANN escape hatch | `feature/cold-start-ann` | Large corpus performance | `engine/repository/vec.ts` (brute-force) |
| 2 | Index versioning | `feature/index-versioning` | Compliance/debugging | Open issue |
| 3 | Multimodal pipeline | `feature/multimodal-pipeline` | Images/audio/structured data | Open issue |
| 4 | Graph/SQL-agent hybrid | (future branch) | Advanced retrieval | `engine/link-extractor.ts` (basic) |
| 5 | Team/workspace mode | (future branch) | Enterprise adoption | `engine/rbac.ts` (no workspace) |

---

## 8. Weekly Plan

### Week 1: Docs + Repo Audit + Golden Demo

| Day | Task | Branch | Deliverable |
|-----|------|--------|-------------|
| Mon | Commit strategy docs | `docs/product-strategy`, `docs/competitive-industry-analysis` | 4 Markdown files in `docs/strategy/` |
| Tue | Repo audit: triage issues #12-#29 | N/A | Prioritized issue list |
| Wed | Start `kindx init` wizard | `feature/onboarding-golden-demo` | Working `kindx init` command |
| Thu | Write quickstart guide | `feature/onboarding-golden-demo` | 10-step quickstart in README |
| Fri | Record golden demo video | `feature/onboarding-golden-demo` | 2-minute demo video |

### Week 2: Session Lifecycle + Benchmark Baseline

| Day | Task | Branch | Deliverable |
|-----|------|--------|-------------|
| Mon | Start session lifecycle | `feature/session-lifecycle` | Session cleanup on transport close |
| Tue | Abort propagation | `feature/session-lifecycle` | Abort signals propagate to LLM calls |
| Wed | Concurrent request isolation | `feature/session-lifecycle` | Per-request isolation |
| Thu | Capture benchmark baseline | N/A | `tooling/artifacts/baseline-*.json` |
| Fri | Session lifecycle tests | `feature/session-lifecycle` | All existing tests pass + new session tests |

### Week 3: Control-Plane + Capability Manifest + Corrective RAG Design

| Day | Task | Branch | Deliverable |
|-----|------|--------|-------------|
| Mon | Start control-plane hardening | `feature/control-plane-hardening` | Rate limiting implementation |
| Tue | Quotas + circuit breakers | `feature/control-plane-hardening` | Per-tool quotas, circuit breakers |
| Wed | Capability manifest | `feature/capability-manifest` | `kindx://capabilities` MCP resource |
| Thu | Corrective RAG design doc | `feature/retrieval-feedback-loop` | Design document |
| Fri | Merge stabilization | N/A | All P0 branches green |

### Week 4: Merge Stabilization + Release Candidate

| Day | Task | Branch | Deliverable |
|-----|------|--------|-------------|
| Mon | Merge docs branches | `docs/product-strategy`, `docs/competitive-industry-analysis` | Docs on main |
| Tue | Merge session lifecycle | `feature/session-lifecycle` | Session lifecycle on main |
| Wed | Merge capability manifest | `feature/capability-manifest` | Capability manifest on main |
| Thu | Merge control-plane hardening | `feature/control-plane-hardening` | Control plane on main |
| Fri | Release candidate + public benchmark story | N/A | v1.4.0-rc.1 + benchmark blog post |

---

## 9. Merge Strategy

### Principles

| Principle | Rationale |
|-----------|----------|
| **Small PRs** | Each branch should be < 500 lines of diff. Large PRs are unreviewable. |
| **Merge docs first** | Zero risk, immediate value, sets the strategic context. |
| **Merge tests before refactors** | Tests protect against regressions. Add tests first, then change behavior. |
| **Don't mix architecture with product docs** | Separate concerns. Architecture changes need different review than docs. |
| **Feature flags for risky systems** | Named indexes, multimodal pipeline should be behind feature flags initially. |
| **Benchmark evidence for retrieval/performance changes** | Any change to retrieval pipeline or performance must show before/after benchmarks. |

### Merge Order

```
Week 1:
  docs/product-strategy ──────────────────────────────────────── merge
  docs/competitive-industry-analysis ──────────────────────────── merge
  feature/onboarding-golden-demo ──────────────────────────────── merge

Week 2:
  feature/session-lifecycle ───────────────────────────────────── merge

Week 3:
  feature/capability-manifest ─────────────────────────────────── merge
  feature/control-plane-hardening (depends on session-lifecycle) ─ merge

Week 4:
  feature/named-indexes (depends on session-lifecycle) ────────── merge (if ready)
  feature/retrieval-feedback-loop ─────────────────────────────── design only
  feature/benchmark-dashboard ─────────────────────────────────── merge

Future:
  feature/cold-start-ann (depends on named-indexes) ──────────── plan
  feature/index-versioning (depends on named-indexes) ─────────── plan
  feature/multimodal-pipeline (depends on cold-start) ─────────── plan
```

---

## 10. Definition of Done

A branch is "done" when ALL of the following are true:

| Criterion | Verification |
|-----------|-------------|
| **Tests pass** | `npm test` passes with 0 failures |
| **Build passes** | `npm run build` passes |
| **Type check passes** | `npx tsc --noEmit` passes |
| **Docs updated** | README, CHANGELOG, or relevant docs reflect changes |
| **Benchmarks recorded** | `npm run bench:quality` results within ±5% of baseline |
| **Security implications documented** | Any security-relevant changes are noted in PR description |
| **CLI behavior documented** | Any CLI changes are reflected in help text and README |
| **MCP behavior documented** | Any MCP changes are reflected in tool documentation |
| **Migration notes if needed** | Breaking changes have migration instructions |

---

## 11. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Over-scoping** | High | High | Strict P0/P1/P2 prioritization. Cut P2 if P0 slips. |
| **Performance regressions** | Medium | High | Benchmark gate on every retrieval/performance PR. |
| **Security regressions** | Low | Very High | Security implications documented on every PR. CodeQL + Trivy on CI. |
| **Poor onboarding** | High | High | `kindx init` wizard is P0. Golden demo is P0. |
| **Too many experimental features** | Medium | Medium | Feature flags for risky systems. Don't ship experiments as defaults. |
| **Lack of benchmark credibility** | Medium | Medium | Publish benchmark artifacts. Include reproduction instructions. |
| **Incompatible MCP changes** | Low | High | MCP protocol compliance tests. Test against reference implementation. |
| **Local model install failures** | Medium | High | Model compatibility validation. Clear error messages. Fallback to remote. |
| **SQLite concurrency limits** | Low | Medium | Document single-writer limitation. Optimize around it, don't replace. |
| **Scope creep from open issues** | High | Medium | Triage issues #12-#29. Close or defer low-priority items. |

---

## 12. Final Recommendation: Top 10 Actions in Order

| # | Action | Branch | Timeline | Impact |
|---|--------|--------|----------|--------|
| 1 | Commit strategy docs to `docs/strategy/` | `docs/product-strategy`, `docs/competitive-industry-analysis` | Day 1 | Sets strategic context for all work |
| 2 | Build `kindx init` wizard | `feature/onboarding-golden-demo` | Week 1 | Fixes #1 adoption blocker |
| 3 | Record golden demo video | `feature/onboarding-golden-demo` | Week 1 | Most effective marketing asset |
| 4 | Implement session lifecycle | `feature/session-lifecycle` | Week 2 | Foundation for all MCP work |
| 5 | Capture benchmark baseline | N/A | Week 2 | Required before any performance changes |
| 6 | Implement capability manifest | `feature/capability-manifest` | Week 3 | Agent discovery, low risk |
| 7 | Harden control plane | `feature/control-plane-hardening` | Week 3 | Production MCP readiness |
| 8 | Design named indexes | `feature/named-indexes` | Week 3-4 | Multi-agent foundation |
| 9 | Add retrieval quality CI gate | `feature/benchmark-dashboard` | Week 4 | Prevents quality regressions |
| 10 | Publish benchmark story | `feature/benchmark-dashboard` | Week 4 | Builds credibility and drives adoption |

---

## 13. Acceptance Criteria

- [x] Branch plan is actionable (12 branches with specific files, dependencies, acceptance criteria)
- [x] Workstreams can run in parallel (5 independent workstreams)
- [x] Merge order is clear (docs first, then session lifecycle, then features)
- [x] P0/P1/P2 are explicit (7 P0, 6 P1, 5 P2)
- [x] Weekly plan is realistic (4-week sprint)
- [x] Definition of done is specific (9 criteria)
- [x] Risk register has mitigations (10 risks)
- [x] Top 10 actions are prioritized

---

## Appendix: Evidence Sources

| Source | Path | Key Content |
|--------|------|-------------|
| Product Strategy | `docs/strategy/KINDX_PRODUCT_STRATEGY.md` | Product direction, personas, roadmap |
| Technical Gap Analysis | `docs/strategy/KINDX_TECHNICAL_GAP_ANALYSIS.md` | Architecture gaps, debt classification |
| Competitive Analysis | `docs/strategy/KINDX_COMPETITIVE_ANALYSIS.md` | Competitor matrix, differentiation |
| Industry Roadmap | `docs/strategy/KINDX_INDUSTRY_ROADMAP.md` | Industry trends, strategic bets |
| Strategic Refactor | `docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md` | W1-W4 workstreams |
| Issue Drafts | `.github/ISSUE_DRAFTS.md` | 10 drafted issues |
| Benchmarks | `BENCHMARKS.md` | 1091-line specification |
| CI | `.github/workflows/` | 19 workflows |
| Tests | `specs/` | 91 test files |
| Engine | `engine/` | 75 source files |
