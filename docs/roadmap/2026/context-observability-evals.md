# Context, Observability, and Evals

A first-class on-disk telemetry, replay, and evaluation surface for KINDX
that turns the engine from a "good search box" into an audit-grade retrieval
substrate for agentic systems.

## Branch

`feat/context-observability-evals`

This branch is scoped to ship the persisted trace store, the context-window
snapshot store, the eval runner + comparator, the trace replay command, and
the local dashboard SPA. It does *not* change the public hybrid retrieval
algorithm, the chunker, the embedding contract, or the audit log format. It
adds new tables, new schemas, new MCP tools, new HTTP routes, new CLI verbs,
and one statically-served SPA bundle.

## Owner type

Retrieval Quality + Developer Experience squad.

- Single owner: BDFL `@ambicuity`.
- Reviewers: at least one retrieval-pipeline reviewer (hybrid.ts / rerank.ts
  area) and one protocol reviewer (`protocol.ts` / `tool-registry.ts`).
- Out-of-band sign-off: privacy reviewer for the context-window snapshot
  redaction surface, because snapshots can contain PII pulled from user notes.

The branch is large but additive. It is intentionally structured so that each
phase ships as a self-contained PR that can land on `main` without enabling
end-user-visible behavior until the final dashboard PR flips the default.

## Problem

KINDX today (v1.3.5) has no persisted observability of retrieval quality or
context shape. Concretely:

- `engine/repository/retrieval/hybrid.ts` accepts an `explain` flag on
  `HybridQueryOptions` and returns reasoning inline, but that explanation is
  never persisted. The pipeline shape — expanded terms, embedding-cache
  hits, BM25-vs-dense fusion losers, reranker drops — is lost once the
  response renders. Only a free-text audit line survives in
  `engine/audit.ts`.
- `engine/utils/metrics.ts` exposes Prometheus aggregates
  (`kindx_query_total_ms`, `kindx_rerank_queue_depth`, …). You cannot
  reconstruct a single bad query from them.
- `engine/diagnostics.ts` and `engine/health-checker.ts` cover liveness
  (`kindx doctor`, `/ready`) but not quality.
- `engine/session.ts` (`KindxSession`) holds per-connection state — the
  embedding cache, abort signal, query log — in memory only. Once the
  process exits, the agent's context decisions are gone.
- Evaluation lives entirely under `specs/`:
  `specs/evaluation-harness.ts`, `specs/evaluation.test.ts`,
  `specs/evaluation-bm25.test.ts` cover 24 hand-curated queries with
  Hit@k. They run only in CI, against the test corpus. There is no way
  to eval the user's real index, compare runs, gate a deploy on a
  delta, or A/B a profile change.
- There is no UI. Consumers of metrics are Prometheus scrapers and
  whatever the operator builds.

`BENCHMARKS.md` numbers (Hit@3 / p50 / throughput on MS MARCO and
DBpedia at 1000 docs) come from `tooling/benchmark_*.ts` scripts that
run ad-hoc, print a Markdown table, and exit. They are not queryable and
not comparable across versions except by `git diff BENCHMARKS.md`.

For an agent operator using KINDX as the retrieval substrate behind a
tool loop, neither what KINDX returned nor what the agent's context
window held at the moment of the call is recoverable. This roadmap
closes that gap with persisted query traces, persisted context-window
snapshots, first-class eval runs, comparison with statistical
significance, deterministic replay, and a local-first dashboard SPA —
all served from the existing daemon, all on disk in the existing SQLite
DB, all reachable from CLI / MCP / HTTP with the same Bearer-token auth.

## Why now in 2026

Three forces:

1. **Agentic RAG is the default integration shape.** Coding agents, IDE
   plugins, terminal copilots, and research assistants treat KINDX as a
   tool in a loop. When an agent misfires, the operator's first
   question is "what was in the model's context at that moment?" KINDX
   must answer that without the operator having to instrument it.

2. **Eval has replaced anecdote as the gate.** "Looks better on my
   queries" no longer ships. Golden sets, BEIR-style datasets, and
   operator-supplied custom sets are table-stakes. CI specs are not a
   deploy gate and cannot answer "did `--profile=fast` regress nDCG@10
   on the user's corpus?".

3. **Local-first privacy is a competitive moat.** LangSmith, Arize,
   Phoenix, Honeycomb all require shipping traces off the box. KINDX
   users adopted KINDX precisely because their notes never leave the
   laptop. A local-only, offline, on-disk observability layer is only
   possible because KINDX is already local-first. Doing it now
   establishes the moat before someone else does.

Shipping observability and evals together in one release avoids two
schema migrations and two rounds of doc churn.

## Competitive gap

What ships today, and where each tool fails the KINDX user.

- **Chroma.** Cloud telemetry only; local Chroma exposes minimal
  metrics. No trace replay, no eval. Loses on: privacy, reproducibility,
  eval as a verb.
- **Qdrant.** Strong server-grade perf metrics, Cloud dashboard. No
  context-window capture (out of scope — vector store, not retrieval
  engine). No eval. Loses on: retrieval-pipeline spans, evals.
- **Weaviate.** Verbose `?include=…` explain plus Cloud Console. No
  persisted trace store, no replay, no context capture. Loses on:
  replay determinism, local-first.
- **LanceDB.** Local-first storage, but you build observability
  yourself. Loses on: traces, evals, dashboard.
- **LangSmith.** Best-in-class agent UI but cloud-default; self-hosted
  SKU is enterprise-priced and requires Postgres + Redis + ClickHouse.
  Generic LLM call tree, not retrieval-aware. Loses on: local-first,
  retrieval spans, zero-dependency install.
- **Arize Phoenix.** Closest analog — open-source, runs locally — but
  it is a generic OTLP collector that does not understand RRF, rerank,
  or hybrid retrieval. Dataset/eval surface is LLM-centric. Loses on:
  retrieval-domain modeling, SQLite-native storage (uses Postgres or
  DuckDB).
- **LlamaIndex evals.** Notebook-only; no persistence, comparison,
  significance, or replay. Loses on: production workflow.
- **Honeycomb / Datadog / Grafana Tempo.** Generic APM, cloud-default,
  no notion of a "rerank stage." Loses on: domain modeling, local-first.

