# KINDX v1.0.1 User Experience Audit (RAG + Local-First)

Date: 2026-03-27  
Version audited: `@ambicuity/kindx@1.0.1`

## 1) Performance & Hardware Constraint Test (<= 4GB VRAM)

### Scenario and Test Matrix
Simulated hybrid query behavior under low VRAM pressure:
- Retrieval mode: hybrid (`BM25 + vector + rerank`)
- Constraint: GPU available, free VRAM constrained/fluctuating (`<= 4GB` total budget class)
- Method: static behavior trace against current code paths (`hybridQuery`, rerank context allocation, truncation guard)

| Case | Query | FTS Probe / Expansion | Vector Stage | Rerank Context Stage | Final Ranking Path | UX Impact |
|---|---|---|---|---|---|---|
| 1. Exact keyword intent | `sqlite-vec migration checklist` | Likely strong lexical signal; expansion may be skipped | Runs normally when embedding succeeds; FTS-only if embed fails | Context count downscales by VRAM budget; first tries flash-attention | Position-aware blend; retrieval signal protected at top ranks | Fast and stable for exact-match corpora |
| 2. Semantic intent | `how should we harden local rag retrieval quality` | Usually weaker FTS lead; expansion likely used | Original + vec/hyde variants embedded and searched | Same VRAM-aware scaling; fallback to non-flash if first context fails | Blend favors reranker more outside top retrieval positions | Better semantic recall, higher latency sensitivity |
| 3. Long-form prompt | `give a step-by-step deployment and rollback strategy for kindx with secure defaults, ci checks, and migration safety` | Mixed lexical signal; expansion typically active | More chance of embedding pressure for larger variant set | Truncation guard applies per chunk budget; context creation still VRAM-gated | Blend proceeds if at least one rerank context exists | Quality preserved; possible latency increase from truncation/rerank load |
| 4. Typo/noisy query | `deplymnt hybdr serch safty runbok` | Weak lexical confidence; expansion route more likely | Vector stage carries recovery when embeddings available | Same context fallback chain; fewer contexts under pressure | Blend may recover relevance via semantic candidates | More robust than pure BM25 on misspellings |
| 5. CJK-heavy query | `如何在低显存下稳定运行混合检索并避免重排崩溃` | Lexical signal may vary by corpus tokenization | Vector route important for semantic alignment | Token-budget truncation guard reduces overflow risk for high token density | Blend remains deterministic; hard-fail only if no context can be created | Improved stability for long/CJK text; potential truncation tradeoff |
| 6. Broad ambiguous query | `improve search performance` | Broad FTS hits; expansion helps disambiguate | Vector variants diversify candidate pool | Context scaling/fallback as above | Blend helps reranker separate broad candidates | Better ranking quality, but broad intent can increase rerank cost |

### What the current stability logic does
Observed behavior from `engine/inference.ts` and `engine/repository.ts`:

1. Hybrid retrieval still starts with symbolic + semantic retrieval.
- `hybridQuery()` performs FTS first and runs vector search via precomputed embeddings.
- If vector embedding batch fails, it degrades to FTS-only candidates (warning path), keeping the query functional.

2. Reranker context fan-out is VRAM aware.
- `computeParallelism(perContextMB)` calculates context count from free VRAM budget:
  - Uses ~25% of currently free VRAM.
  - Caps context count (`<= 8`, then rerank layer additionally clamps to `<= 4`).
  - Always floors to at least one context when possible.

3. Reranker context creation uses a two-stage fallback.
- First attempt: `createRankingContext({ flashAttention: true, contextSize, ... })`
- If first context fails, retry without flash attention.
- If that also fails and zero contexts exist, throw `Failed to create any rerank context`.

4. Token-budget guard prevents context overflow crashes.
- Before rerank, documents are truncated based on:
  - `rerankContextSize - templateOverhead - queryTokens`
  - with a hard minimum of 128 tokens per doc.
- This avoids oversize prompt contexts under long queries/high token-density text.

