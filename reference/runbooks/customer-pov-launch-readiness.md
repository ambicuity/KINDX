# KINDX Customer POV End-to-End Test Strategy (Launch Readiness)

Status: Ready for execution  
Audience: QA leads, product reviewers, SRE, release managers, security/compliance stakeholders  
Primary goal: Prove customer-visible value and reliability from first install through sustained shared operation

## 1) Summary

This runbook operationalizes customer-outcome testing across 10 user outcomes with four staged gates:

- `P0` Smoke Gates: fastest launch blockers
- `P1` Outcome E2E Certification: full customer journey matrix
- `P2` Resilience + Upgrade Hardening: failure handling and compatibility
- `P3` Scale + Reliability Lock: sustained load and regression freeze

Guiding principle:
- Prioritize customer-visible behavior first
- Then confirm diagnostics and observability
- Then verify internal implementation signals

## 2) Default Test Matrix

Use this matrix for launch readiness unless a narrower release scope is explicitly approved.

| Axis | Required Coverage |
|---|---|
| OS | macOS (Apple Silicon + Intel), Ubuntu 22.04/24.04, Windows 11 + WSL2 |
| Runtime | Node 20 LTS + latest supported Node, Bun latest supported |
| Hardware | `H1` high-end GPU, `H2` low VRAM (<=4GB), `H3` CPU-only |
| Network | `N1` internet, `N2` offline post-model-seed, `N3` outbound blocked except localhost |
| User profile | `U1` new solo user, `U2` AI engineer integrator, `U3` shared-team operator |
| Corpus profile | `C1` clean small corpus, `C2` mixed enterprise corpus, `C3` noisy/broken corpus |

## 3) Outcome-by-Outcome E2E Catalog

For every outcome below, capture evidence in `reference/runbooks/customer-pov-evidence-template.md`.

### Outcome 1: New user can install KINDX successfully

- User story: As a new user, I can install KINDX and run `kindx --version` and `kindx status` without confusion.
- End-to-end scenarios:
  - npm global install
  - bun global install
  - npx/bunx no-install invocation
  - EACCES troubleshooting flow
- Environment assumptions:
  - Clean shell profile and user-level permissions
  - No pre-existing global `kindx` binary
- Workflow steps:
  1. Install KINDX with npm or bun.
  2. Validate `kindx --version`, `kindx --help`, and `kindx status`.
  3. Trigger one known install failure path and validate remediation.
- Expected user-visible results:
  - Successful install path is obvious.
  - Error paths provide actionable next commands.
- Failure modes:
  - `EACCES`, PATH mismatch, unsupported Node, sqlite runtime issues.
- Negative tests:
  - Node <20, non-writable npm prefix, missing sqlite runtime.
- Observability checks:
  - install logs captured with categorized failure reasons.
- Acceptance criteria:
  - >=95% clean install success across supported environments.
  - Common failures resolved in <=2 guided steps.

### Outcome 2: New user can add collections and understand next steps

- User story: As a first-time user, I can add a collection and know what to run next.
- End-to-end scenarios:
  - collection add/list/show/remove
  - duplicate and invalid path handling
  - include/exclude behavior
- Environment assumptions:
  - corpus folder exists with markdown files
- Workflow steps:
  1. Run `kindx collection add`.
  2. Validate `collection list` and `collection show`.
  3. Follow guidance to `update` and `embed`.
- Expected user-visible results:
  - collection metadata is clear and next action is explicit.
- Failure modes:
  - invalid paths, unreadable directories, empty corpus, glob mismatch.
- Negative tests:
  - missing path, unreadable folder, conflicting names.
- Observability checks:
  - config YAML updates correctly and status reflects embedding requirements.
- Acceptance criteria:
  - First-time user reaches indexed corpus in <10 minutes without support.

### Outcome 3: User can build embeddings and get useful search results

- User story: As a user, I can run embed and get useful results for realistic queries.
- End-to-end scenarios:
  - incremental embed
  - force re-embed
  - CPU fallback
  - multilingual embedding override