The gap is not "nobody does observability." The gap is: nobody does
*retrieval-aware, local-first, evaluation-coupled* observability with
an on-disk format an agent can read back. That is the slot KINDX takes.

## KINDX opportunity

The moat in one claim:

> KINDX produces a measurable, reproducible, on-disk, agent-readable
> observability record for every retrieval call, with no cloud dependency
> and no separate service to run.

Three defensible properties:

1. **Measurable.** Every span has a known schema. Every eval run yields
   `Hit@k`, `MRR`, `nDCG@k`, `Recall@k`, p50/p95 latency, token cost,
   degraded-mode rate. Operators can write SQL against `eval_runs`.
2. **Reproducible.** Stored traces can be replayed against the current
   build. Identical input + pinned model + pinned config + pinned index
   revision yields byte-identical chunk IDs. Rerank score deltas
   (non-deterministic GGUF) are surfaced explicitly by
   `trace replay --diff`.
3. **On-disk, agent-readable.** Traces and snapshots live in the same
   SQLite file as everything else, exposed by the same Zod schemas in
   `packages/kindx-schemas/src/index.ts` and the same typed client in
   `packages/kindx-client/src/index.ts`. An agent over MCP can inspect
   its own previous-turn context. Structurally impossible with cloud
   products.

## User stories

1. **Agent operator**: after a bad retrieval call, fetch the exact
   context window the agent had so I can isolate the bug to agent vs
   profile vs corpus.
2. **Retrieval engineer**: tune RRF or swap the reranker, run eval on
   my real index, compare to baseline with a p-value, merge on data
   not vibes.
3. **Release engineer**: gate releases on the bundled golden-set eval
   across `fast | balanced | max_precision`; reject if Hit@3 drops
   more than 0.5%.
4. **SRE**: when "search got slow this afternoon", open the dashboard,
   filter the time range, sort by total latency, see which span
   dominated, name the cause in under a minute.
5. **Privacy-conscious user**: one-command delete of all traces and
   snapshots older than N days, with a guarantee nothing leaves my
   machine.
6. **Autonomous coding agent**: after a tool call, invoke
   `context.inspect` to read back its own context window in structured
   form and decide whether to expand the query.
7. **Researcher**: run my own BEIR-style dataset, export per-query
   metrics as JSON, reproduce paper results.
8. **Docs maintainer**: regenerate `BENCHMARKS.md` from the latest
   baseline run so the doc never drifts from reality.
9. **Small-team operator**: open the dashboard at
   `http://127.0.0.1:8181/ui/` and share it over Tailscale with no
   external setup.
10. **Downstream client developer (`packages/kindx-client`)**: typed
    methods with Zod-validated responses for every new surface — no
    hand-rolled fetch.

## Proposed UX

Operator suspects `--profile=fast` is too aggressive on their corpus
and wants to compare it to `balanced`.

```bash
# 1. Baseline run.
kindx eval run --dataset bundled-golden --profile balanced --tag run=baseline
# -> er_2026_05_22_baseline_8a1c
kindx eval baseline set er_2026_05_22_baseline_8a1c

# 2. Candidate run.
kindx eval run --dataset bundled-golden --profile fast --tag run=fast-candidate
# -> er_2026_05_22_fast_d4e2

# 3. Compare (deltas, p-values, per-query winners, verdict to stdout).
kindx eval compare er_2026_05_22_baseline_8a1c er_2026_05_22_fast_d4e2 --threshold 0.01

# 4. Inspect a regression and its trace.
kindx eval show er_2026_05_22_fast_d4e2 --per-query --json \
  | jq '.items[] | select(.delta_hit_at_3 < 0)'
kindx trace show tr_2026_05_22_xyz --spans --context

# 5. Replay against current build; open dashboard.
kindx trace replay tr_2026_05_22_xyz --diff
kindx dashboard --open
```

Agent reading its own context window via MCP:

```jsonc
// call
{ "tool":"context.inspect", "input":{ "scope":"last", "session":"sess_abc" } }
// returns
{ "snapshot_id":"cs_2026_05_22_q1", "trace_id":"tr_2026_05_22_xyz",
  "token_budget":8192, "tokens_used":6113,
  "system_prompt_id":"sp_default_v3",
  "tool_definitions":[ /* ... */ ],
  "retrieved_chunks":[ /* 12 chunks */ ],
  "memory_pulled":[ /* ... */ ] }
```

Dashboard pages at `http://127.0.0.1:8181/ui/`:

- Traces table — filter by tool, profile, session, time range.
- Trace detail — span waterfall, context payload, retrieved-chunk diff
  against gold (if this trace belonged to an eval).
- Eval runs table; eval run detail (per-query metrics, score histogram).
- Compare view — side-by-side runs, per-metric delta bars, per-query
  winners.
- Latency view — span-kind histograms over time.
- Cost view — token totals by run / tool / profile.

No external CDN. SPA shipped from `engine/dashboard/spa/dist/`, gzipped.
Same Bearer-token auth.

## CLI design

New CLI commands extend `engine/kindx.ts`. All support `--json` and
inherit `--csv` / `--md` / `--xml` where tabular. All write to the
same SQLite DB.

```text
kindx eval
  ├── run        Run an eval against a dataset and persist results.
  ├── list       List eval runs.
  ├── show       Show one eval run.
  ├── compare    Compare two eval runs.
  └── baseline   Get/set/clear the baseline eval run.

kindx trace
  ├── show       Show a trace (spans, context payload).
  ├── replay     Re-run a trace against the current build.
  ├── export     Export a trace as JSON.
  └── list       List traces.

kindx context
  └── inspect    Show the most recent context-window snapshot for a session.

kindx dashboard  Start (or attach to) the local dashboard SPA at /ui/.
```

Flag surface:

