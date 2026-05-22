# KINDX Cold Start & ANN Design Spec

**Date:** 2026-05-22  
**Branch:** feature/cold-start-ann  
**Priority:** P1  

## Problem Statement

Cold start takes 3-8 seconds due to lazy loading of 3 GGUF models (embed, rerank, generate). No ANN indexing for large corpora (>10K docs). Missing production readiness features: health probes, request queuing, retry logic, and model integrity verification.

## Goals

1. First query latency under 10 seconds via daemon preloading
2. ANN indexing available for corpora >10K docs
3. Health/readiness probes for production orchestrators
4. Priority queue with request shedding under load
5. Retry logic for transient GPU/memory failures
6. Model integrity verification via SHA-256 checksums

## Architecture Overview

```
engine/
  daemon.ts              # Daemon process manager (new)
  preloader.ts           # Model preloading logic (rewrite)
  retryable-llm.ts       # Retry wrapper for LLM operations (new)
  priority-queue.ts      # Request queuing with shedding (new)
  health-checker.ts      # Health/readiness probe logic (new)
  model-integrity.ts     # Checksum verification (new)
  inference.ts           # Add checksum verification to model load
  repository/vec.ts      # Extend ANN for >10K docs
  sharding.ts            # Add HNSW index building
  protocol.ts            # Add /ready endpoint
```

## Component 1: Daemon Process

### Command

```bash
kindx daemon [--preload] [--port <port>]
```

### Behavior

- Starts a long-running Node.js process
- With `--preload`: immediately loads all 3 GGUF models into memory
- Exposes IPC via Unix domain socket (default: `~/.cache/kindx/daemon.sock`)
- CLI commands detect running daemon and proxy requests
- Falls back to direct execution if daemon not running (backward compatible)

### Implementation

- `engine/daemon.ts` — Daemon lifecycle (start, stop, signal handling)
- Reuse existing `LlamaCpp` class for model management
- PID file at `~/.cache/kindx/daemon.pid` for process management
- Graceful shutdown on SIGTERM/SIGINT

### Integration

- `getDefaultLLM()` in `inference.ts` checks for daemon socket first
- If daemon available, returns proxy LLM that forwards via IPC
- If not, creates local `LlamaCpp` instance (current behavior)

## Component 2: ANN Indexing for >10K Docs

### Current State

`sharding.ts` has centroid-based ANN with `ann_centroids_vec` and `ann_assignments` tables.

### Enhancement

- Add HNSW index building in `rebuildShardAnnIndex()`
- When corpus >10K docs, build HNSW graph structure in shard databases
- Use `sqlite-vec` for vector storage, custom HNSW for approximate search
- ANN state tracked in `ann_state` table (already exists)

### New Function

```typescript
buildHnswIndex(shardDb: Database, vectors: Float32Array[], dimensions: number): void
```

- Builds HNSW graph with configurable `M` (connections per node) and `ef` (search width)
- Stores graph in `ann_hnsw_nodes` and `ann_hnsw_edges` tables
- Search: HNSW greedy search → exact re-rank on shortlist

### Configuration

- `KINDX_ANN_THRESHOLD` env var (default: 10000 docs)
- `KINDX_HNSW_M` env var (default: 16)
- `KINDX_HNSW_EF` env var (default: 64)

## Component 3: Health/Readiness Probes

### Endpoints

- `GET /health` — Liveness probe (already exists)
- `GET /ready` — Readiness probe (new)

### Readiness Checks

1. **Models loaded**: All 3 GGUF models loaded in memory
2. **GPU health**: GPU accessible, VRAM available
3. **ANN state**: ANN indexes ready for enabled collections
4. **Database**: SQLite database accessible

### Response Format

```json
{
  "status": "ready" | "not_ready" | "degraded",
  "checks": {
    "models": { "status": "ok", "embed": true, "rerank": true, "generate": true },
    "gpu": { "status": "ok", "available": true, "vramFree": 1234567 },
    "ann": { "status": "ok", "mode": "ann", "state": "ready" },
    "database": { "status": "ok", "accessible": true }
  },
  "timestamp": "2026-05-22T..."
}
```

### Implementation

- `engine/health-checker.ts` — `HealthChecker` class
- `checkLiveness()` — basic uptime check
- `checkReadiness()` — full model/GPU/ANN/database checks
- Daemon calls `checkReadiness()` after preload completes

## Component 4: Request Queuing with Priority

### Current State

`LLMPool` provides basic FIFO concurrency control with `withLease()`.

### Enhancement

- Add priority queue with request shedding
- `engine/priority-queue.ts` — `PriorityQueue<T>` class

### Priority Levels

- `critical` — Health checks, never shed
- `high` — Interactive queries
- `normal` — Default CLI commands
- `low` — Background tasks (embed sync)

### Configuration

- `KINDX_QUEUE_MAX_DEPTH` env var (default: 100)
- When queue full, shed lowest-priority requests with `QueueExhaustedError`

### Integration

- `LLMPool.withLease()` gains optional `priority` parameter
- Backward compatible: existing callers get `normal` priority

## Component 5: RetryableLLM Wrapper

### Purpose

Wraps any `LLM` implementation with automatic retry for transient failures.

### Retry Conditions

- GPU reset errors (CUDA/Metal device lost)
- Memory pressure (OOM, VRAM allocation failures)
- Transient I/O errors (model file read failures)