- Environment assumptions:
  - models available or downloadable
  - indexed corpus with known-answer queries
- Workflow steps:
  1. `kindx update`
  2. `kindx embed`
  3. `kindx search`, `kindx vsearch`, `kindx query`
- Expected user-visible results:
  - progress output is clear and results are relevant.
- Failure modes:
  - model download failures, GGUF init failures, low VRAM instability.
- Negative tests:
  - blocked model download, corrupted model cache, low-memory host.
- Observability checks:
  - fallback/degraded indicators, query latency, rerank timeout metrics.
- Acceptance criteria:
  - target docs appear in top-3 for >=85% benchmark set.

### Outcome 4: User can retrieve the right documents reliably

- User story: As a user, `get` and `multi-get` return the correct content consistently.
- End-to-end scenarios:
  - exact path retrieval
  - docid retrieval
  - line-offset retrieval
  - glob/list multi-get
- Environment assumptions:
  - indexed documents with deterministic expected snippets
- Workflow steps:
  1. execute `get` by path and docid.
  2. execute `multi-get` with glob/list/docids.
  3. validate line and byte constraints.
- Expected user-visible results:
  - retrieved content matches expected identity and snippets.
- Failure modes:
  - fuzzy collisions, missing docid, oversized-file confusion.
- Negative tests:
  - typo paths with near-collision, removed docs, binary/unreadable files.
- Observability checks:
  - skipped-file reasons, retrieval traces, metadata consistency.
- Acceptance criteria:
  - exact retrieval success 100%; ambiguous cases provide clear guidance.

### Outcome 5: AI engineer can integrate KINDX through CLI or MCP

- User story: As an AI engineer, I can integrate KINDX in agent workflows with stable contracts.
- End-to-end scenarios:
  - CLI JSON/files mode integration
  - MCP stdio tool calls
  - MCP HTTP tool calls with auth
- Environment assumptions:
  - one reference agent runtime configured per template
- Workflow steps:
  1. run CLI structured outputs and parse in script.
  2. run stdio MCP tools.
  3. run HTTP MCP tools with bearer auth.
- Expected user-visible results:
  - stable payload shape, predictable error contracts.
- Failure modes:
  - stale sessions, malformed payloads, auth failures.
- Negative tests:
  - unauthorized calls, invalid payload fields, stale session retries.
- Observability checks:
  - `/health`, `/metrics`, request/error/degraded counters.
- Acceptance criteria:
  - template integrations run core toolchain without manual patching.

### Outcome 6: Team can run safely in shared environments with RBAC

- User story: As an admin, I can issue scoped tokens and enforce least-privilege access.
- End-to-end scenarios:
  - tenant add/list/rotate/disable/enable
  - role matrix validation
  - collection scope enforcement
- Environment assumptions:
  - HTTP daemon mode enabled
- Workflow steps:
  1. create admin/editor/viewer tenants.
  2. execute allowed/disallowed operations by token.
  3. rotate/disable tokens and verify old token rejection.
- Expected user-visible results:
  - denies are explicit; allowed operations succeed.
- Failure modes:
  - stale-token acceptance, collection scope leakage.
- Negative tests:
  - cross-collection query attempts, viewer write attempts, unknown token.
- Observability checks:
  - auth/deny logs, RBAC status snapshots, metrics of denied requests.
- Acceptance criteria:
  - zero RBAC bypass in adversarial tests.

### Outcome 7: Operator can detect, diagnose, and recover from failures

- User story: As an operator, I can diagnose and recover quickly using documented workflows.
- End-to-end scenarios:
  - `status`
  - `doctor`
  - `repair --check-only`
  - backup create/verify/restore
  - cleanup
- Environment assumptions:
  - ability to induce representative failures in non-production env
- Workflow steps:
  1. induce failure (db/cache/queue pressure).
  2. diagnose with status/doctor/repair.
  3. execute restore/recovery flow and validate.
- Expected user-visible results:
  - diagnosis includes clear next actions and final recovery confirmation.