```bash
kindx eval run --dataset <name|path> [--profile fast|balanced|max_precision]
               [--limit N] [--out <file>] [--json] [--baseline <run-id>]
               [--tag k=v]... [--concurrency N=1] [--seed N=0] [--no-progress]

kindx eval list [--json] [--since <ISO>] [--until <ISO>] [--tag k=v]...
                [--dataset <name>] [--profile <name>] [--limit N=50]

kindx eval show <run-id> [--per-query] [--json] [--include-traces]

kindx eval compare <run-a> <run-b> [--json] [--threshold 0.05]
                   [--metric hit@3|mrr|ndcg@10|recall@10|latency_p50]
                   [--per-query]

kindx eval baseline (set|get|clear) [<run-id>]
  # set <id>: pin baseline; get: print current; clear: unset

kindx trace show <trace-id> [--spans] [--context] [--json]
kindx trace replay <trace-id> [--json] [--diff]
kindx trace export <trace-id> [--out trace.json] [--redact]
kindx trace list [--since <ISO>] [--until <ISO>] [--tool <name>]
                 [--profile <name>] [--session <id>] [--limit N] [--json]

kindx context inspect [--session <id>] [--last] [--snapshot <id>] [--json]

kindx dashboard [--port 8181] [--bind 127.0.0.1] [--open]
                [--token <token>] [--read-only]
```

Backward compatibility: existing verbs untouched; the dispatcher in
`engine/kindx.ts` only appends. `--json` is stable per verb and
documented in `docs/cli.md`. `kindx <verb> --help` is generated from
the Zod input schemas so help never drifts from runtime.

## MCP design

Tools register via append-only `engine/tool-registry.ts` (no
conflicts with other branches). Each tool has Zod-validated input and
output. All idempotent except `eval.run`, which is keyed by a
client-supplied idempotency token for retry safety.

### `eval.run`

```ts
const EvalRunInput = z.object({
  dataset: z.string().min(1),               // bundled name OR absolute path
  profile: z.enum(["fast", "balanced", "max_precision"]).default("balanced"),
  limit: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().max(8).default(1),
  seed: z.number().int().nonnegative().default(0),
  tags: z.record(z.string()).default({}),
  idempotency_key: z.string().uuid().optional(),
});

const EvalRunOutput = z.object({
  run_id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  metrics: EvalMetricsSchema.optional(),
});
```

Error codes: `E_EVAL_DATASET_NOT_FOUND`, `E_EVAL_PROFILE_UNKNOWN`,
`E_EVAL_BUSY` (another run already executing — only one concurrent run is
allowed to avoid index thrash), `E_EVAL_CANCELLED`.

### `eval.list`, `eval.show`

```ts
const EvalListInput = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  dataset: z.string().optional(),
  profile: z.string().optional(),
  tags: z.record(z.string()).optional(),
  limit: z.number().int().max(500).default(50),
  cursor: z.string().optional(),
});
const EvalListOutput = z.object({
  runs: z.array(EvalRunSummarySchema),
  next_cursor: z.string().nullable(),
});

const EvalShowInput = z.object({
  run_id: z.string(),
  per_query: z.boolean().default(false),
  include_traces: z.boolean().default(false),
});
const EvalShowOutput = z.object({
  run: EvalRunSchema,
  items: z.array(EvalRunItemSchema).optional(),
});
```

### `eval.compare`

```ts
const EvalCompareInput = z.object({
  run_a: z.string(),
  run_b: z.string(),
  threshold: z.number().min(0).max(1).default(0.01),
  metric: z.enum(["hit@3","hit@10","mrr","ndcg@10","recall@10",
                  "latency_p50","latency_p95","token_cost"]).optional(),
});

const EvalCompareOutput = z.object({
  deltas: z.record(z.number()),                  // metric -> delta
  p_values: z.record(z.number()),                // metric -> p-value
  verdict: z.enum(["a_wins","b_wins","tie","inconclusive"]),
  per_query: z.array(z.object({
    q_id: z.string(),
    delta_hit_at_3: z.number(),
    delta_ndcg_at_10: z.number(),
    winner: z.enum(["a","b","tie"]),
  })).optional(),
});
```

The significance test is a paired bootstrap on the per-query metric vectors
with 10 000 resamples. Implementation in `engine/evals/compare.ts`.

### `eval.baseline`, `trace.get`, `trace.list`

```ts
const EvalBaselineInput = z.object({
  op: z.enum(["set","get","clear"]),
  run_id: z.string().optional(),
});
const EvalBaselineOutput = z.object({ baseline_run_id: z.string().nullable() });

const TraceGetInput = z.object({
  trace_id: z.string(),
  include_spans: z.boolean().default(true),
  include_context: z.boolean().default(false),
});
const TraceGetOutput = z.object({
  trace: QueryTraceSchema,
  spans: z.array(QuerySpanSchema).optional(),
  context: ContextSnapshotSchema.optional(),
});

const TraceListInput = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  tool: z.string().optional(),
  profile: z.string().optional(),
  session: z.string().optional(),
  limit: z.number().int().max(500).default(100),
  cursor: z.string().optional(),
});
const TraceListOutput = z.object({
  traces: z.array(QueryTraceSummarySchema),
  next_cursor: z.string().nullable(),
});
```

### `trace.replay`, `trace.export`

```ts
const TraceReplayInput = z.object({
  trace_id: z.string(),
  diff: z.boolean().default(true),
});
const TraceReplayOutput = z.object({
  new_trace_id: z.string(),
  identical_chunk_ids: z.boolean(),
  identical_top1: z.boolean(),
  rerank_score_delta: z.number().nullable(),
  notes: z.array(z.string()),
});

const TraceExportInput = z.object({
  trace_id: z.string(),
  redact: z.boolean().default(false),
});
const TraceExportOutput = z.object({
  format_version: z.literal(1),
  trace: QueryTraceSchema,
  spans: z.array(QuerySpanSchema),
  context: ContextSnapshotSchema.nullable(),
});
```

### `context.inspect`, `context.snapshot.list`

```ts
const ContextInspectInput = z.object({
  scope: z.enum(["last","by_session","by_id"]).default("last"),
  session: z.string().optional(),
  snapshot_id: z.string().optional(),
});
const ContextInspectOutput = z.object({ snapshot: ContextSnapshotSchema.nullable() });

const ContextSnapshotListInput = z.object({
  session: z.string().optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().max(500).default(100),
});
const ContextSnapshotListOutput = z.object({
  snapshots: z.array(ContextSnapshotSummarySchema),
});
```

### Idempotency, pagination, error codes

