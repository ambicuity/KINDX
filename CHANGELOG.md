# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2](https://github.com/ambicuity/KINDX/compare/v1.3.1...v1.3.2) (2026-04-11)

### Added

- Customer POV launch-readiness runbook: `reference/runbooks/customer-pov-launch-readiness.md`.
- Customer POV evidence template: `reference/runbooks/customer-pov-evidence-template.md`.
- Phase-based release gate helper: `tooling/customer_pov_launch_gate.ts`.
- QA scripts for phased launch checks: `qa:customer-pov`, `qa:customer-pov:p0`, `qa:customer-pov:p1`, `qa:customer-pov:p2`, `qa:customer-pov:p3`, `qa:customer-pov:all`.

### Changed

- Release documentation now points operators directly to the customer POV runbook and evidence template.
- Release metadata is synchronized to `1.3.2` across `package.json`, `package-lock.json`, `.release-please-manifest.json`, MCP `serverInfo.version`, and marketplace metadata.

### Fixed

- Fixed tenant role parsing so `kindx tenant add --role <admin|editor|viewer>` is parsed and validated correctly.
- Fixed RBAC collection-isolation on HTTP `/query` and `/search` to prevent unauthorized collection leakage.
- Hardened MCP `tools/call` query RBAC scoping so allowed collections are enforced even when `collections` is omitted.

### Verification

- `npm run build` passed.
- `npm test` passed (35 files, 829 tests).
- `npm run test:packages` passed.
- `npm run test:python` passed.
- `npm run qa:customer-pov:all` passed (`required_failures=0`, `required_passes=5`, `skipped=1` optional container smoke).
- Added targeted regression coverage for tenant role parsing (`specs/ops-cli.test.ts`) and RBAC collection isolation in HTTP/MCP query paths (`specs/mcp.test.ts`).

## [1.3.1](https://github.com/ambicuity/KINDX/compare/v1.3.0...v1.3.1) (2026-04-08)

### Fixed

- Regenerated lockfile for cross-platform CI compatibility.
- Ensured `kindx arch` command group is fully documented in `kindx --help` output with detailed subcommands, options, environment variables, and architecture diagrams.
- Aligned `arch:status` and `arch:refresh` npm helper scripts for dev workflow consistency.

### Changed

- Dependency alignment with published v1.3.0 baseline: chokidar ^5.0.0, sqlite-vec 0.1.9, vitest ^4.1.2, typescript ^6.0.2.
- Added workspace-aware `arch:status` and `arch:refresh` npm helper scripts.

## [1.3.0](https://github.com/ambicuity/KINDX/compare/v1.0.1...v1.3.0) (2026-04-08)

### Added

- Release-readiness hardening report: `reference/audits/release-readiness-hardening-2026-04-02.md`
- Release benchmark helper: `tooling/benchmark_release_hardening.ts` (embed throughput + query TTFR)
- Structured-search routing profiles (`fast`, `balanced`, `max_precision`) for MCP/HTTP query paths.
- Query replay artifact writer (`KINDX_QUERY_REPLAY_DIR`) for deterministic search trace capture.
- Draft shared orchestration spec: `reference/architecture/subagent-orchestration-contract-v0.md`.
- MCP control-plane module: `engine/mcp-control-plane.ts` (policy resolution, trusted-project gating, provenance, in-memory+disk tool-list cache).
- Shared subagent contract schemas/utilities: `engine/subagent-contract.ts`.
- Layered instruction discovery with precedence/truncation/provenance utilities: `engine/instruction-layering.ts`.
- Test coverage for MCP control-plane and subagent contract behavior (`specs/mcp-control-plane.test.ts`, `specs/subagent-contract.test.ts`).
- Arch integration subsystem under `engine/integrations/arch` (`adapter`, `runner`, `parser`, `distill`, `importer`, `augment`, `config`, `contracts`).
- Arch CLI command group: `kindx arch status|build|import|refresh`.
- Optional Arch query/update flags: `--arch-hints`, `--arch-refresh`, `--arch-root`.
- Optional MCP Arch tools: `arch_status`, `arch_query`.
- npm helper scripts for Arch workflows: `arch:status`, `arch:refresh`.
- Arch integration documentation updates in `README.md` and `reference/SYNTAX.md` (setup, env vars, command usage).

### Changed

