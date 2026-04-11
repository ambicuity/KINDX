# KINDX Compliance & Security Posture

## Overview
Enterprise security teams are rightfully skeptical of deploying AI infrastructure that phones home, silently uploads code telemetry, or exposes internal intellectual property to external aggregation services. 

KINDX is engineered from the ground up as a **Zero-Trust, Zero-Telemetry, Air-Gapped** architecture. This document outlines the compliance guarantees of the KINDX engine for enterprise deployment.

## 1. Zero Telemetry & Air-Gapped Operation

### The Guarantee
**KINDX does not contain any functional code that transmits usage data, analytics, model traces, or source code to third-party endpoints.**

- **No Remote Telemetry**: There are no hidden tracking SDKs (e.g., Sentry, Mixpanel, Datadog) bundled into the binary.
- **Air-Gapped Execution**: The entire system, including the embedding and query expansion lifecycle, operates flawlessly in networks with the external internet strictly firewalled.
- **Local Inference**: The semantic engine relies on local `ONNX` or `GGUF` model files executing sequentially via Node-Llama-CPP bindings or ONNX Runtime entirely on the host machine's CPU/GPU.

*Auditors can verify this by tracing all external HTTP modules or `fetch` calls in the open-source repository—network outbound strictly does not exist for the core engine.*

## 2. Data Sovereignty and Artifact Containment

### Deterministic State
KINDX encapsulates all semantic intelligence into deterministic local files:
- `index.yml` (Configuration)
- `index.sqlite` (The primary relational and vector storage)
- `documents_fts` (The localized lexical BM25 engine within SQLite)

### Enterprise Containment Strategies
Because KINDX does not synchronize to a remote Database-as-a-Service (DBaaS), enterprises retain total mathematical data sovereignty. 

- **Containerized Ephemerality**: KINDX can be destroyed and regenerated on demand. Codebases pushed to ephemeral CI/CD environments can generate their vector index locally, pass it to an autonomous agent, and destroy it within seconds of task completion. No lingering API state left behind.
- **Data Subject Requests (GDPR / CCPA)**: Deleting a raw file from the filesystem naturally cascades to complete deletion from the semantic memory. The `kindx watch` daemon intercepts the `unlink` event and atomically drops the vectors and raw text hashes from the local SQLite database. 

## 3. Dependency Supply Chain Security

To mitigate supply chain poisoning and zero-day dependency vulnerabilities common in modern Node.js ecosystems, KINDX architecture follows strict hardening policies:

1. **Dependency Minimization**: The core search protocol relies on foundational C C++ wrappers (`better-sqlite3`, `sqlite-vec`).
2. **Deterministic Builds**: Lockfiles natively dictate cryptographic hashes of upstream dependencies.
3. **Privilege Dropping**: KINDX daemon commands are designed to execute in unprivileged user spaces. Root permissions (`sudo`) are never requested nor required to embed logic or create the watch servers.

## Summary Statement
KINDX represents the highest echelon of secure autonomous agent infrastructure by eliminating the concept of an "external service." If your file system is secure, your semantic agent memory is secure.
