# KINDX Customer POV Evidence Template

Use this template to capture decision-ready evidence for each launch gate and customer outcome.

## 1) Run Metadata

- Date (local):
- Commit SHA:
- KINDX version:
- Runner:
- Environment ID:
- OS/runtime profile: `macOS|Ubuntu|Windows/WSL2`, `Node|Bun`
- Hardware/network profile: `H1|H2|H3`, `N1|N2|N3`

## 2) Gate Summary

| Gate | Status (`pass|fail|blocked`) | Notes |
|---|---|---|
| P0 smoke |  |  |
| P1 outcome E2E |  |  |
| P2 resilience/upgrade |  |  |
| P3 regression lock |  |  |

## 3) Outcome Results (1-10)

| Outcome | Status (`pass|fail|blocked`) | Key Evidence Artifact(s) | Issues |
|---|---|---|---|
| 1 install success |  |  |  |
| 2 collection onboarding |  |  |  |
| 3 embed + useful search |  |  |  |
| 4 reliable document retrieval |  |  |  |
| 5 CLI/MCP integration |  |  |  |
| 6 shared-safe RBAC |  |  |  |
| 7 detect/diagnose/recover |  |  |  |
| 8 privacy/local trust |  |  |  |
| 9 issue recovery without dead-ends |  |  |  |
| 10 sustained reliability/value |  |  |  |

## 4) Launch-Blocking Test Results

| Test | Status | Evidence |
|---|---|---|
| 1 cross-platform install |  |  |
| 2 README quick start |  |  |
| 3 low-VRAM/CPU embed-query |  |  |
| 4 retrieval accuracy benchmark |  |  |
| 5 MCP stdio + HTTP interoperability |  |  |
| 6 RBAC adversarial tests |  |  |
| 7 local privacy network proof |  |  |
| 8 backup verify/restore drill |  |  |
| 9 extractor/model/env fault recovery |  |  |
| 10 24h concurrency soak |  |  |

## 5) Observability Snapshot

- `/health` status:
- `/metrics` highlights:
  - `kindx_query_requests_total`
  - `kindx_query_degraded_total`
  - `kindx_rerank_queue_depth`
  - `kindx_rerank_queue_timed_out_total`
  - `kindx_rerank_queue_saturated_total`
- Any elevated error/degraded indicators:

## 6) Risk Register Delta

- Newly observed customer-facing risks:
- Existing risks closed this run:
- Remaining high risks:

## 7) Gaps and Follow-ups

- Evidence gaps remaining:
- Required reruns:
- Owner and due date:

## 8) Final Readiness Decision

- Decision (`go|conditional-go|no-go`):
- Rationale:
- Blocking issues (if any):