- `eval.run` accepts `idempotency_key`; duplicate calls within 24h with the
  same key return the original `run_id` without restarting.
- All list endpoints use opaque `cursor` strings (base64 of
  `(started_at, id)` pair). The cursor is stable across calls.
- Error codes are namespaced: `E_EVAL_*`, `E_TRACE_*`, `E_CONTEXT_*`.
- Unknown error -> `E_INTERNAL`. Bad input -> `E_BAD_INPUT`. Not found ->
  `E_NOT_FOUND`.

## HTTP API design

The HTTP daemon (today serves `/ready`, `/metrics`, MCP transport) gains
new REST routes and a static SPA mount. Routes inherit Bearer-token
auth; unauthenticated requests get 401. Optional `engine/rbac.ts` hook
is consulted if configured.

```text
POST   /eval/runs                  → start a run
GET    /eval/runs                  → list runs
GET    /eval/runs/:id              → fetch one run
POST   /eval/runs/:id/cancel       → cancel a running eval
GET    /eval/runs/:id/stream       → SSE stream of per-query progress
POST   /eval/compare               → body: { run_a, run_b, threshold, metric }
GET    /eval/baseline              → current baseline
PUT    /eval/baseline              → body: { run_id }  (idempotent)
DELETE /eval/baseline              → clear

GET    /traces                     → list traces (filters via querystring)
GET    /traces/:id                 → trace + spans + optional context
POST   /traces/:id/replay          → body: { diff: true }
GET    /traces/:id/export          → download as JSON file

GET    /context/snapshots          → list
GET    /context/snapshots/:id      → one snapshot

GET    /ui/                        → SPA index.html
GET    /ui/assets/*                → static SPA assets

GET    /metrics                    → unchanged Prometheus surface
```

### Request / response shapes

`POST /eval/runs` (request → response):

```json
{ "dataset":"bundled-golden", "profile":"balanced", "limit":100,
  "tags":{ "release":"1.4.0-rc1" }, "idempotency_key":"f3a4..." }
```
```json
{ "run_id":"er_2026_05_22_d4e2", "status":"running",
  "started_at":"2026-05-22T14:11:09.122Z" }
```

`GET /eval/runs/er_2026_05_22_d4e2`:

```json
{
  "id": "er_2026_05_22_d4e2",
  "dataset": "bundled-golden",
  "profile": "balanced",
  "status": "completed",
  "started_at": "2026-05-22T14:11:09.122Z",
  "finished_at": "2026-05-22T14:11:43.001Z",
  "metrics": {
    "hit_at_3": 0.834,
    "hit_at_10": 0.917,
    "mrr": 0.712,
    "ndcg_at_10": 0.781,
    "recall_at_10": 0.844,
    "latency_p50_ms": 41,
    "latency_p95_ms": 132,
    "token_cost": 18420,
    "degraded_mode_rate": 0.0
  },
  "baseline_id": "er_2026_05_22_8a1c",
  "tags": { "release": "1.4.0-rc1" },
  "build_sha": "53489504"
}
```

`POST /eval/compare`:

```json
{ "run_a": "er_...8a1c", "run_b": "er_...d4e2", "threshold": 0.01 }
```

```json
{
  "deltas": { "hit_at_3": 0.014, "ndcg_at_10": -0.003, "latency_p95_ms": -8 },
  "p_values": { "hit_at_3": 0.021, "ndcg_at_10": 0.42 },
  "verdict": "b_wins",
  "regressions": [],
  "improvements": [ "hit_at_3" ]
}
```

`GET /traces/tr_xyz`:

```json
{
  "id": "tr_2026_05_22_xyz",
  "started_at": "2026-05-22T14:09:11.001Z",
  "finished_at": "2026-05-22T14:09:11.057Z",
  "tool": "search.hybrid",
  "profile": "balanced",
  "session_scope": "sess_abc",
  "input": { "query": "how does the rerank queue throttle?" },
  "output_summary": { "top_chunk_ids": ["c_001","c_037","c_119"] },
  "spans": [
    { "span_id":"s1","parent_span_id":null,"kind":"expansion",
      "duration_ms":3,"attrs":{ "expanded":["throttle","queue depth"] } },
    { "span_id":"s2","parent_span_id":"s1","kind":"embedding",
      "duration_ms":12,"attrs":{ "model":"bge-small","cache":"miss" } },
    { "span_id":"s3","parent_span_id":"s1","kind":"retrieval",
      "duration_ms":9,"attrs":{ "bm25_n":50,"vector_n":50 } },
    { "span_id":"s4","parent_span_id":"s3","kind":"fusion",
      "duration_ms":1,"attrs":{ "rrf_k":60 } },
    { "span_id":"s5","parent_span_id":"s4","kind":"rerank",
      "duration_ms":28,"attrs":{ "model":"bge-reranker-v2","queue_depth":2 } },
    { "span_id":"s6","parent_span_id":"s5","kind":"render",
      "duration_ms":2,"attrs":{ "format":"json" } }
  ]
}
```

`GET /eval/runs/:id/stream` (SSE):

```text
event: item
data: {"q_id":"q_001","metrics":{"hit_at_3":1,"reciprocal_rank":1.0}}

event: progress
data: {"completed":12,"total":24}

event: done
data: {"run_id":"er_..d4e2","status":"completed"}
```

### Auth, rate limits, RBAC, CORS

- `Authorization: Bearer <KINDX_TOKEN>` reuses the existing middleware;
  `KINDX_LOCAL_NO_AUTH=true` keeps current localhost behavior.
- `eval.run` hard-capped at 1 concurrent run/daemon. Read endpoints
  share the per-token bucket. Replay shares the `search.hybrid` bucket.
- If RBAC is configured: new routes consume `read:traces`,
  `write:evals`, `read:evals`, `read:context`. Default policy grants
  all to the local user.
- SPA is same-origin with the API; no CORS preflight; cross-origin
  refused.

## Schema changes

Additive exports in `packages/kindx-schemas/src/index.ts`. No existing
export renamed or removed.

