# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.6](https://github.com/ambicuity/KINDX/compare/v1.3.5...v1.3.6) (2026-06-09)


### Features

* add capability manifest module with types and builder ([23e7a2e](https://github.com/ambicuity/KINDX/commit/23e7a2ea856723af3736d3ba6c6c989d71c4b5e8))
* add document versioning, history/diff commands, and enhanced audit queries ([2730ad0](https://github.com/ambicuity/KINDX/commit/2730ad0ee6cf5e65be746d23a87c3398644c39f3))
* **audit:** add structured audit logging for tool policy denials ([b176620](https://github.com/ambicuity/KINDX/commit/b1766206648e3f5820ad6dd9c485dda201ebb8fc))
* **catalogs:** add getConfigForIndex and listCollectionsForIndex helpers ([b76b583](https://github.com/ambicuity/KINDX/commit/b76b583afd6dad849b9942b41ae8669490b6eb28))
* **engine:** add /ready endpoint with health checks ([63b3745](https://github.com/ambicuity/KINDX/commit/63b37456d2b70f4139843af64a8000647ed2ad6d))
* **engine:** add DaemonManager for long-running process ([fc32aff](https://github.com/ambicuity/KINDX/commit/fc32aff4882846b97490158e287ab7729953a588))
* **engine:** add HealthChecker with liveness and readiness probes ([1de8298](https://github.com/ambicuity/KINDX/commit/1de8298cd443e99526033f73f0b5fe54e91633a9))
* **engine:** add HNSW index building for large corpora ANN ([e8c8070](https://github.com/ambicuity/KINDX/commit/e8c80700107c3762bcec0931e29c811e43bf95e7))
* **engine:** add model integrity verification with SHA-256 checksums ([dd4e0da](https://github.com/ambicuity/KINDX/commit/dd4e0da81da532e552a4b547ebc754a9637e76c3))
* **engine:** add PriorityQueue with priority-based shedding ([789762e](https://github.com/ambicuity/KINDX/commit/789762e00de74717fbf53293b5c8859e77639abd))
* **engine:** add RetryableLLM wrapper with exponential backoff ([91135ad](https://github.com/ambicuity/KINDX/commit/91135adb34db81324c1bf44031226e8cea381c9e))
* **engine:** re-export RetryableLLM and fix singleton test for retry wrapper ([e84ff61](https://github.com/ambicuity/KINDX/commit/e84ff6105e3d470cf2ae09dc1de19d93229486e6))
* **engine:** rewrite preloader as ModelPreloader class ([364fb99](https://github.com/ambicuity/KINDX/commit/364fb999298b2e013dc977c6266718b945f95622))
* **index:** add CLI index lifecycle commands (create, delete, list, migrate) ([95cf55b](https://github.com/ambicuity/KINDX/commit/95cf55bb3153bdbaedf15f6144dbc1d4820ff138))
* **index:** add createStoreForIndex and indexName to Store type ([1377e5a](https://github.com/ambicuity/KINDX/commit/1377e5aac9b333eda232b74932cf63cebf0a207d))
* **index:** add cross-index query federation with indexes parameter ([ce19823](https://github.com/ambicuity/KINDX/commit/ce19823762b895fa4d5b2adadaf3b8b0960ee8bb))
* **index:** add index-manager with registry CRUD and tests ([45b9f24](https://github.com/ambicuity/KINDX/commit/45b9f24e87cccce956803871a20fbd293c860e37))
* **index:** add MCP index lifecycle tools (list, create, delete, migrate) ([74feb1a](https://github.com/ambicuity/KINDX/commit/74feb1a61ac52944f3105122de74d087b6bfa6bf))
* **ingestion:** add CSV ingestion with schema-aware chunking ([e26ed6c](https://github.com/ambicuity/KINDX/commit/e26ed6ce814cb1ead37da6d1ca5715326f228a7d))
* **ingestion:** add image ingestion with vision model ([07c1e01](https://github.com/ambicuity/KINDX/commit/07c1e017adb4a9555a3b095150eaee277187de35))
* **ingestion:** add JSON ingestion with schema-aware chunking ([a11224d](https://github.com/ambicuity/KINDX/commit/a11224df81aca75734410ba262fa6258a298274a))
* **logging:** log config tier resolution for MCP servers ([e1042fb](https://github.com/ambicuity/KINDX/commit/e1042fbd5c0da427a52793940f6283beadc37107))
* **memory:** add cross-prefix semantic deduplication ([895ea8f](https://github.com/ambicuity/KINDX/commit/895ea8ff5e07b5dab79ffbf4770d270b0605bf7e))
* **memory:** add event-driven background lifecycle jobs ([0fd542f](https://github.com/ambicuity/KINDX/commit/0fd542fd38a70a008a430b9afc116dde369e7876))
* **memory:** add feedback schema, functions, and MCP tool ([bdaa6ee](https://github.com/ambicuity/KINDX/commit/bdaa6eea8f2d9aeea0bf8ff950a0a958b3c5b6d0))
* **memory:** add per-scope memory limits with LRU eviction ([78a97cf](https://github.com/ambicuity/KINDX/commit/78a97cf62ec4cfd1065aa74d4fc595bc47db5746))
* **memory:** integrate feedback-based ranking bias into search ([58736f3](https://github.com/ambicuity/KINDX/commit/58736f358832620848c4c2cffb03ecaa9460ced5))
* **memory:** refresh TTL on access, add ttl_seconds column ([c8033c0](https://github.com/ambicuity/KINDX/commit/c8033c04730f88161fdb323edd68cab18984ba05))
* **memory:** support multiple embedding models via KINDX_EMBED_MODEL env var ([99929b4](https://github.com/ambicuity/KINDX/commit/99929b4c613fd3092754874d2b02a60110f29cbe))
* **rbac:** add index-level scoping with allowedIndexes ([fee94a2](https://github.com/ambicuity/KINDX/commit/fee94a287b65fe31da7d88704e525b25a56be210))
* **retrieval:** add content type metadata to hybrid search results ([73ccf3b](https://github.com/ambicuity/KINDX/commit/73ccf3b1553c1080bb1bcc5de07f35cc7079b73d))
* **schema:** add schema storage for structured data ([7d93829](https://github.com/ambicuity/KINDX/commit/7d938292cb9cadee3c57a24822d59b0dba3b72ca))
* **security:** add circuit breaker to prevent cascade failures ([859585a](https://github.com/ambicuity/KINDX/commit/859585a8b907dfe2e0195ef77a60402631598f51))
* **security:** add configurable per-tool request quotas ([c6e98a9](https://github.com/ambicuity/KINDX/commit/c6e98a9101ae8ae7a55851f311a26fb20aa58690))
* **security:** add per-session rate limiter to control plane ([3f228d0](https://github.com/ambicuity/KINDX/commit/3f228d0291b88aaa00f9dcd9e43af728974f9037))
* **security:** integrate rate limiting, quotas, and circuit breakers ([826fe60](https://github.com/ambicuity/KINDX/commit/826fe600257cd398bf5f3e2789c68ce566c113cf))
* **session:** add idle reaper, max session limit, and LLM pool shutdown ([711d54d](https://github.com/ambicuity/KINDX/commit/711d54d08f78874625e6c871dd24d3d373360da0))
* sync local development work and prepare v1.3.6 release ([#168](https://github.com/ambicuity/KINDX/issues/168)) ([a69393b](https://github.com/ambicuity/KINDX/commit/a69393b257974070aae43ef31417a7971f8ecb02)), closes [#167](https://github.com/ambicuity/KINDX/issues/167)
* **vision:** add vision model integration for image understanding ([d8e98f8](https://github.com/ambicuity/KINDX/commit/d8e98f82de9a8f24f6d0b3923ac886db86a4f851))


### Bug Fixes

* add NaN validation for env var parseInt and expose control plane instances ([6fbcb40](https://github.com/ambicuity/KINDX/commit/6fbcb40bc098e94dc1c32a0f35db6eb9ba55fe5e))
* address type issue in protocol.ts for initialize request body id access ([26e3d17](https://github.com/ambicuity/KINDX/commit/26e3d179f9a434cd7dcb5b93ec48f1e1ec521b3d))
* deduplicate SERVER_VERSION constant between capability-manifest and protocol ([0969bd5](https://github.com/ambicuity/KINDX/commit/0969bd56029cd1edc17b4153b00f84adc73f5827))
* **engine:** call verifyModelIntegrity in resolveModel ([d648eb4](https://github.com/ambicuity/KINDX/commit/d648eb4abe4a125d246766a364a8590f8050fe16))
* **engine:** integrate HNSW index with shard database system ([5161288](https://github.com/ambicuity/KINDX/commit/5161288455b952548700dfb0b62f33dded7ab6dd))
* **engine:** integrate writeModelChecksum in pullModels ([5b7088c](https://github.com/ambicuity/KINDX/commit/5b7088cee33f58eefe130020b46078a53c02c46d))
* extract logConfigResolved helper and harden tier logging tests ([7ae19fc](https://github.com/ambicuity/KINDX/commit/7ae19fc56cacb7942d2f60a497a49409a66c5244))
* HNSW index quality fixes ([115794b](https://github.com/ambicuity/KINDX/commit/115794b0ddb78387e2ba7e75cbe2710e4a623875))
* **index:** add RBAC enforcement to MCP tools and federated query ([11d25a9](https://github.com/ambicuity/KINDX/commit/11d25a9cf5177e710a8023b12030e1b963782105))
* **index:** address code review issues — quietWarn on corrupt registry, YAML formatting, use registry.default ([d7665e0](https://github.com/ambicuity/KINDX/commit/d7665e093fb78f68f8fa43ff80de2a4209e01ea5))
* **memory:** call initializeMemoryFeedbackSchema at startup ([1b3311a](https://github.com/ambicuity/KINDX/commit/1b3311a363754b8f726220430a8859a194bb5b07))
* **memory:** call initializeMemoryScopeConfigSchema at startup ([5b2d43a](https://github.com/ambicuity/KINDX/commit/5b2d43a7fa10ab39368b9de6cfd923afab360c55))
* priority queue spec compliance ([7fffd60](https://github.com/ambicuity/KINDX/commit/7fffd60634ca7a63d5bfc2ad7b646a3b5dc4699b))
* **protocol:** replace /ready stubs with real state checks ([5354719](https://github.com/ambicuity/KINDX/commit/53547192f30d444852bd9b32148438913a19731a))
* **quota:** add pruneExpired to ToolQuotaManager to prevent unbounded memory growth ([53f4bf0](https://github.com/ambicuity/KINDX/commit/53f4bf03c3dc08f0f9ca3b5bb199626a2bec15c5))
* rename SessionRateLimiter to FixedWindowRateLimiter and add expiry pruning ([918b251](https://github.com/ambicuity/KINDX/commit/918b2514c21bd9e34a50feb84c4df767f74bbc79))
* **repo C10:** also import validateLexQuery and validateSemanticQuery ([c030e33](https://github.com/ambicuity/KINDX/commit/c030e330f4d82c46da40b59a68d81b2fb549ad88))
* RetryableLLM spec compliance — I/O patterns, modelExists retry, integration ([d425883](https://github.com/ambicuity/KINDX/commit/d425883ba943b7b32c4d1babb0c2735a59612c3e))
* **security:** P0 quick wins — timing-safe auth, loopback guard, prompt sanitization ([81d4eae](https://github.com/ambicuity/KINDX/commit/81d4eae05a31b6612467ecf12e3a7b898f28d778))
* **security:** prevent path traversal in MCP cache keys ([64d46c1](https://github.com/ambicuity/KINDX/commit/64d46c1f2d2162f0df679dee7d5fa31ed0960bd6))
* **security:** wire up audit logging and add init rate limiting ([5dad766](https://github.com/ambicuity/KINDX/commit/5dad7665dbfb9787aba1876ca861e5236f6862b3))
* **tests:** remove duplicates and use fake timers in hardening integration tests ([dd53e5a](https://github.com/ambicuity/KINDX/commit/dd53e5aaeb3f1ebe3255428a934bf3f0e223ccb5))
* vision model integration issues ([14a76ba](https://github.com/ambicuity/KINDX/commit/14a76ba32994e1b793e6be3b6f8d5e9d77f9d609))
* wire up modelsReady from buildOperationalStatus instead of hardcoding false ([17be2e3](https://github.com/ambicuity/KINDX/commit/17be2e35adf2dcd9344f054aa0425c674f2a9548))

## [1.3.6] - 2026-06-09

### Added

- **MCP auto-invocation contract**: every MCP-aware agent now receives a "WHEN TO CALL KINDX" prescription at the top of `initialize.instructions`, with a 6-row decision table that tells the agent to call `query` automatically before answering any user turn that could be informed by their local notes. Default on; set `KINDX_AUTO_INVOKE=off` in the server's environment to disable.
- New `kindx mcp --health-check` flag that exits `0` with a `{ok, totalDocuments, collections}` JSON line when the store opens cleanly, `1` with an error payload otherwise. Useful for installer probes and CI.
- New `kindx init --client <auto|all|name>` subcommand that wires kindx into every supported MCP client (Claude Code, Claude Desktop, Cursor, Continue, OpenCode, Codex CLI, Copilot CLI, Zed) and drops a fenced auto-invocation block into project `AGENTS.md`/`CLAUDE.md`/`.cursorrules`. Supports `--dry-run`, `--force`, `--global`, `--project`. Idempotent across re-runs; backs up existing configs to `<path>.kindx.bak.<timestamp>` before overwriting. Ollama support is via a community bridge — see `capabilities/kindx/references/ollama-bridge.md`.
- New `kindx status --auto-invoke-rate` flag that summarises the local `mcp_query_log` table. Reports `agent-auto` / `user-explicit` / `unknown` trigger counts (clients pass attribution via `_meta.kindx.trigger`).
- `kindx://capabilities` resource gains an `autoInvocation: { contractEmitted, lastTurnTrigger? }` block so MCP clients can observe whether the contract is currently active.

### Changed

- **Default `query.limit` is now `3` (was `10`).** Tight triage by default: agents read top-3 snippets and use `get` to expand any that look promising, rather than pulling full bodies up front. Applies to both the MCP `query` tool and the HTTP `/query` and `/query/stream` endpoints. Set `limit` explicitly to opt back into wider result sets.
- `query.maxSnippetLines` now defaults to `4`; previously it had no default.
- MCP tool descriptions (`query`, `get`, `multi_get`, `status`, `memory_search`, `memory_put`) now lead with a WHEN-TO-USE sentence; the diagnostic memory tools (`memory_history`, `memory_stats`, `memory_mark_accessed`, `memory_delete`, `memory_bulk`, `memory_feedback`) are explicitly marked `Diagnostic — only call when the user asks about memory itself`.
- `initialize.instructions` content has been reshaped: the auto-invocation contract leads, then layered AGENTS.md, then the collections list, then condensed search/retrieval reference. Output is hard-capped at 8 KB with a `[instructions truncated — see kindx://capabilities]` marker.
- Relocated Arch sidecar integration from `engine/integrations/arch/` to `experiments/arch/`. Removed `KINDX_ARCH_*` environment variables, the `arch` CLI subcommand, the `arch_query` and `arch_status` MCP tools, and the `arch:status` / `arch:refresh` npm scripts. The code remains in the tree under `experiments/` and may be revived if adoption data appears.

## [1.3.5] - 2026-05-09

See full changelog at https://github.com/ambicuity/KINDX/compare/v1.3.4...v1.3.5

## [1.3.5](https://github.com/ambicuity/KINDX/compare/v1.3.4...v1.3.5) (2026-05-09)


### Features

* integrate KINDX reliability and release surface updates ([23ae8fb](https://github.com/ambicuity/KINDX/commit/23ae8fbf5f5cb7bb7e016d09e6f8c9286ea68055))


### Bug Fixes

* **engine:** PR2 part A+B — concurrency leaks + network hardening ([63c788b](https://github.com/ambicuity/KINDX/commit/63c788b24eb9cdc6386e9f28bdb3062bcb219a52))
* **engine:** PR2 part C — correctness fixes ([3c02cf5](https://github.com/ambicuity/KINDX/commit/3c02cf57b778071bcf8ab27151c9bff7ec58379c))
* **engine:** PR2 part D — performance cliffs ([d7802d2](https://github.com/ambicuity/KINDX/commit/d7802d222eeb5aebe7fbc32e2d8354af6a20d4cb))
* **engine:** PR2 part E — security extras ([ac95bc5](https://github.com/ambicuity/KINDX/commit/ac95bc51627a568470d4a62c35c71351e9fcfd9d))
* **engine:** PR3 — Tier-2 cleanup, process hygiene, cross-cutting ([224f72c](https://github.com/ambicuity/KINDX/commit/224f72ceff35be722d8f674501b559b5c2ae9343))
* **engine:** Tier-0 stop-the-line fixes (1/3) — vector wipe, schema drops, openclaw RCE ([7140036](https://github.com/ambicuity/KINDX/commit/71400365072881f6119df014eca44600ba7673ea))
* **engine:** Tier-0 stop-the-line fixes (2/3) — encryption backup leak, RBAC token weakness ([db3efa4](https://github.com/ambicuity/KINDX/commit/db3efa449327f1543f0c88114b076f72ea0b26a4))
* **engine:** Tier-0 stop-the-line fixes (3/3) — sharding, HTTP, remote-llm, repository, migrate ([3dd5b7b](https://github.com/ambicuity/KINDX/commit/3dd5b7b2661bacd2bc81b9db96ec171a327de844))
* **engine:** tier-1 concurrency / network / correctness / perf / security fixes ([8a663c1](https://github.com/ambicuity/KINDX/commit/8a663c1a7f2f47af64e4efd70e5e0f3537a7be0b))
* **engine:** tier-2 cleanup and cross-cutting hygiene ([bb28561](https://github.com/ambicuity/KINDX/commit/bb28561263fcf63d290aa385d52b7c6aaec8de00))

## [1.3.4] - 2026-04-21

### Added

- Added OpenClaw integration CI workflow coverage for release validation paths.
- Added memory lifecycle and retrieval utility enhancements including new audit/chunker/link extraction capabilities.

### Changed

- Promoted expert-improvements engine/spec/doc updates into the release branch payload.
- Synchronized release metadata to `1.3.4` across package, lockfile, release manifest, MCP `serverInfo.version`, and marketplace metadata.

## [1.3.3] - 2026-04-21

### Added

- Added memory TTL support and `memory_delete` MCP tool for lifecycle-safe memory management.
- Added query trace spans and adaptive query classification metadata in structured query paths.

### Changed

- Added query context compression support via max snippet line limits in MCP query responses.
- Synchronized release metadata to `1.3.3` across package, lockfile, release manifest, MCP `serverInfo.version`, and marketplace metadata.

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
- Fixed release-gate TypeScript checks by excluding generated `specs/test-src` snapshots from `tsc --noEmit` while keeping them available as PR evidence artifacts.

### Verification

- `npm run build` passed.
- `npm test` passed (35 files, 829 tests).
- `npm run test:packages` passed.
- `npm run test:python` passed.
- `npm run qa:customer-pov:all` passed (`required_failures=0`, `required_passes=5`, `skipped=1` optional container smoke).
- `npx tsc --noEmit` passed.
- Temp-prefix packaged installability passed (`npm pack`, `npm install -g --prefix /tmp/kindx-global`, `kindx --version`, `kindx --help`).
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