### Configuration

```typescript
type RetryConfig = {
  maxRetries: number;        // default: 3
  baseDelayMs: number;       // default: 100
  maxDelayMs: number;        // default: 5000
  retryableErrors: string[]; // patterns to match
};
```

### Behavior

- Exponential backoff: `delay = min(baseDelay * 2^attempt, maxDelay)`
- Jitter: ±20% random to prevent thundering herd
- Only retries errors matching `retryableErrors` patterns
- Non-retryable errors propagate immediately

### Implementation

```typescript
export class RetryableLLM implements LLM {
  constructor(private inner: LLM, private config?: Partial<RetryConfig>) {}
  
  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.withRetry(() => this.inner.embed(text, options));
  }
  // ... delegate all LLM methods with withRetry()
}
```

### Integration

`getDefaultLLM()` in `inference.ts` wraps the `LlamaCpp` instance:

```typescript
defaultLLM = new RetryableLLM(new LlamaCpp(config));
```

## Component 6: Model Integrity Verification

### Purpose

Verify GGUF model file integrity using SHA-256 checksums.

### Checksum Storage

- `~/.cache/kindx/models/<filename>.sha256` — stores expected hash
- Downloaded alongside model files from HuggingFace

### Verification Flow

1. On model load (`ensureEmbedModel`, `ensureRerankModel`, `ensureGenerateModel`):
   - Read `.sha256` file if exists
   - Compute SHA-256 of model file
   - Compare; throw `ModelIntegrityError` on mismatch
   - Skip verification if `.sha256` missing (backward compatible)

2. `kindx doctor --verify-models` subcommand:
   - Checks all cached models against their `.sha256` files
   - Reports corrupted or missing models
   - Suggests `kindx pull --force` to re-download

### New Exports

```typescript
export async function verifyModelIntegrity(modelPath: string): Promise<boolean>;
export async function writeModelChecksum(modelPath: string): Promise<void>;
export class ModelIntegrityError extends Error { /* ... */ }
```

### Integration with pullModels()

- After download, write `.sha256` file alongside model
- On `--refresh`, delete old `.sha256` and re-download

## Data Flow

```
kindx daemon --preload
  └→ daemon.ts starts process
      └→ preloader.ts loads 3 models (embed, rerank, generate)
          └→ health-checker.ts reports "ready"
              └→ CLI commands proxy via IPC socket

kindx query "search term"
  └→ priority-queue.ts (normal priority)
      └→ retryable-llm.ts (3 retries, exponential backoff)
          └→ inference.ts → LlamaCpp.embed/rerank/generate
              └→ model-integrity.ts (verify checksum on load)
```

## Acceptance Criteria

- [ ] First query latency under 10 seconds
- [ ] `kindx daemon --preload` preloads models on start
- [ ] For corpora >10K docs, ANN indexing available
- [ ] Health/readiness probes work for production orchestrators
- [ ] Priority queue sheds low-priority requests under load
- [ ] Retry logic handles GPU reset, memory pressure
- [ ] Model integrity verified on load and via `kindx doctor`

## Files to Touch

| File | Changes |
|------|---------|
| `engine/inference.ts` | Add checksum verification, wrap with RetryableLLM |
| `engine/repository/vec.ts` | Extend ANN search for large corpora |
| `engine/preloader.ts` | Rewrite as daemon preload module |
| `engine/sharding.ts` | Add HNSW index building |
| `engine/protocol.ts` | Add `/ready` endpoint |
| `engine/daemon.ts` | New daemon process manager |
| `engine/retryable-llm.ts` | New retry wrapper |
| `engine/priority-queue.ts` | New priority queue |
| `engine/health-checker.ts` | New health probe logic |
| `engine/model-integrity.ts` | New checksum verification |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KINDX_DAEMON_SOCKET` | `~/.cache/kindx/daemon.sock` | Daemon IPC socket path |
| `KINDX_ANN_THRESHOLD` | `10000` | Doc count threshold for ANN |
| `KINDX_HNSW_M` | `16` | HNSW connections per node |
| `KINDX_HNSW_EF` | `64` | HNSW search width |
| `KINDX_QUEUE_MAX_DEPTH` | `100` | Max queue depth before shedding |
| `KINDX_RETRY_MAX` | `3` | Max retry attempts |
| `KINDX_RETRY_BASE_MS` | `100` | Base retry delay |
| `KINDX_RETRY_MAX_MS` | `5000` | Max retry delay |

## Dependencies

- No new external dependencies
- Reuses existing `node-llama-cpp`, `sqlite-vec`, `better-sqlite3`
- HNSW implementation is custom (in `sharding.ts`)

## Testing Strategy

- Unit tests for each new module (`priority-queue.ts`, `retryable-llm.ts`, etc.)
- Integration tests for daemon IPC and health probes
- Benchmark tests for ANN vs exact search on large corpora
- E2E test: `kindx daemon --preload` → query → verify < 10s

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Daemon process crashes | PID file + auto-restart on next CLI command |
| HNSW index build slow | Background build with progress reporting |
| Checksum file missing | Skip verification (backward compatible) |
| Queue shedding too aggressive | Configurable threshold, metrics for tuning |

## Future Work

- Daemon auto-start on first CLI command
- Model hot-reload without daemon restart
- Distributed ANN across multiple machines
- GPU memory pooling across models