5. Final ranking remains deterministic under pressure.
- Retrieval candidates are fused with RRF.
- Rerank scores are blended position-aware (top retrieval ranks retain protective weighting).

### Flow Diagram (Text)

Applies to all 6 scenarios above. Entry branch differs by query profile:
- cases 1 may hit the strong-signal/skip-expansion branch,
- cases 2-6 more often enter expansion + multi-list fusion.

```text
[User Query]
   |
   v
[FTS Probe + Initial BM25]
   |-- strong signal? --> yes --> [Skip expansion]
   |                           |
   |                           v
   |                        [RRF candidates]
   |
   '-- no --> [Expand query types lex/vec/hyde]
               |
               +--> [lex -> FTS lists]
               |
               '--> [vec/hyde + original -> embedBatch -> sqlite-vec lists]
                              |
                              '-- embed failure --> [FTS-only degrade path]

[Merge ranked lists with RRF]
   |
   v
[Top-N candidates -> chunk selection]
   |
   v
[ensureRerankContexts()]
   |
   +--> computeParallelism from free VRAM (25% budget, capped)
   |
   +--> create context w/ flashAttention
   |      |
   |      '-- fail and none created --> retry without flashAttention
   |                                  |
   |                                  '-- fail again --> ERROR: no rerank context
   |
   '-- success --> [rerank chunk texts]
                    |
                    v
          [blend RRF position score + rerank score]
                    |
                    v
                [Final ranked results]
```

Failure behavior under severe memory pressure:
- If embeddings fail: hybrid still returns FTS-driven results.
- If rerank contexts cannot be created at all: rerank stage hard-fails for that request (current behavior).

### Pass Criteria (Simulation Review)
- Retrieval stage remains operational for all 6 queries (no retrieval-stage crash).
- Degraded embedding path is explicit (FTS-only fallback is observable via warning behavior).
- Rerank context exhaustion is explicit and surfaced as an error condition, not silent score corruption.

### Edge-Case Input/Output Matrix (Low VRAM)
Output semantics used in this section:
- `success`: ranked results are returned.
- `degraded-success`: ranked results are returned, but hybrid quality is reduced (for example FTS-only fallback).
- `error`: explicit surfaced failure (no silent corruption).

| Case | Input | Preconditions | Expected Output | Expected Log/Signal | Failure Surface |
|---|---|---|---|---|---|
| 1. Strong lexical signal | `sqlite-vec migration checklist` | BM25 probe top score/gap passes strong-signal gate | `success` with ranked results; expansion skipped branch | Strong-signal branch chosen; no expansion dependency | None expected |
| 2. Weak lexical signal | `how should we harden local rag retrieval quality` | BM25 signal not strong enough to skip expansion | `success` with ranked results from expanded multi-list fusion | Expansion + vector query variants executed | None expected |
| 3. `embedBatch` failure -> FTS fallback | any hybrid query (e.g. `improve search performance`) | embedding stage throws during `embedBatch` | `degraded-success` with FTS-driven candidate path | Warning indicating embed failure and FTS-only continuation | Retrieval quality regression (semantic branch absent), not crash |
| 4. Flash-attention context failure | any query requiring rerank | first `createRankingContext(...flashAttention:true)` fails; non-flash retry succeeds | `success` with reranked/blended results | Fallback to non-flash context path is taken | Possible latency increase |
| 5. No rerank context can be created | any query requiring rerank | both flash and non-flash first-context creation fail | `error` (request fails explicitly) | Error path indicating no rerank context could be created | Hard-fail at rerank stage |
| 6. Long query/doc token pressure | long-form prompt and/or long chunks | token budget exceeded without truncation | `success` if at least one rerank context exists; docs truncated to budget | Truncation guard behavior applied (max doc token budget with floor) | Recall/precision tradeoff from truncation |
| 7. Typo/noisy input recovery | `deplymnt hybdr serch safty runbok` | weak lexical match; semantic path available | `success` with semantic-assisted ranking recovery | Expansion and vector path more influential than pure lexical | Lower confidence if corpus lacks semantic neighbors |
| 8. CJK-heavy token density | `如何在低显存下稳定运行混合检索并避免重排崩溃` | higher token density increases context pressure | `success` when contexts exist; truncation commonly engaged | Token-budget protection prevents overflow-style crashes | Possible truncation-induced detail loss |

