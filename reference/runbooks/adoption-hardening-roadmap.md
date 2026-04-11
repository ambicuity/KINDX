# KINDX Adoption Hardening Roadmap

Status: Draft for execution  
Scope target: Current local workspace snapshot on `feature/enterprise-hardening`  
Audience: Engineering leads, SRE, product, security/compliance reviewers  
Objective: Enterprise pilot readiness (not broad enterprise GA)

## 1. Summary

This roadmap translates the completed due-diligence assessment into an executable program with:

- Three delivery horizons: Immediate (0-30 days), Near-term (30-90 days), Scale (90+ days)
- Decision-complete workstreams with owners, dependencies, acceptance criteria, rollback paths, and metrics
- Readiness gates aligned to four assessment dimensions:
  - Technical
  - Product Usability
  - Enterprise
  - Scale
- Traceability from each roadmap item to concrete code/doc evidence anchors

No runtime API/type changes are required in this planning phase.

## 2. Governance and Ownership Model

Program owner:
- Staff Engineer (Search Platform) as DRI for roadmap execution and sequencing

Workstream owners:
- A: Reliability and Operability -> Principal Engineer (Core Runtime)
- B: Enterprise Controls -> Security Architect + Platform Lead (joint)
- C: Scale Readiness -> SRE Lead + Performance Engineer (joint)

Review cadence:
- Weekly execution review (workstream owners + DRI)
- Bi-weekly readiness gate review (eng lead, SRE, PM, security)
- Monthly enterprise pilot checkpoint (leadership sign-off)

Decision policy:
- Any item with `Critical` priority can block pilot readiness
- Any gate with `Fail` status blocks promotion to the next horizon

## 3. Horizon Plan and Decision-Complete Backlog

Legend:
- Priority: Critical / High / Medium / Low
- Rollout risk: Low / Medium / High

### Horizon 1: Immediate (0-30 days)

| ID | Workstream | Priority | Owner Role | Dependencies | Implementation Scope | Acceptance Criteria | Rollout Risk | Rollback Path | Success Metric |
|---|---|---|---|---|---|---|---|---|---|
| A1 | A | Critical | Principal Engineer (Core Runtime) | None | Modularize CLI command handlers out of `engine/kindx.ts` into command-domain modules; preserve command behavior and flags | `kindx` command parity tests pass; no command-line regressions in existing specs | Medium | Revert modularization commits and restore previous routing map | `0` CLI contract regressions across command-line and command-handler tests |
| A2 | A | High | Principal Engineer (Core Runtime) | A1 | Add explicit degraded-mode surfacing for non-JSON CLI output (timeout/saturation/fallback reason summary) | Degraded modes visible in CLI for rerank timeout/saturation/ANN fallback paths | Low | Feature flag or revert formatter/output patch | 100% of degraded paths display machine and human-readable indicators |
| A3 | A | High | SRE Engineer | None | Extend diagnostics (`doctor`) with extractor dependency checks (`pdftotext`, `unzip`, fallback policy visibility) | `kindx doctor` reports extractor capability state and remediation hints | Low | Revert diagnostic additions | >=90% of extractor misconfig issues detected pre-index |
| A4 | A | High | SRE Lead | A2 | Define and publish baseline SLO draft for query latency, degraded mode rate, rerank timeout, queue saturation | SLO document ratified and linked to `/metrics` fields and benchmark tooling | Medium | Keep SLO as non-blocking informational policy | Initial SLOs adopted in weekly ops review |
| B1 | B | Critical | Security Architect | None | Produce explicit tenant/isolation contract: workspace, collection, session, MCP trust assumptions; define forbidden cross-boundary behaviors | Signed architecture note with testable isolation invariants | Medium | Freeze pilot scope to single tenant until controls finalized | Isolation contract approved by security and platform owners |
| B2 | B | High | Platform Lead | None | Define encryption + backup + restore operational standard (key handling, verification cadence, restore drill policy) | Runbook with mandatory checklist and restore test protocol merged | Medium | Revert to current best-effort docs; block enterprise pilot | 100% scheduled restore drills pass in pilot env |
| C1 | C | High | Performance Engineer | A4 | Formalize benchmark baseline profile using existing perf harness (`tooling/benchmark_warm_daemon.ts`) with threshold files and artifact retention | Baseline report generated, versioned, and compared in CI informational gate | Medium | Keep benchmark non-blocking and manual | Baseline drift trend visible per release candidate |
| C2 | C | High | SRE Engineer | None | Define shard/ANN warning taxonomy response matrix (ready/stale/missing/degraded) with operator actions | On-call playbook maps each warning class to triage/remediation steps | Low | Revert runbook addition only | MTTR for shard/ANN incidents reduced over baseline |