- MCP session lifecycle cleanup is now explicitly guarded and logged on transport close.
- MCP initialize memory prefetch remains best-effort and is now bounded by entry count and text budget.
- Structured vector fan-out now merges in deterministic order after concurrent retrieval.
- Fuzzy file matching now uses bounded-distance early exit to reduce worst-case lookup cost.
- Structured search now surfaces degraded-mode diagnostics and fallback reasons (embed/rerank/vector fallback paths).
- MCP/REST query responses now include richer metadata (`degraded_mode`, `fallback_reason(s)`, `routing_profile`, `scope`, dedupe join signal, replay artifact path).
- HTTP MCP startup now emits machine-readable startup lifecycle events (`mcp_startup_update`, `mcp_startup_complete`, `mcp_startup_failure`) to server logs.
- HTTP MCP now enforces per-tool allow/deny policy, supports policy-based tool-call timeout, and injects tool provenance metadata in tool-call responses.
- HTTP MCP `tools/list` responses now apply policy filtering and use account/workspace/project-aware cache keys with disk-backed TTL cache.
- Replay artifacts now use deterministic `${timestamp}_${requestId}.json` naming and include normalized input + routing/score traces.
- MCP initialize instructions now include layered instruction-source provenance (global + project chain) when instruction files are present.
- OpenClaw KINDX bridge config extends mcporter controls (`enabledTools`, `disabledTools`, startup/tool timeouts, header/env-header/bearer mapping, projectScoped) and enforces tool allow/deny on bridge calls.
- Arch integration is optional, feature-flagged, and additive; default retrieval behavior is unchanged when disabled.
- Query flow supports post-retrieval Arch hint augmentation only when Arch integration is enabled.
- Update flow can optionally trigger Arch refresh after collection update (`--arch-refresh` or config-driven auto-refresh).
- CLI help now includes expanded Arch command guidance in both `kindx --help` and `kindx arch help` (usage, options, env vars, and related flags).

### Testing

- Expanded MCP HTTP coverage for repeated session calls, forced session close, stale-session rejection, and bounded memory-prefetch instructions.
- Added regression coverage for deterministic fan-out ordering and bounded fuzzy matching behavior.
- Added structured-search diagnostics coverage for routing profile behavior.
- Added unit coverage for control-plane policy precedence, provenance naming, and tool-list cache behavior.
- Added unit coverage for subagent inheritance/clamp contract behavior.
- Added unit coverage for layered instruction precedence and truncation behavior.
- Added Arch integration coverage (`specs/arch-cli.test.ts`, `specs/arch-adapter.test.ts`, `specs/arch-importer.test.ts`, `specs/arch-augmentation.test.ts`).
- Full validation run completed via `npm test`: 28 files, 743 tests, 0 failures.
- Observed expected non-failing warning classes during tests: local CPU fallback initialization warnings and intentional regression-path vector-dimension mismatch warnings.

## [1.0.1](https://github.com/ambicuity/KINDX/compare/v1.0.0...v1.0.1) (2026-03-12)


### Bug Fixes

* resolve npm install -g EACCES guidance and TS import regression (closes [#35](https://github.com/ambicuity/KINDX/issues/35)) ([#36](https://github.com/ambicuity/KINDX/issues/36)) ([006f5e1](https://github.com/ambicuity/KINDX/commit/006f5e1d16e7ecde14aab2329dd5aca6730a3135))

## 1.0.0 (2026-03-08)


### Features

* initial commit of KINDX repository ([8072470](https://github.com/ambicuity/KINDX/commit/8072470567b229f2fec58966c7a7ecff4c7b234d))


### Bug Fixes

* resolve TypeScript strict errors, update gh-action versions, configure GH packages registry ([f19c8d9](https://github.com/ambicuity/KINDX/commit/f19c8d9dc7e9b7c2090ae368dbcaebeadaae17e8))

## [0.1.0] - 2026-03-07

### Added

- Initial release of KINDX - On-Device Document Intelligence Engine
- BM25 full-text search via SQLite FTS5
- Vector semantic search via sqlite-vec with embeddinggemma-300M
- Hybrid search with Reciprocal Rank Fusion (RRF)
- LLM re-ranking via qwen3-reranker-0.6B
- Query expansion via fine-tuned model
- Smart document chunking with natural break point detection
- Collection management (add, remove, rename, list)
- Context management for collections and paths
- MCP (Model Context Protocol) server with stdio and HTTP transport
- Multi-get command for batch document retrieval
- Output formats: plain text, JSON, CSV, XML, Markdown
- Support for custom embedding models via KINDX_EMBED_MODEL
- Configurable reranker context size
- Position-aware score blending
- Code fence protection in chunking
- Document identification via 6-character hash (docid)
- Fuzzy path matching with suggestions
- LLM response caching
- Named indexes
- Schema migration support
- Comprehensive test suite (vitest)
- CI/CD via GitHub Actions
- CodeQL and Trivy security scanning
- Signed releases via Sigstore