### High-Risk Input/Output Examples (JSON)
These examples are simulated behavior contracts (not benchmark measurements).

#### A) Normal hybrid success
```json
{
  "input": {
    "query": "sqlite-vec migration checklist",
    "mode": "hybrid",
    "constraints": { "vramClass": "<=4GB", "embedBatchFailure": false, "rerankContextAvailable": true }
  },
  "expectedOutput": {
    "status": "success",
    "results": [
      { "file": "docs/deployment.md", "scoreType": "blended" },
      { "file": "docs/api-reference.md", "scoreType": "blended" }
    ],
    "semantics": {
      "resultsPresent": true,
      "rankingPath": "rrf_plus_rerank_blend",
      "expansionSkippedOrReduced": true
    }
  },
  "expectedSignals": {
    "warnings": [],
    "errors": []
  }
}
```

#### B) Degraded FTS-only fallback after embed failure
```json
{
  "input": {
    "query": "improve search performance",
    "mode": "hybrid",
    "constraints": { "vramClass": "<=4GB", "embedBatchFailure": true, "rerankContextAvailable": true }
  },
  "expectedOutput": {
    "status": "degraded-success",
    "results": [
      { "file": "docs/deployment.md", "scoreType": "fts_or_degraded_blend" }
    ],
    "semantics": {
      "resultsPresent": true,
      "rankingPath": "fts_seeded_with_no_vector_enrichment",
      "qualityNote": "semantic-recall-reduced"
    }
  },
  "expectedSignals": {
    "warnings": ["embed failure warning with explicit fallback to FTS-only path"],
    "errors": []
  }
}
```

#### C) Hard-fail when rerank contexts cannot be created
```json
{
  "input": {
    "query": "how should we harden local rag retrieval quality",
    "mode": "hybrid",
    "constraints": {
      "vramClass": "<=4GB",
      "embedBatchFailure": false,
      "rerankContextFlashFails": true,
      "rerankContextNonFlashFails": true
    }
  },
  "expectedOutput": {
    "status": "error",
    "results": [],
    "semantics": {
      "resultsPresent": false,
      "errorClass": "rerank_context_initialization_failure"
    }
  },
  "expectedSignals": {
    "warnings": [],
    "errors": ["explicit rerank context creation failure surfaced to caller"]
  }
}
```

## 2) Multi-Agent Isolation Logic (Index Isolation)

### Isolation model
KINDX memory isolation is scope-based and enforced in two layers:
- Scope resolution guard (`explicit > session > workspace > default`) with strict rejection of cross-scope override.
- SQL read/write filtered by `WHERE scope = ?` for memory tables.

### Conceptual schema and guard (TypeScript)

```ts
// Conceptual shape aligned to current memory/protocol behavior

type MemoryScopeContext = {
  sessionScope?: string;
  workspaceScope?: string;
};

type ScopeResolution = {
  scope?: string;
  error?: { code: "cross_scope_forbidden"; message: string };
};

function resolveToolScope(args: { scope?: string }, ctx: MemoryScopeContext): ScopeResolution {
  const explicit = args.scope?.trim();
  const allowed = ctx.sessionScope ?? ctx.workspaceScope ?? "default";

  if (explicit && explicit !== allowed) {
    return {
      error: {
        code: "cross_scope_forbidden",
        message: `Explicit scope '${explicit}' is not allowed for this session (allowed scope: '${allowed}').`,
      },
    };
  }

  return { scope: explicit || allowed };
}

// Every query must bind scope:
const insertSql = `
  INSERT INTO memories (scope, key, value, confidence)
  VALUES (?, ?, ?, ?)
`;

const searchSql = `
  SELECT id, scope, key, value
  FROM memories
  WHERE scope = ? AND superseded_by IS NULL
`;
```

### Agent A vs Agent B denial example