```ts
// packages/kindx-schemas/src/index.ts (additions)

export const SpanKindSchema = z.enum([
  "expansion","embedding","retrieval","fusion","rerank","render",
  "memory_pull","tool_call","llm_call","ingest","other",
]);

export const QuerySpanSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  kind: SpanKindSchema,
  started_at: z.number().int(),       // ms epoch
  duration_ms: z.number().int(),
  attrs: z.record(z.any()),
});

export const QueryTraceSchema = z.object({
  id: z.string(),
  started_at: z.number().int(),
  finished_at: z.number().int(),
  tool: z.string(),
  profile: z.string().nullable(),
  session_scope: z.string().nullable(),
  tenant_hash: z.string().nullable(),
  input: z.any(),
  output_summary: z.any(),
  redacted: z.boolean(),
});

export const QueryTraceSummarySchema = QueryTraceSchema.pick({
  id: true, started_at: true, finished_at: true, tool: true, profile: true,
});

export const ContextSnapshotSchema = z.object({
  id: z.string(),
  trace_id: z.string().nullable(),
  session_id: z.string(),
  taken_at: z.number().int(),
  token_budget: z.number().int(),
  tokens_used: z.number().int(),
  system_prompt_id: z.string().nullable(),
  retrieved_chunks: z.array(z.object({
    chunk_id: z.string(),
    score: z.number(),
    text_redacted: z.boolean(),
    text: z.string().nullable(),
  })),
  memory_pulled: z.array(z.object({
    memory_id: z.string(),
    text_redacted: z.boolean(),
    text: z.string().nullable(),
  })),
  tool_definitions: z.array(z.object({
    name: z.string(),
    schema_hash: z.string(),
  })),
  redacted: z.boolean(),
});

export const ContextSnapshotSummarySchema = ContextSnapshotSchema.pick({
  id: true, trace_id: true, session_id: true, taken_at: true,
  token_budget: true, tokens_used: true,
});

export const EvalMetricsSchema = z.object({
  hit_at_3: z.number(),
  hit_at_10: z.number(),
  mrr: z.number(),
  ndcg_at_10: z.number(),
  recall_at_10: z.number(),
  latency_p50_ms: z.number(),
  latency_p95_ms: z.number(),
  token_cost: z.number(),
  degraded_mode_rate: z.number(),
});

export const EvalRunSchema = z.object({
  id: z.string(),
  dataset: z.string(),
  profile: z.string(),
  status: z.enum(["queued","running","completed","failed","cancelled"]),
  started_at: z.number().int(),
  finished_at: z.number().int().nullable(),
  metrics: EvalMetricsSchema.nullable(),
  baseline_id: z.string().nullable(),
  tags: z.record(z.string()),
  build_sha: z.string(),
});

export const EvalRunSummarySchema = EvalRunSchema.pick({
  id: true, dataset: true, profile: true, status: true,
  started_at: true, finished_at: true,
});

export const EvalRunItemSchema = z.object({
  run_id: z.string(),
  q_id: z.string(),
  gold: z.any(),
  predicted: z.any(),
  metrics: z.object({
    hit_at_3: z.number(),
    hit_at_10: z.number(),
    reciprocal_rank: z.number(),
    ndcg_at_10: z.number(),
    recall_at_10: z.number(),
    latency_ms: z.number(),
  }),
  trace_id: z.string().nullable(),
});
```

All schemas are forward-compatible (`z.object` not `.strict`); new
fields land with optional defaults.

## Storage / index changes

One SQLite file managed by `engine/schema.ts`; forward-only
`user_version` at `engine/utils/schema-version.ts`
(`KINDX_SCHEMA_VERSION = 1` today). Bump to **2**; add
`engine/migrations/002_observability.sql`.

```sql
-- 002_observability.sql

CREATE TABLE IF NOT EXISTS query_traces (
  id              TEXT PRIMARY KEY,
  started_at      INTEGER NOT NULL,         -- ms epoch
  finished_at     INTEGER NOT NULL,
  tool            TEXT    NOT NULL,
  profile         TEXT,
  session_scope   TEXT,
  tenant_hash     TEXT,                     -- SHA-256 of tenant id, never raw
  input_json      TEXT    NOT NULL,
  output_summary_json TEXT NOT NULL,
  redacted        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_query_traces_started_at
  ON query_traces(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_traces_tool      ON query_traces(tool);
CREATE INDEX IF NOT EXISTS idx_query_traces_profile   ON query_traces(profile);
CREATE INDEX IF NOT EXISTS idx_query_traces_session   ON query_traces(session_scope);

CREATE TABLE IF NOT EXISTS query_spans (
  trace_id        TEXT    NOT NULL,
  span_id         TEXT    NOT NULL,
  parent_span_id  TEXT,
  kind            TEXT    NOT NULL,
  started_at      INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  attrs_json      TEXT    NOT NULL,
  PRIMARY KEY (trace_id, span_id),
  FOREIGN KEY (trace_id) REFERENCES query_traces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_query_spans_trace ON query_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_query_spans_kind  ON query_spans(kind);

CREATE TABLE IF NOT EXISTS eval_runs (
  id              TEXT PRIMARY KEY,
  dataset         TEXT    NOT NULL,
  profile         TEXT    NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT    NOT NULL,         -- queued|running|completed|failed|cancelled
  metrics_json    TEXT,
  baseline_id     TEXT,
  tags_json       TEXT    NOT NULL DEFAULT '{}',
  build_sha       TEXT    NOT NULL,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_started_at ON eval_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_dataset    ON eval_runs(dataset);
CREATE INDEX IF NOT EXISTS idx_eval_runs_status     ON eval_runs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_runs_idempotency
  ON eval_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS eval_run_items (
  run_id          TEXT    NOT NULL,
  q_id            TEXT    NOT NULL,
  gold_json       TEXT    NOT NULL,
  predicted_json  TEXT    NOT NULL,
  metrics_json    TEXT    NOT NULL,
  trace_id        TEXT,
  PRIMARY KEY (run_id, q_id),
  FOREIGN KEY (run_id)   REFERENCES eval_runs(id)    ON DELETE CASCADE,
  FOREIGN KEY (trace_id) REFERENCES query_traces(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS context_window_snapshots (
  id              TEXT PRIMARY KEY,
  trace_id        TEXT,
  session_id      TEXT    NOT NULL,
  taken_at        INTEGER NOT NULL,
  token_budget    INTEGER NOT NULL,
  tokens_used     INTEGER NOT NULL,
  payload_json    TEXT    NOT NULL,
  redacted        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (trace_id) REFERENCES query_traces(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ctx_snap_taken_at ON context_window_snapshots(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_ctx_snap_session  ON context_window_snapshots(session_id);

CREATE TABLE IF NOT EXISTS eval_baseline (
  scope           TEXT PRIMARY KEY DEFAULT 'global',
  run_id          TEXT NOT NULL,
  set_at          INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
);
```