- Failure modes:
  - unclear remediation, partial restore, hidden degraded mode.
- Negative tests:
  - wrong backup file, corrupt backup verify, recovery during active write pressure.
- Observability checks:
  - health, queue and degraded metrics pre/post recovery.
- Acceptance criteria:
  - MTTR <30 min for top 5 failure classes.

### Outcome 8: Privacy-sensitive user can trust documents stay local

- User story: As a privacy-sensitive user, I can verify that documents stay local in local mode.
- End-to-end scenarios:
  - local backend with outbound blocked
  - pre-seeded models offline operation
  - token/key file handling checks
- Environment assumptions:
  - network tracing available on host
- Workflow steps:
  1. pre-seed models.
  2. run update/embed/query/get in blocked outbound mode.
  3. inspect network traces and logs.
- Expected user-visible results:
  - workflow succeeds without external document traffic.
- Failure modes:
  - unexpected outbound requests, unclear model-fetch behavior.
- Negative tests:
  - force offline before model cache, accidental remote backend config.
- Observability checks:
  - network trace artifact, effective mode/env evidence, token file checks.
- Acceptance criteria:
  - zero outbound document payload in local mode; reproducible privacy validation.

### Outcome 9: Customer can handle extractor/model/environment issues without getting stuck

- User story: As a customer, I can recover from extractor/model/runtime problems with provided guidance.
- End-to-end scenarios:
  - extractor disabled/misconfigured
  - malformed PDF/DOCX
  - model init failure
  - WSL2 CUDA mismatch
- Environment assumptions:
  - troubleshooting docs are available locally
- Workflow steps:
  1. trigger each issue class.
  2. follow documented command/env remediation.
  3. confirm operation restored.
- Expected user-visible results:
  - error messages contain exact and actionable recovery commands.
- Failure modes:
  - cryptic low-level errors, docs mismatch with real CLI behavior.
- Negative tests:
  - strict extractor mode on unsupported assets, broken cache, missing dependencies.
- Observability checks:
  - warning consistency, remediation success telemetry, docs parity checks.
- Acceptance criteria:
  - >90% issue scenarios recoverable using docs + CLI output only.

### Outcome 10: System feels reliable and valuable under realistic usage

- User story: As an everyday user/team, KINDX remains stable and useful under normal concurrency and corpus churn.
- End-to-end scenarios:
  - daily lifecycle (`watch` + `update` + `embed` + `query`)
  - daemon restarts
  - concurrent agent traffic
- Environment assumptions:
  - representative query set and evolving corpus
- Workflow steps:
  1. run sustained workload (minimum 24h gate, ideal 7-day pre-GA).
  2. track relevance, latency, degradation trends.
  3. validate operational overhead and restart behavior.
- Expected user-visible results:
  - stable performance and relevance with low babysitting burden.
- Failure modes:
  - queue saturation drift, stale index behavior, rising degraded mode.
- Negative tests:
  - burst traffic beyond rerank budget, repeated restarts, high file churn.
- Observability checks:
  - p95 latency, degraded rates, timeout/saturation counters, error trend.
- Acceptance criteria:
  - SLO thresholds met, relevance baseline sustained, no critical data integrity issues.

## 4) Cross-Cutting Suites

### Critical Cross-Platform

- Install + smoke on all target OS/runtime combinations.
- GPU/CPU fallback validation per platform.
- Filesystem edge cases: spaces, unicode paths, long paths, case behavior.

### First-Run Experience

- Time-to-first-value (install -> first useful query).
- Error quality audit for top 15 first-run failures.
- Next-step clarity after `collection add`, `status`, and failed `embed`.

### Documentation-Based Validation

- Execute README quick start verbatim on clean hosts.
- Execute troubleshooting commands exactly as documented.
- Validate templates in `reference/integrations/agent-templates.md`.

### Resilience

- Fault injection: db/cache/model/token/queue pressure.
- Scheduled backup verify and restore drill cadence.
- Daemon soak tests with periodic index updates.

