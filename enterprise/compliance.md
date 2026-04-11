# KINDX Compliance & Security Posture

## Overview
Enterprise security teams are rightfully skeptical of deploying AI infrastructure that phones home, silently uploads code telemetry, or exposes internal intellectual property to external aggregation services. 

KINDX is designed for local-first operation with minimal external dependencies in the default runtime path. This document distinguishes between what is implemented today and what requires deployment policy to enforce.

## 1. Zero Telemetry & Air-Gapped Operation

### Current Reality
KINDX does not include built-in telemetry SDKs, but it does contain optional networked paths for model retrieval and remote-backend inference.

- **No bundled telemetry SDKs**: no built-in usage analytics pipeline is present by default.
- **Air-gapped capable with preparation**: runtime retrieval/inference can run offline **after** required models are staged locally and remote backend mode is disabled.
- **Local inference path**: embedding/query expansion/reranking run via local GGUF + `node-llama-cpp` when `KINDX_LLM_BACKEND=local`.
- **Network-capable paths exist**:
  - model pulls from HuggingFace (`kindx pull` / first-run model resolution),
  - optional remote OpenAI-compatible backend (`KINDX_LLM_BACKEND=remote`).

For strict environments, enforce outbound network policy and pre-seed model cache directories during image/build provisioning.

## 2. Data Sovereignty and Artifact Containment

### Deterministic State
KINDX encapsulates all semantic intelligence into deterministic local files:
- `index.yml` (Configuration)
- `index.sqlite` (The primary relational and vector storage)
- `documents_fts` (The localized lexical BM25 engine within SQLite)

### Enterprise Containment Strategies
Because KINDX does not require a managed DBaaS for core retrieval, data residency can remain local to the host or deployment boundary.

- **Containerized Ephemerality**: KINDX can be destroyed and regenerated on demand. Codebases pushed to ephemeral CI/CD environments can generate their vector index locally, pass it to an autonomous agent, and destroy it within seconds of task completion. No lingering API state left behind.
- **Data subject operations**: deleting source files and re-running `kindx update`/`kindx cleanup` removes active references and orphaned content from local SQLite indexes. For strict deletion SLAs, include explicit cleanup in the runbook.

## 3. Dependency Supply Chain Security

To mitigate supply chain poisoning and zero-day dependency vulnerabilities common in modern Node.js ecosystems, KINDX architecture follows strict hardening policies:

1. **Dependency Minimization**: The core search protocol relies on foundational C C++ wrappers (`better-sqlite3`, `sqlite-vec`).
2. **Deterministic Builds**: Lockfiles natively dictate cryptographic hashes of upstream dependencies.
3. **Privilege Dropping**: KINDX daemon commands are designed to execute in unprivileged user spaces. Root permissions (`sudo`) are never requested nor required to embed logic or create the watch servers.

## Summary Statement
KINDX provides a strong local-first foundation for private retrieval workloads, but compliance posture depends on deployment controls (network egress policy, key management, backup handling, and runbook discipline).

## 4. Encryption Operations Runbook (P2)

### Keyed Runtime
- Set `KINDX_ENCRYPTION_KEY` before starting KINDX to enable encrypted open/migration paths.
- On first keyed open, KINDX auto-migrates plaintext `index.sqlite` and shard `.sqlite` files in place.
- If key mismatch or corruption is detected, KINDX fails closed with explicit remediation messaging.

### Backup Policy
- `kindx backup create` preserves encrypted/plain format of the source index.
- `kindx backup verify` reports encryption/key requirements.
- `kindx backup restore` enforces compatibility:
  - encrypted backup requires `KINDX_ENCRYPTION_KEY`
  - plaintext backup requires key unset

### Key Rotation
1. Verify clean state: `kindx doctor --json`
2. Create backup: `kindx backup create`
3. Start KINDX with the new key and run a read command (`kindx status`) to confirm encrypted open.
4. Re-verify integrity and ANN/extractor status: `kindx doctor --json`
5. Keep old backup under retention policy until validation window closes.