Retention. A 6h background sweep deletes rows older than
`KINDX_TRACE_RETENTION_DAYS` (default 30) from `query_traces`,
`query_spans`, `context_window_snapshots`. `eval_runs` are kept
indefinitely (small) unless `KINDX_EVAL_RETENTION_DAYS` is set. Both
bounds = 0 means "never purge". Implemented in
`engine/observability/store.ts`; also `kindx admin observability purge
--dry-run`.

Storage budget. `input_json`, `output_summary_json` capped at 64 KiB;
snapshot `payload_json` at 256 KiB; per-span `attrs_json` at 4 KiB.
Enforced at write time with a deterministic truncation marker;
configurable via `KINDX_TRACE_MAX_*`.

Index revision pinning. `output_summary_json.index_rev` stored on each
trace so replay detects index drift and downgrades the determinism
claim.

## Implementation plan

Six phases. Each phase ships as its own PR onto `feat/context-observability-evals`.

### Phase 1 — Data model + migration (~1.5d)

- Land `engine/migrations/002_observability.sql`.
- Bump `KINDX_SCHEMA_VERSION` 1 → 2 in `engine/utils/schema-version.ts`.
- Implement `engine/observability/store.ts` with prepared-statement
  helpers for the five tables.
- Implement retention sweep on the daemon scheduler.
- Accept: idempotent migration; doctor lists new tables; no behavior
  change.

### Phase 2 — Instrumentation hooks (~3d)

- Implement `engine/observability/traces.ts` (lifecycle) and
  `engine/observability/spans.ts` (parent-linked emission).
- Edit `engine/repository/retrieval/{hybrid,rerank,expansion,rrf,vector-query}.ts`
  to wrap each pipeline stage in a span. Existing `explain` is
  unchanged; spans always emit.
- Edit `engine/session.ts` to snapshot context on every tool response
  that carries retrieved chunks.
- Edit `engine/utils/metrics.ts` to keep Prometheus histograms accurate
  from the same span timings.
- Accept: span overhead <2 ms p95 on bundled golden set
  (`tooling/benchmark_warm_daemon.ts`). CI gate.

### Phase 3 — Eval runner (~3d)

- `engine/evals/datasets.ts` — loaders for bundled-golden (24 queries
  lifted from `specs/evaluation-harness.ts`), MS MARCO TSV, BEIR JSONL,
  custom JSONL `{q_id, query, gold_chunk_ids[]}`.
- `engine/evals/metrics.ts` — Hit@k, MRR, nDCG@k, Recall@k, percentiles,
  token cost.
- `engine/evals/runner.ts` — sequential loop, real hybrid queries,
  one trace per query, abort-aware, one `eval_run_items` row per query.
- `engine/evals/compare.ts` — paired bootstrap significance.
- Accept: bundled golden metrics within ±1% of `BENCHMARKS.md`.

### Phase 4 — CLI / MCP / HTTP (~2.5d)

- New CLI verbs in `engine/kindx.ts` as thin wrappers over
  `engine/evals/*` and `engine/observability/*`.
- MCP tools via append-only `engine/tool-registry.ts` (never direct edit
  of `engine/protocol.ts`).
- HTTP routes in `engine/dashboard/server.ts` mounted on the existing
  daemon router.
- Typed methods in `packages/kindx-client/src/index.ts`.
- Accept: `--json` round-trips through Zod with zero `any`; client
  tests pass.

### Phase 5 — Dashboard SPA (~4d)

- Vite + Preact bundle under `engine/dashboard/spa/`. Hash-routed.
  Fonts/icons embedded. No CDN.
- Pages: Traces list, Trace detail, Runs list, Run detail, Compare,
  Latency, Cost.
- Build emits `dist/{index.html, assets/*.js, assets/*.css}`, gzipped;
  static-asset middleware serves from `dist/`.
- Accept: <200 KB gzipped; 1000-row table <500 ms; passes XSS test.

### Phase 6 — Docs + default flip (~1.5d)

- Regenerate `BENCHMARKS.md` from the bundled baseline run.
- Update `docs/cli.md`; 5-line dashboard section in `README.md`.
- Flip `KINDX_TRACE_ENABLED` default `false` → `true`. Only
  behavior-visible change.
- Accept: fresh install produces traces; doctor reports dashboard URL.

Total: ~15.5 engineering days including buffer.

## File-by-file changes

### New files

- `engine/observability/traces.ts` — trace lifecycle:
  `startTrace`, `finishTrace`, `recordTrace`. IDs `tr_<yyyymmdd>_<short>`.
- `engine/observability/spans.ts` — `startSpan(trace, kind, parent?)`,
  `endSpan(span, attrs)`. Monotonic `performance.now()`.
- `engine/observability/context-snapshots.ts` — `captureSnapshot`;
  redaction.
- `engine/observability/store.ts` — prepared statements for
  `query_traces`, `query_spans`, `context_window_snapshots`; retention
  sweep.
- `engine/observability/redaction.ts` — regex + deterministic hash
  replacement when `redacted=true`.
- `engine/evals/runner.ts` — sequential eval loop, abort, idempotency,
  trace linkage.
- `engine/evals/datasets.ts` — bundled-golden, MS MARCO, BEIR, JSONL.
- `engine/evals/metrics.ts` — pure `hitAtK`, `mrr`, `ndcgAtK`,
  `recallAtK`, percentile.
- `engine/evals/compare.ts` — paired bootstrap significance.
- `engine/evals/store.ts` — prepared statements for `eval_runs`,
  `eval_run_items`, `eval_baseline`.
- `engine/dashboard/server.ts` — routes for `/eval/*`, `/traces/*`,
  `/context/*`, `/ui/*`; SSE.