- Session A initialize context resolves to `workspace-alpha`.
- Session B initialize context resolves to `workspace-beta`.

Example denial request from Agent B:

```json
{
  "name": "memory_search",
  "arguments": {
    "scope": "workspace-alpha",
    "query": "private roadmap"
  }
}
```

Expected error text:
- `cross_scope_forbidden: Explicit scope 'workspace-alpha' is not allowed for this session (allowed scope: 'workspace-beta').`

## 3) Deployment & Lifecycle (Install -> Operate -> Uninstall)

### Download / Install
Exact package install command:

```bash
npm install -g @ambicuity/kindx
```

### Operate
Two init scripts are provided in `tooling/`:
- `tooling/init-mcp-http.ts` (MCP initialize/session-id safe handshake)
- `tooling/init-cli-warmup.ts` (`withLLMSession` warmup with explicit single-await lifecycle)

### Cleanup
Soft prune (keep install, clean operational state):

```bash
kindx cleanup
```

This clears:
- LLM cache rows,
- orphan vectors,
- inactive docs,
- and runs DB vacuum.

Hard local wipe (remove KINDX local runtime artifacts):

```bash
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/kindx"
```

This removes index DB and cache artifacts together (for default layout), including:
- `index.sqlite`
- model cache (`models/`)
- MCP runtime files (`mcp.pid`, `mcp.log`)

No hardcoded magic-number path assumptions are required; `XDG_CACHE_HOME` is honored.

## 4) CI/CD Debugging: Trivy + local LLM binaries

### Why Trivy can fail/noise on this stack
Projects using `node-llama-cpp` often pull platform-specific prebuilt native binaries under:
- `node_modules/@node-llama-cpp/*`

Filesystem scans can emit noisy or low-actionability findings for vendored native payloads that are not first-party source code and may not map cleanly to application-level remediation.

### Configuration fix applied
- Added `.trivyignore` for narrowly scoped `node-llama-cpp` binary CVE suppression entries.
- Updated `.github/workflows/trivy.yml` to:
  - consume ignore file,
  - skip scanning only the prebuilt `@node-llama-cpp` binary directory,
  - retain `CRITICAL,HIGH` visibility for first-party code/dependencies.

This keeps security signal high while reducing false-positive churn from vendor binary blobs.

## 5) Gap Closure Addendum (Manual Evidence)

Manual evidence run date: 2026-03-27  
Isolated environment used for reproducibility:
- `KINDX_CONFIG_DIR=/tmp/kindx_manual_edgecases/config`
- `XDG_CACHE_HOME=/tmp/kindx_manual_edgecases/cache`

### 5.1 Dynamic VRAM Volatility ("Death Spiral" race)

#### Manual procedure
1. Force aggressive rerank context pressure:
```bash
KINDX_RERANK_CONTEXT_SIZE=2000000 \
KINDX_CONFIG_DIR=/tmp/kindx_manual_edgecases/config \
XDG_CACHE_HOME=/tmp/kindx_manual_edgecases/cache \
node dist/kindx.js query "harden local rag retrieval quality edgecase unique 99117" --json -n 3
```
2. Run parallel requests under pressure to surface collision/jitter behavior:
```bash
# two simultaneous queries against same isolated index
KINDX_RERANK_CONTEXT_SIZE=1500000 ... query ... & 
KINDX_RERANK_CONTEXT_SIZE=1500000 ... query ... &
wait
```

#### Observed output
- Explicit hard-fail observed: `Error: Failed to create any rerank context`.
- Native crash surface observed after failure on this host: Metal/ggml assert trace.
- Parallel run produced asymmetric behavior:
  - one request returned `[]`,
  - one request failed with `SqliteError: database is locked (SQLITE_BUSY)` during initialization.

#### Verdict
- `partially validated` for dynamic race risk.
- We validated allocation failure and unstable behavior under pressure, but did not reproduce a controlled external-GPU-spike timing window between `computeParallelism` and allocation.

### 5.2 Cold-Start Latency, Wait-State, and MCP Timeouts