### Horizon 2: Near-term (30-90 days)

| ID | Workstream | Priority | Owner Role | Dependencies | Implementation Scope | Acceptance Criteria | Rollout Risk | Rollback Path | Success Metric |
|---|---|---|---|---|---|---|---|---|---|
| A5 | A | High | Principal Engineer (Core Runtime) | A1 | Introduce clear service boundary between interface layers (CLI/MCP) and retrieval orchestration; reduce cross-layer coupling | Protocol/CLI paths call shared service abstraction with parity tests | Medium | Keep compatibility adapter path to old call graph | Reduced change blast radius for query-path modifications |
| A6 | A | High | SRE Lead | A2, A4 | Persist structured operational events for degraded/fallback queue pressure (local rolling logs) | Replayable incident events available for N days in pilot | Medium | Disable persistent event logging and retain metrics-only mode | Post-incident reconstruction possible without reproducing traffic |
| B3 | B | Critical | Platform Lead | B1, B2 | Define migration/version policy for index capabilities and backup compatibility matrix; add mandatory upgrade checklist | Documented compatibility matrix and release checklist adopted by CI/release process | Medium | Freeze upgrade path and require manual approval | Zero unplanned upgrade reversions during pilot |
| B4 | B | High | Security Architect | B1 | Define auditability requirements for enterprise pilot (event minimums, access/control evidence, retention windows) | Audit requirements mapped to existing and missing telemetry points | High | Restrict pilot to non-regulated workloads | Pilot audit evidence package accepted by governance reviewers |
| C3 | C | High | SRE Lead | C1, C2 | Add gateable perf scenarios: concurrent load, queue stress, degradation behavior, recovery timing | Repeatable perf scenario suite with pass/fail thresholds | Medium | Keep scenarios advisory-only while stabilizing | >=95% of candidate builds meet perf gate thresholds |
| C4 | C | Medium | Platform Lead | B1, C2 | Define fleet operation ownership model for model cache/index lifecycle across hosts | Published RACI for model/index refresh, cache warming, and failure ownership | Medium | Keep host-local ownership with manual SOP | Reduced operational ambiguity in multi-node deployments |

### Horizon 3: Scale (90+ days)

| ID | Workstream | Priority | Owner Role | Dependencies | Implementation Scope | Acceptance Criteria | Rollout Risk | Rollback Path | Success Metric |
|---|---|---|---|---|---|---|---|---|---|
| A7 | A | Medium | Principal Engineer | A5 | Complete architectural simplification of protocol path (auth/session/dedupe/tool policy composable modules) | Protocol components independently testable with contract tests | Medium | Keep legacy orchestration behind feature toggle | Reduced protocol defect rate and faster change velocity |
| B5 | B | Critical | Platform Lead + Security Architect | B1-B4 | Implement and validate hardened multi-tenant deployment profile with enforceable boundaries and policy controls | Tenant-boundary conformance tests pass; security sign-off obtained | High | Keep enterprise rollout restricted to single-tenant isolation model | Pilot can safely expand to multi-tenant controlled env |
| C5 | C | High | SRE Lead | C3, C4 | Institutionalize release-readiness scorecard gates in CI/CD with blocking criteria for enterprise channels | Gate status attached to release artifacts and enforced for enterprise target | Medium | Downgrade to advisory mode if false-positive rate high | No enterprise release promoted with failed hardening gates |
| C6 | C | Medium | Performance Engineer | C3 | Extend scale tests to long-run soak and failure-recovery drills (ANN stale, rerank saturation, model init fallback) | Soak reports show stable degradation/recovery characteristics | Medium | Disable soak gate while preserving test harness | Stability regressions detected before release promotion |