- `engine/dashboard/spa/` — Vite + Preact source.
- `engine/dashboard/spa/dist/` — build output, committed (no Node
  build tools at install).
- `engine/migrations/002_observability.sql` — as above.

### Edited files

- `engine/repository/retrieval/hybrid.ts` — wrap each stage in a span;
  pass `traceId`; `explain` unchanged.
- `engine/repository/retrieval/rerank.ts` — spans with `queue_depth`,
  `model`, `cache_hit`.
- `engine/repository/retrieval/expansion.ts` — spans with
  `expanded_terms`.
- `engine/repository/retrieval/vector-query.ts` — spans with `model`,
  `cache`, `token_count`.
- `engine/repository/retrieval/rrf.ts` — spans with `rrf_k`,
  `n_candidates`.
- `engine/renderer.ts` — render spans.
- `engine/session.ts` — capture a snapshot per tool response with
  chunks.
- `engine/protocol.ts` — no direct edit; uses tool registry.
- `engine/tool-registry.ts` — append-only registration.
- `engine/kindx.ts` — append CLI verbs in dispatcher.
- `engine/utils/metrics.ts` — span timings push into existing
  histograms.
- `engine/utils/schema-version.ts` — bump 1 → 2.
- `engine/schema.ts` — load `002_observability.sql` on 1→2.
- `engine/health-checker.ts` — `tracesStore`, `evalsStore` in `/ready`.
- `engine/diagnostics.ts` — doctor reports trace count (24h),
  eval-runs count, baseline id, retention, dashboard URL.
- `packages/kindx-schemas/src/index.ts` — all new schemas.
- `packages/kindx-client/src/index.ts` — `evalRun`, `evalList`,
  `evalShow`, `evalCompare`, `evalBaseline{Get,Set,Clear}`, `traceGet`,
  `traceList`, `traceReplay`, `traceExport`, `contextInspect`,
  `contextSnapshotList`.

### New tests

- `specs/observability-traces.test.ts` — span order, parent linkage,
  JSON round-trip.
- `specs/observability-context-snapshots.test.ts` — capture from
  `KindxSession`; redaction toggles.
- `specs/observability-privacy-redaction.test.ts` — regex redaction;
  `--redact`; redactor idempotency.
- `specs/evals-runner.test.ts` — bundled-golden run; abort mid-run;
  idempotency-key dedup.
- `specs/evals-compare.test.ts` — bootstrap significance vs fixture.
- `specs/evals-datasets.test.ts` — MS MARCO / BEIR fixtures.
- `specs/trace-replay-determinism.test.ts` — same trace replayed
  twice, chunk-id set identical.
- `specs/dashboard-static.test.ts` — `/ui/` serves index;
  `/ui/assets/<file>` 200; XSS payload renders as text not DOM.
- `specs/observability-retention.test.ts` — sweep purges old rows;
  cascades to spans; preserves eval rows.

## Test plan

Coverage targets (Vitest):

- Statements: ≥85% on `engine/observability/**` and `engine/evals/**`.
- Branches: ≥80% on the same.
- Existing modules: no decrease.

Scenario matrix:

- **Span emission.** Each profile emits every span kind ≥ once; parent
  linkage well-formed (every non-root span has an existing parent in
  the same trace).
- **Span overhead.** Tracing on vs `KINDX_TRACE_ENABLED=false`: p95
  regresses ≤ 2 ms on bundled golden.
- **Redaction.** Trace stored with `redacted=true` round-trips through
  `trace export` without leaking free text; snapshot redaction strips
  `text` and sets `text_redacted: true`.
- **Idempotency.** `eval.run` with the same `idempotency_key` within
  24h returns the original `run_id` without restarting.
- **Replay determinism.** 10 bundled-golden traces:
  `identical_chunk_ids: true` on same build; `false` on tweaked profile.
- **Dashboard auth.** `/ui/`, `/traces`, `/eval/runs` return 401 when
  `KINDX_TOKEN` is set, 200 when not.
- **Dashboard XSS.** `<script>alert(1)</script>` stored verbatim in
  SQLite, rendered via SPA text-node sink (never `innerHTML`); DOM
  assertion in test.
- **Eval-run cancellation.** Run started + cancelled leaves
  `status=cancelled` and a finalized `finished_at`.
- **Retention purge.** Trace dated 60 days ago + default 30-day
  retention: row gone, cascading spans gone.
- **`--json` round-trip.** For every new CLI verb,
  `parse(JSON.stringify(run --json))` validates against the Zod schema.
- **Dataset loaders.** MS MARCO TSV with/without header; BEIR JSONL
  with malformed lines (skipped with warning); custom JSONL with
  duplicate `q_id` (rejected at load).

CI:

- `eval-baseline-guard` — runs `kindx eval run --dataset bundled-golden
  --profile balanced`; fails on Hit@3 drop >0.5% vs `BENCHMARKS.md`.
- `dashboard-bundle-size` — fails if
  `engine/dashboard/spa/dist/assets/*.js` exceeds 200 KB gzipped.

## Acceptance criteria

A reviewer approves only if all of the following hold on a clean
checkout.

1. Migrating an existing DB from `KINDX_SCHEMA_VERSION=1` to `=2`
   completes in <2 s on a 1 GB SQLite file with zero data loss.
2. Span instrumentation adds <2 ms p95 to hybrid query latency on the
   bundled golden set (`tooling/benchmark_warm_daemon.ts`).
3. Bundled-golden Hit@3 is within ±0.5% of pre-branch
   `BENCHMARKS.md`.
4. Dashboard renders a 1000-row traces table in <500 ms locally
   (Apple Silicon M-class or x86_64 with NVMe).
5. Dashboard bundle <200 KB gzipped, zero external network requests
   at runtime; enforced by `dashboard-bundle-size` CI job.
6. Every new CLI verb round-trips `--json` through Zod with zero `any`.
7. `trace replay` returns `identical_chunk_ids: true` for ≥95% of
   bundled traces on the same build; residual 5% is GGUF rerank score
   ties broken deterministically by chunk_id ascending.
8. `kindx doctor` reports trace count, eval count, baseline id, and
   dashboard URL.
9. Retention purge deletes rows older than
   `KINDX_TRACE_RETENTION_DAYS` on the next tick.