#### Manual procedure
1. Start isolated MCP HTTP daemon:
```bash
KINDX_CONFIG_DIR=/tmp/kindx_manual_edgecases/config \
XDG_CACHE_HOME=/tmp/kindx_manual_edgecases/cache \
node dist/kindx.js mcp --http --daemon --port 8200
```
2. Measure initialize and query request times with `curl` (`/mcp` JSON-RPC).
3. Send duplicate in-flight query calls concurrently and compare completion times.

#### Observed output
- MCP initialize completed with session id (`mcp-session-id`) and response timing captured.
- Structured query calls completed successfully with measured timings.
- Duplicate concurrent MCP calls both completed (no client-visible timeout/hang in this small corpus run).

#### Verdict
- `partially validated`.
- Wait-state/timeout path is instrumentable and did not hang in observed runs, but long-tail 10–15s behavior on lower-end hardware was not reproduced in this environment.

### 5.3 Retrieval Integrity vs Float Baseline (sqlite-vec quality drift)

#### Manual procedure (defined)
1. Fix a query set: exact, typo/noisy, CJK, broad semantic.
2. Run current KINDX sqlite-vec path and capture ranked outputs.
3. Run a float32 baseline approximation over same corpus/chunks.
4. Compute `Recall@K`, `Hit@K`, and `MRR` deltas.

#### Observed output
- Current audit run validated functional retrieval paths, including typo and CJK scenarios.
- A true float32 baseline comparator is not currently wired in this repository’s standard CLI path.

#### Verdict
- `not fully validated`.
- Benchmark method is defined and required for quality-signoff; current audit has behavior validation, not full quantitative drift validation.

### 5.4 Multi-Agent Cross-Talk via Shared LLM Backend

#### Risk grounding
- KINDX uses a shared default LLM singleton (`getDefaultLLM`) and shared lifecycle manager.
- SQL scope isolation is enforced for memory rows; KV-cache cross-talk is a separate concern.

#### Manual procedure (defined)
1. Session A: inject deterministic secret token context.
2. Close/release Session A.
3. Session B: query for secret token inference with no authorized data path.
4. Repeat multiple runs; classify as `no leak`, `suspicious influence`, or `reproducible cross-talk`.

#### Observed output
- SQL scope isolation behavior is verified separately (`cross_scope_forbidden` path).
- A dedicated deterministic KV cross-talk inference harness was not executed in this pass.

#### Verdict
- `partially validated`.
- Architectural risk is documented; reproducible inference harness remains a required follow-up test.

### 5.5 Hard-Wipe Forensics (`index.sqlite`, `-wal`, `-shm`, locks)

#### Manual procedure
1. Normal stopped-process wipe:
```bash
KINDX_CONFIG_DIR=/tmp/kindx_manual_edgecases/config \
XDG_CACHE_HOME=/tmp/kindx_manual_edgecases/cache \
node dist/kindx.js cleanup
rm -rf /tmp/kindx_manual_edgecases/cache/kindx
```
2. Active-process wipe:
```bash
KINDX_CONFIG_DIR=/tmp/kindx_manual_edgecases/config \
XDG_CACHE_HOME=/tmp/kindx_manual_edgecases/cache \
node dist/kindx.js mcp --http --daemon --port 8199
rm -rf /tmp/kindx_manual_edgecases/cache/kindx
```

#### Observed output
- Stopped-process wipe: cache directory removed successfully (`CACHE_KINDX_DIR_REMOVED_AFTER_WIPE`).
- Active-process wipe on this Unix host:
  - cache directory removed while daemon remained alive (`MCP_PROCESS_STILL_RUNNING_AFTER_WIPE`),
  - pid/log artifacts disappeared with directory deletion.

#### Verdict
- `partial/privacy-risk note`.
- Wipe succeeds at directory level, but active-process semantics can create operational ambiguity; forensic verification should include post-kill residual scan and platform-specific lock behavior (especially Windows).

### Gap Summary (Current Pass)