## 4. Workstream Specifications

### Workstream A: Reliability and Operability

Goals:
- Reduce coupling in runtime command/orchestration paths
- Improve operator-facing transparency for degraded conditions
- Establish measurable reliability SLOs and diagnostics coverage

Mandatory deliverables:
- Command modularization map and migration PR plan
- Degraded-mode UX specification and test updates
- Extended `doctor` capability matrix
- SLO spec with metric source mapping

Definition of done:
- Existing command and protocol regression tests remain green
- New diagnostics and degraded-mode checks covered by automated tests
- On-call/operator docs updated with explicit remediation paths

### Workstream B: Enterprise Controls

Goals:
- Formalize isolation assumptions and enforceable boundaries
- Normalize encryption/backup/migration operations
- Define auditability expectations and evidence model

Mandatory deliverables:
- Tenant isolation contract (boundary invariants + forbidden behaviors)
- Encryption/backup/restore standard + drill procedure
- Capability/version upgrade matrix and policy
- Audit evidence checklist for enterprise pilot

Definition of done:
- Security and platform sign-off on control documents
- Restore drill and migration checklist integrated into release process
- Pilot governance accepts evidence package

### Workstream C: Scale Readiness

Goals:
- Convert perf tooling into release confidence gates
- Operationalize ANN/shard lifecycle and failure handling
- Clarify fleet-level ownership for local-first runtime assets

Mandatory deliverables:
- Baseline benchmark and threshold policy
- Concurrency/degradation/recovery scenario suite
- ANN/shard runbook with response matrix
- Fleet lifecycle operating model (RACI)

Definition of done:
- Perf and resilience scenarios are repeatable and thresholded
- Incident playbooks are validated through simulation drills
- Release gate outputs are attached to candidate artifacts

## 5. Readiness Gate Model (Pass/Fail)

### Gate G1: Technical Readiness

Pass criteria:
- Command/protocol modularization milestones completed for current horizon
- No unresolved critical regressions in unit/integration suites
- Retrieval orchestration contract tests pass

Evidence artifacts:
- Test reports (`specs/*`, package tests)
- Architectural diff notes and module ownership map
- Regression triage report

Fail conditions:
- Any unresolved critical regression in command/protocol behavior
- Inability to trace behavior to modular service boundaries (post-horizon target)

### Gate G2: Usability Readiness

Pass criteria:
- Install/first-run/troubleshooting flows validated in runbook scenarios
- Degraded-mode signals visible in CLI/MCP operator surface
- Diagnostics detect key dependency failures (extractors/runtime)

Evidence artifacts:
- UX validation checklist
- CLI/MCP output snapshots for degraded scenarios
- `doctor` scenario test output

Fail conditions:
- First-run blockers lack actionable remediation
- Degraded state not clearly communicated to operators

### Gate G3: Enterprise Readiness

Pass criteria:
- Isolation contract approved and validated against pilot topology
- Encryption/backup/restore standards adopted and drill-complete
- Migration/version compatibility policy active in release workflow

Evidence artifacts:
- Security sign-off memo
- Restore drill reports
- Upgrade checklist completion records

Fail conditions:
- No approved isolation contract
- Backup/restore drill failures unresolved
- Uncontrolled upgrade path for enterprise channel

### Gate G4: Scale Readiness

Pass criteria:
- Concurrency/degradation/recovery thresholds met in benchmark suite
- ANN/shard incident playbooks validated via simulated failures
- Release gating artifacts available per candidate

Evidence artifacts:
- Benchmark reports and threshold comparisons
- Incident simulation logs
- Release scorecards

Fail conditions:
- Perf/degradation thresholds repeatedly violated
- No proven recovery path for key scale failure modes

### Enterprise Pilot Ready Decision

The program can declare `enterprise pilot ready` only when:
- G1, G2, G3, and G4 are all `Pass`
- All `Critical` horizon items up to Near-term are complete

## 6. Test and Validation Plan