### Upgrade/Migration

- Upgrade previous stable -> current with existing config/index.
- Verify schema and output contract compatibility.
- Validate Chroma/OpenCLAW migration and post-migration retrieval quality.

### Regression (CLI/HTTP/MCP)

- CLI output contracts: stdout/stderr/exit code snapshots.
- HTTP contracts: auth, route behavior, validation, degraded mode metadata.
- MCP contracts: session lifecycle, tool response/error consistency.

## 5) Top 10 Customer-Facing Risks

1. First-run model/runtime failures cause abandonment.
2. Install friction (`EACCES`, PATH, runtime mismatch).
3. MCP HTTP setup/auth confusion for shared deployments.
4. Retrieval quality inconsistency on noisy or multilingual corpora.
5. RBAC misconfiguration causing scope leakage.
6. Privacy claims without reproducible proof artifacts.
7. Extractor failures with unclear remediation.
8. Documentation drift from actual CLI behavior.
9. Under-load degraded mode not clearly communicated.
10. Backup/restore readiness not validated by drills.

## 6) Top 10 Launch-Blocking Tests

1. Clean install across target OS/runtime matrix.
2. README quick start from zero state.
3. Embed/query success on low-VRAM and CPU-only profiles.
4. Retrieval accuracy benchmark on known-answer corpus.
5. MCP stdio + HTTP integration with at least two real clients.
6. RBAC adversarial suite (zero bypass).
7. Offline/local privacy validation with network tracing.
8. Backup create/verify/restore incident drill.
9. Extractor/model/environment fault recovery tests.
10. 24h concurrency soak without critical integrity failures.

## 7) Current Evidence Gaps to Close

- Cross-platform install proof is incomplete for customer-grade evidence.
- Real MCP client interoperability evidence is still partial.
- Privacy claim lacks a standardized network-proof artifact.
- First-run troubleshooting quality is not benchmarked against novice users.
- Upgrade/migration evidence needs explicit versioned validation runs.
- Continuous docs-verbatim execution is not yet automated.

## 8) Prioritized Execution Plan

### Phase `P0` (Day 1-2): Launch Smoke

- Run launch-blocking tests on one primary platform triad.
- Immediate stop-ship triggers:
  - install failure without remediation
  - retrieval correctness regression
  - RBAC bypass
  - backup/restore recovery failure

### Phase `P1` (Day 3-5): Outcome E2E Certification

- Execute all 10 outcomes across required matrix slices.
- Capture full evidence package per outcome with pass/fail and artifacts.

### Phase `P2` (Week 2): Resilience + Upgrade Hardening

- Run failure injection and recovery drills.
- Execute upgrade and migration validation from previous stable release.

### Phase `P3` (Release Candidate): Regression Lock

- Freeze CLI/HTTP/MCP contract snapshots.
- Run nightly docs-verbatim + regression suite until release cut.

## 9) Readiness Decision Rule

- Ship recommendation: conditional go.
- Required condition: all launch-blocking tests pass with reproducible artifacts.
- Block rule: any launch-blocking test failure prevents promotion until fixed and re-validated.

## 10) Public Interfaces and Contracts Covered

- CLI install/runtime contracts (`kindx --version`, `kindx status`, command exits/output).
- CLI retrieval contracts (`search`, `vsearch`, `query`, `get`, `multi-get`) in plain and structured output modes.
- MCP tool contracts (`query`, `get`, `multi_get`, `status`, memory tools; optional arch tools).
- HTTP contracts (`/mcp`, `/query`, `/search`, `/health`, `/metrics`) including auth behavior.
- RBAC contracts (tenant/token lifecycle and role/collection enforcement).

## 11) Automation Entry Points

- `npm run qa:customer-pov:p0`
- `npm run qa:customer-pov:p1`
- `npm run qa:customer-pov:p2`
- `npm run qa:customer-pov:p3`
- `npm run qa:customer-pov:all`

These wrappers call `tooling/customer_pov_launch_gate.ts` and emit a JSON report for traceability.