| Gap | Status | Evidence Strength | Residual Risk |
|---|---|---|---|
| Dynamic VRAM race | Partial | Manual hard-fail + collision behavior captured | External VRAM spike race not deterministically reproduced |
| TTFT/wait-state/timeouts | Partial | MCP timing and duplicate-call behavior captured | Lower-end long-tail latency not reproduced |
| sqlite-vec quality drift vs float baseline | Partial | Functional retrieval validated | Quantitative Recall@K/MRR baseline comparison still missing |
| Cross-talk via shared backend | Partial | Architecture/risk mapped, SQL isolation known | Dedicated KV leakage harness still required |
| Hard wipe forensics | Partial | Stopped/active wipe manual behavior captured | Cross-platform lock/WAL-SHM persistence audit still needed |

## 6) v1.0.2 Hardening Implementation Update

Implementation date: 2026-03-27

This section tracks concrete hardening changes implemented after the gap analysis.

### 6.1 VRAM race hardening (allocator safety)
- Added VRAM reserve policy:
  - `usable_vram = max(0, free_vram*0.25 - reserve_mb)`
  - env: `KINDX_VRAM_RESERVE_MB` (default `512`)
- Added pre-allocation VRAM recheck before creating additional rerank contexts.
- Added structured allocation error classification:
  - `rerank_context_allocation_failed`

Implementation references:
- `engine/inference.ts`

### 6.2 TTFT/wait-state telemetry + timeout/dedupe
- Added phase timing hooks:
  - `expand_ms`, `embed_ms`, `retrieval_ms`, `rerank_init_ms`, `rerank_ms`, `total_ms`
- Exposed timings in:
  - CLI (`kindx query --explain` timing summary line)
  - MCP tool structured payload (`structuredContent.timings`)
  - HTTP `/query` response (`metadata.timings`)
- Added optional timeout guard:
  - env: `KINDX_QUERY_TIMEOUT_MS`
  - returns structured error code `query_timeout` in HTTP path.
- Added in-flight dedupe policy:
  - env: `KINDX_INFLIGHT_DEDUPE` (`join` default, `off` optional)
  - same-session duplicate `/query` and MCP query-tool calls join existing in-flight work.

Implementation references:
- `engine/repository.ts`
- `engine/protocol.ts`
- `engine/kindx.ts`

### 6.3 Retrieval integrity benchmark harness
- Added benchmark harness for quality drift checks:
  - `tooling/benchmark_retrieval_integrity.py`
- Computes:
  - `Hit@K`, `MRR`
  - relative drop checks for typo/CJK buckets vs float32 baseline approximation
- Supports threshold policy:
  - `--fail-relative-drop` (default `0.10`)

### 6.4 Multi-agent KV/cache isolation hardening
- Added LLM scope isolation helper (`withLLMScope`) and sensitive-context disposal.
- Rerank contexts rotate on scope changes.
- MCP session close triggers sensitive-context disposal.

Implementation references:
- `engine/inference.ts`
- `engine/protocol.ts`

### 6.5 Hard-wipe forensics and WAL safety
- Cleanup now includes:
  - `PRAGMA wal_checkpoint(TRUNCATE)`
  - `VACUUM`
  - sidecar removal attempt for `index.sqlite-wal` and `index.sqlite-shm`
  - structured cleanup report fields:
    - `checkpointed`, `wal_removed`, `shm_removed`, `locked_files`
- Added:
  - `kindx verify-wipe` command to scan cache/config roots for residual index artifacts.

Implementation references:
- `engine/repository.ts`
- `engine/kindx.ts`

### 6.6 Verification status
- Automated regression suite executed after hardening:
  - `specs/command-line.test.ts`
  - `specs/mcp.test.ts`
- Status: passing on current environment.

## Verification Notes
- Audit statements were traced directly to code paths in:
  - `engine/inference.ts`
  - `engine/repository.ts`
  - `engine/memory.ts`
  - `engine/protocol.ts`
  - `.github/workflows/trivy.yml`
- Target version confirmed from `package.json` and `CHANGELOG.md` as `1.0.1`.