### 6.1 Roadmap quality validation

For every roadmap item:
- Owner assigned
- Dependencies explicit
- Acceptance criteria measurable
- Rollback path documented
- At least one traceability anchor present

Validation method:
- Weekly checklist audit by program DRI

### 6.2 Execution-readiness validation by workstream

Required test classes before implementation starts:
- Unit/regression tests for modular refactors
- Integration tests for CLI/MCP operability paths
- Performance and soak benchmarks for concurrency/degradation
- Security/compliance checks for encryption/auth/workflow hygiene

### 6.3 Gate validation scenarios (mandatory)

Scenarios to simulate and record:
- High-concurrency query load with rerank queue pressure and fallback behavior
- ANN/shard stale or missing state and controlled recovery
- Model initialization failure with CPU fallback signaling
- Backup/restore flows for keyed and plaintext compatibility modes

Scenario completion criteria:
- Reproducible steps
- Expected vs observed outcomes captured
- Remediation actions and recovery timing documented

## 7. Traceability Matrix (Roadmap Item -> Evidence Anchor)

| Item ID | Evidence Anchor(s) |
|---|---|
| A1 | `engine/kindx.ts` (command routing and handler density) |
| A2 | `engine/repository.ts` (`structuredSearchWithDiagnostics` fallback/degraded semantics), `engine/protocol.ts` (metadata propagation) |
| A3 | `engine/ingestion.ts` (extractor deps/fallback behavior), `engine/kindx.ts` (`doctor`) |
| A4 | `engine/utils/metrics.ts`, `engine/protocol.ts` (`/metrics`, query counters/histograms), `tooling/benchmark_warm_daemon.ts` |
| B1 | `engine/memory.ts` (`resolveMemoryScope`, strict isolation checks), `engine/mcp-control-plane.ts` (`project_scoped`, trust policy), `enterprise/multi-tenancy-design.md` |
| B2 | `engine/encryption.ts`, `engine/backup.ts`, `README.md` and `enterprise/compliance.md` runbook guidance |
| B3 | `engine/repository.ts` (`index_capabilities`), `engine/diagnostics.ts` capability checks, release/check workflows |
| B4 | `engine/protocol.ts` (request/session metadata surfaces), `.github/workflows/*` security/quality controls, `SECURITY.md` |
| C1 | `tooling/benchmark_warm_daemon.ts`, `.github/workflows/perf-informational.yml`, `tooling/perf-thresholds.json` |
| C2 | `engine/sharding.ts` (ANN state/warnings/checkpoints), `engine/repository.ts` (scale warnings mapping) |
| C3 | `engine/repository.ts` rerank queue control and diagnostics, `engine/protocol.ts` metric emission |
| C4 | `README.md` operating guidance for daemon and local-first patterns, `reference/runbooks/operating-modes.md` |
| A7 | `engine/protocol.ts` transport/auth/session/dedupe concentration |
| B5 | `enterprise/multi-tenancy-design.md` target direction + current control-plane/runtime boundaries |
| C5 | `.github/workflows/ci.yml`, perf/security workflows and artifact model |
| C6 | `tooling/benchmark_warm_daemon.ts`, shard/recovery warning paths in runtime modules |

## 8. Risk Register and Escalation

Critical risks:
- Modularization without contract tests can introduce hidden CLI/protocol regressions
- Enterprise rollout pressure may outpace isolation and migration hardening
- Scale claims may drift from observed benchmark evidence if gates remain informational

Escalation triggers:
- Any `Critical` item slips by more than one review cycle
- Any readiness gate remains `Fail` for two consecutive gate reviews
- Any unplanned production-like incident lacks reproducible evidence artifacts

Escalation path:
- Workstream owner -> Program DRI -> Eng lead + SRE lead + Security architect

## 9. Assumptions and Defaults

- Target remains the current local workspace snapshot on `feature/enterprise-hardening`.
- This artifact is planning and execution-governance only; no direct runtime API change is mandated here.
- Roadmap consumers are engineering leads, SRE, security/compliance, and PM stakeholders.
- Default objective is enterprise pilot readiness, not broad enterprise rollout.