10. New MCP tools are reachable through `packages/kindx-client` with
    typed methods and Zod-validated responses.
11. `kindx trace export --redact` writes a JSON file with no free-text
    content — only redaction markers and structural metadata.
12. No existing `specs/` test regresses.

## Risks

- **Privacy: snapshots contain PII.** Notes, chat history, memory pulls
  land in `payload_json`. Mitigation: snapshots gated by
  `KINDX_CONTEXT_SNAPSHOT_ENABLED`; redaction regex defaults cover
  emails, phones, SSN-like, API keys; `kindx trace export --redact` is
  the supported export path; `kindx admin observability purge --before
  <date>` for hard delete. Documented in `docs/privacy.md`.
- **Storage growth.** ~3 MB/hour at 100 qpm. Mitigation: per-field caps,
  default 30-day retention, spans in a separate table, SQLite WAL.
- **Write amplification on hot queries.** One trace row, 5–10 span rows,
  optional snapshot per query. Mitigation: trace+span writes batched
  into one transaction at trace finalization; snapshots flushed on
  session close or every 60 s.
- **Dashboard XSS.** Trace inputs are user-controllable. Mitigation:
  ESLint rule in `engine/dashboard/spa/.eslintrc` bans `innerHTML`,
  `outerHTML`, `dangerouslySetInnerHTML`; test enforces.
- **Retention vs legal hold.** Mitigation: `KINDX_TRACE_LEGAL_HOLD=true`
  disables the sweep; doctor warns when both are set;
  `kindx admin observability legal-hold <traceId>` for per-row pinning
  (follow-up).
- **Determinism drift on replay.** GGUF non-determinism. Mitigation:
  replay never asserts score byte-equality, only chunk-id sets; reports
  `rerank_score_delta`.
- **Dashboard bundle bloat.** Mitigation: dashboard-bundle-size CI cap.
- **Concurrent eval runs thrashing the index.** Mitigation: hard-cap one
  concurrent eval per daemon via `E_EVAL_BUSY`.

## Non-goals

- **Cloud-hosted dashboard.** Local-only; reverse-proxy is the
  supported share path.
- **Multi-cluster trace stitching.** One trace lives in one SQLite file.
- **OTLP exporter parity.** Span schema is OTLP-shaped so this can land
  later additively; the exporter itself is not in this branch.
- **Synthetic eval-query generation.** Consumes datasets, does not
  generate them.
- **Auto-bisect of regressions.** `eval.compare` flags; it does not
  walk history.
- **Auth beyond Bearer.** No SSO/OAuth; single-tenant local-first
  preserved (the existing RBAC hook is honored if configured).

## Future extensions

- **OTLP exporter** (`engine/observability/otlp.ts`). Streams spans to
  any OTLP collector. Off by default. Local-first guarantee preserved.
- **RUM-style agent feedback.** `POST /traces/:id/feedback` records
  thumbs-up / thumbs-down with reason into a `trace_feedback` table;
  feeds eval gold curation.
- **Regression bisect.** Walk `build_sha` history when `eval compare`
  flags a regression, re-running at intermediate commits to localize.
- **Synthetic eval generation.** Local LLM mutates gold queries into
  paraphrases, hard negatives, multi-hop variants; operator reviews
  before promoting.
- **Live tail SSE.** `GET /traces/stream` for real-time dashboard tail.
- **Cost attribution by tenant.** Per-tenant cost / latency when
  `tenant_hash` is populated.
- **Differential privacy on exports.** `trace export --dp-epsilon` adds
  calibrated noise to numeric fields for third-party sharing.
- **Eval-as-CI on PR.** GH Action runs `kindx eval run` per PR, posts a
  delta comment, fails on regression past threshold.
- **Replay-from-dashboard.** Button on trace detail posts `trace.replay`
  and inlines the diff.

## Merge notes

Composes with four in-flight branches. Each has a defined conflict
surface and a mechanical resolution.

### `feat/provenance-trust-freshness`

Adds `provenance_score`, `trust_score`, `freshness_score` to retrieval
results. Conflict surface: `engine/repository/retrieval/hybrid.ts`
(result struct) and `packages/kindx-schemas/src/index.ts` (additive
fields). Resolution: span attrs absorb `provenance_score` without
schema change; both schemas are additive. Land that branch first; this
branch rebases.

### `feat/agent-workspace-memory-graph`

Adds memory-graph store and `memory.pull` MCP tool. Conflict surface:
`engine/tool-registry.ts` (both register tools) and `engine/session.ts`
(both record per-call state). Resolution: tool-registry is
append-only with non-overlapping names. Session edits are additive;
this branch's `memory_pulled` is populated from the memory-graph API
when present, empty otherwise.

### `feat/a2a-agent-interoperability`

Adds Agent-to-Agent (A2A) surface. Conflict surface:
`engine/protocol.ts` (transport handlers) and HTTP routes. Resolution:
A2A under `/a2a/*`, observability under `/eval/*`, `/traces/*`,
`/context/*`, `/ui/*`. No path collision. A2A can record inbound calls
as traces via `observability/traces.ts` (one-line addition).

### `feat/local-first-multimodal-ingestion`

Adds image/audio ingestion. Conflict surface:
`engine/repository/retrieval/hybrid.ts` (modality fields) and embedding
span attrs (model name varies by modality). Resolution: span attrs is
`z.record(z.any())` so modality attrs need no schema bump; hybrid edits
are line-adjacent on different fields — expect ~10 lines of manual
merge.

### Land order

1. `feat/provenance-trust-freshness`
2. `feat/local-first-multimodal-ingestion`
3. `feat/agent-workspace-memory-graph`
4. `feat/context-observability-evals` (this branch)
5. `feat/a2a-agent-interoperability`

This order keeps migrations forward-only. Reordering only costs a
one-line rebase on `tool-registry.ts` and an additive Zod field; both
mechanical.

### Release vehicle

Ships as part of KINDX **v1.4.0** alongside the four branches above.
Dashboard is the headline feature. `BENCHMARKS.md` is regenerated from
the bundled baseline eval in the release script; regenerated numbers
are reviewed against the committed baseline for any regression beyond
±0.5% Hit@3.
