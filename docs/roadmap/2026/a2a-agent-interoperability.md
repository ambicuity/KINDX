# A2A Agent Interoperability — Making KINDX a First-Class Google A2A Participant

## Branch

`feat/a2a-agent-interoperability`

Independent of the other four 2026 roadmap branches (memory-graph, provenance, observability, plugin-marketplace). May compose with them post-merge: federated graph queries layer over peer dispatch, provenance trust scoring consumes peer trust signals, observability adopts A2A task spans, marketplace can publish skill cards. None of those are prerequisites here.

## Owner type

Protocol/interop subsystem owner. Surface area spans HTTP routing, persistence (SQLite migration), policy enforcement (subagent-contract clamp), CLI ergonomics, MCP tool registration, and an outbound HTTP client with mTLS/Bearer auth. The work touches three of KINDX's existing seams — `engine/protocol.ts`, `engine/session.ts`, and `engine/tool-registry.ts` — but does not modify the retrieval, indexing, or ranking subsystems at all. A protocol owner with familiarity with the MCP 2025-06-18 wire format and Google's A2A spec lineage is the natural fit.

## Problem

KINDX v1.3.5 speaks one inter-process protocol fluently: MCP. It is an excellent **agent ↔ tool** citizen — it exports tools, accepts SSE streams, multiplexes HTTP sessions, and clamps every invocation under an internal subagent contract that supports `read-only` / `workspace-write` / `none` sandboxes and `none` / `restricted` / `default` network modes. What it does not do is talk to *other agents* as a peer. The internal `engine/subagent-contract.ts` machinery is purely in-process — there is no spawn-over-network, no agent card publication, no peer registry, no outbound HTTP A2A client, no `.well-known/agent.json`.

That is fine for a single-host install where one orchestrator drives KINDX and a handful of tools. It is **not** fine for the agent topology that emerged through late 2025 and is the dominant pattern in 2026: a knowledge-worker desktop runs a local orchestrator (Claude Code, Cursor agents, Gemini Code Assist, locally-pinned agents) that fan out work to specialist *agents* — a code-search agent, a memory-graph agent, a browser agent, a corporate-doc agent — using the **Agent-to-Agent (A2A)** protocol that Google open-sourced and that the broader Linux Foundation / OpenAgents working group ratified through 2025. The orchestrator does not know that KINDX is a tool; from the orchestrator's vantage, KINDX is *also* an agent, and refusing to publish an A2A surface excludes KINDX from any multi-agent deployment that prefers A2A's task-shaped lifecycle (queued → running → streaming → done/failed/cancelled with named artifacts) over MCP's tool-call shape.

The inverse direction matters even more. KINDX users in 2026 expect to be able to point KINDX at a remote A2A agent (a corporate vector-store agent, a peer KINDX instance running on a teammate's laptop, a hosted code-search agent) and have it dispatch tasks, stream results, and fold the responses back into local hybrid queries. Today there is no `kindx a2a peer add` and no outbound A2A client. The internal subagent-contract policy clamp — the very mechanism that makes KINDX's tool execution safe — never gets a chance to run on a remote dispatch because no remote dispatch exists.

This branch closes both sides of the gap. KINDX publishes an A2A agent card derived from its existing MCP tool registry, accepts inbound A2A tasks under `/a2a/v1/*`, supports SSE streaming for long-running skills, and exposes operator CLI/MCP affordances to register peers and dispatch outbound tasks. Every inbound and outbound task is routed through the same subagent-contract policy machinery the in-process subagent operations already use, so the security story is unchanged. The MCP surface remains untouched.

## Why now in 2026

Three forces converged.

**One**: The A2A protocol matured. Through the 2024–2025 cycle it stabilized around a small set of REST endpoints (`/.well-known/agent.json`, `/v1/messages`, `/v1/tasks`, `/v1/tasks/:id`, `/v1/tasks/:id/stream`), JSON-schema task input/output, SSE for streaming, and a Bearer-or-mTLS authentication model. The spec's `state_transition_history`, `push_notifications`, and `streaming` capability flags settled. By Q1 2026 the major implementations (Google's reference, the OpenAgents reference, the Anthropic-side proxies, the JetBrains agent gateway) interoperated at the agent-card and task-lifecycle level. Building against the protocol is no longer a bet — it is table stakes.

**Two**: The market split clarified. MCP definitively won the **agent ↔ tool** axis: every major model vendor ships an MCP client, and every halfway-serious developer tool (database adapters, IDE plugins, headless browsers, knowledge bases) ships an MCP server. A2A definitively won the **agent ↔ agent** axis: orchestrators delegate to specialist agents over A2A, not over MCP, because A2A's task-shaped lifecycle (multi-step, streaming, cancellable, artifact-producing) matches how agents actually compose. The two protocols are not competitive — they are layered. A serious agent-side product in 2026 must speak both. KINDX speaks one.

**Three**: KINDX's existing primitives line up unusually well with A2A. `KindxSession` already multiplexes HTTP sessions and has the bookkeeping required for inbound task lifecycle. `subagent-contract` already understands sandbox and network policy. `tool-registry` already enumerates tools with input/output Zod schemas. `audit.ts` already records tool invocations with tenant hashing. The cost of adding A2A is therefore not "build it from scratch" but "thread the existing primitives through five new files and a forward-only SQLite migration." A team-quarter, not a team-year.

If KINDX waits another two quarters, the cost rises. Orchestrators will have hard-coded their preferred set of A2A agents, peer registries will fill, and KINDX will be the strange tool-only entry that does not appear in `peer list` outputs. Catching the protocol while it is still being adopted is materially cheaper than retrofitting after.

## Competitive gap

The agent-interop space in early 2026 sorts into four buckets.

**MCP-only servers**. The vast majority — every database adapter, the headless browser servers, the filesystem servers, the vector-store servers. Excellent at being tools. Invisible to A2A orchestrators. Cannot be a peer. Cannot dispatch outbound. KINDX is currently in this bucket.

**A2A-only frameworks**. The Google reference agent, several startup orchestration platforms (the "agentic workflow" SaaS vendors), the corporate-doc agents shipped by a handful of enterprise vendors. They speak A2A natively, often beautifully, with task lifecycles and SSE and artifact handling. But they almost universally lack a *tool* surface — they cannot be called by Claude Code or Cursor as an MCP server. Adopting one means rebuilding the IDE/agent integration that MCP already gives you for free.

**Bridge tools** (the small set). A handful of projects shim A2A on top of MCP or vice versa. They tend to be (a) externally-hosted SaaS shims that defeat the local-first story, (b) one-way (MCP-as-A2A-skill but not the reverse), or (c) lacking any policy enforcement — the bridge accepts inbound A2A tasks and blindly forwards them to MCP tools with no sandbox, no RBAC, no rate limit. Operational reality has shown these bridges are the weak link in agent deployments: they have produced multiple incidents in 2025-Q4 and 2026-Q1 where an inbound task escalated to filesystem write because the bridge skipped the policy step.

**Cloud agent platforms**. Google's hosted offering, OpenAI's agent platform, the AWS/Azure agent runtimes. They speak both protocols, with good lifecycle and good auth, but they are not local-first — your data, your queries, and your tool invocations leave the host. For KINDX's core demographic (private corpora, regulated environments, individual devs on laptops) this is non-negotiable.

KINDX's position. A **local-first, governed, fully bidirectional** bridge. Inbound A2A tasks land in the same tool-registry that MCP uses, but the inbound path is policy-clamped through `subagent-contract` so the bridge cannot become a sandbox escape. Outbound A2A dispatch is constrained by a per-peer allow/deny skill list, network timeout, and concurrency cap. Audit log records every transition. The agent card is published from the local tool registry — there is no separate "what skills do I have" config that drifts from reality. None of this requires a cloud dependency; the optional remote piece is "other A2A agents you registered", which is opt-in and out-of-process. That combination does not exist in the bucket-three bridge tools today, and it differentiates KINDX from the cloud platforms by virtue of remaining local-first.

## KINDX opportunity

Because the inbound and outbound surfaces both reuse `subagent-contract`, every dollar invested in policy hardening (sandbox modes, network restrictions, RBAC) on the internal path pays off twice — once for local subagents, once for A2A peers. This is unusual for protocol bridges, which typically grow their own parallel policy layer that drifts.

The card-from-registry approach removes a category of config-drift bugs. The A2A skill list cannot lie about what KINDX exposes, because it is *derived* from the live tool-registry on startup; an override map exists only to *hide* tools or rename skills, never to invent them. That is the inverse of how the bucket-three bridges have configured themselves and it is a real differentiator at sales-meeting time.

Finally, the outbound peer registry creates a natural extension point for the other 2026 roadmap branches. The memory-graph branch can use peer dispatch to federate a graph query. The provenance branch can fold peer trust state into its trust scorer. The observability branch's traces can span A2A peer hops. Building peer-aware infrastructure now means those compositions are nearly free later.

### Detailed protocol semantics — what KINDX actually has to honor

A roadmap that hand-waves the protocol is a roadmap that produces a non-interoperable implementation. The following is the concrete set of A2A behaviors KINDX must match. Every item maps to a test in `specs/a2a-*` and/or an acceptance criterion below.

**Agent card content**. The card MUST be valid JSON, MUST declare `name`, `description`, `url`, `version`, `capabilities`, `authentication`, `default_input_modes`, `default_output_modes`, and `skills`. Each skill MUST declare `id`, `name`, `description`, `input_modes`, `output_modes`. Tags and examples are optional but encouraged; KINDX emits at least one example per skill, derived from the tool's example fixtures already present in `tool-registry`.

**Authentication negotiation**. The card's `authentication.schemes` array is honored in order — the first scheme the client supports wins. KINDX emits `["bearer", "mtls"]` when both are configured; if mTLS is not configured, only `["bearer"]` is emitted, and inbound mTLS attempts are rejected at the TLS layer. Clients that present neither receive `401 auth_required` with a `WWW-Authenticate: Bearer realm="kindx"` header.

**Task lifecycle states**. The protocol's canonical states are `queued`, `running`, `done`, `failed`, `cancelled`. KINDX adds one internal intermediate state, `cancelling`, observable to callers but documented as transient. The state machine is monotonic with the single exception of `cancelling → cancelled` (forward) or `cancelling → done` / `cancelling → failed` (when the task completed before honoring the cancel signal). Tests assert the state machine never produces a back-edge other than these documented transitions.

**Task event ordering**. Events emitted on the SSE stream are strictly monotonic by `seq` (a per-task integer starting at 0). Reconnecting clients can resume by sending `Last-Event-ID: <seq>` per the SSE spec; KINDX replays events with `seq > last_seq` from `a2a_task_events`. Replay is bounded by `KINDX_A2A_SSE_REPLAY_MAX` (default 100 events) to prevent abuse; clients requesting older events receive a `terminate: replay_exceeded` event and the stream closes.

**Synchronous vs task-shaped skills**. `/messages` is for skills declared `synchronous: true` in `a2a_bridge` with default execution time <= 10s and no streaming. All other skills MUST go through `/tasks`. Calling `/messages` with a non-synchronous skill returns `409 task_required` with a hint to use `/tasks`. Calling `/tasks` with a synchronous skill is allowed; it just produces an immediately-`done` task.

**Artifacts**. An artifact is a named, MIME-typed blob produced as a side-output of a task. The protocol allows multiple artifacts per task. KINDX stores artifacts on disk under `var/a2a/artifacts/<task_id>/<artifact_id>` and records the metadata (id, name, mime, size, sha256) in a `payload_json` field of the matching `a2a_task_events` row with `kind='artifact'`. Artifacts are pruned when the parent task is pruned.

**Content negotiation**. The protocol uses `Content-Type: application/json` and `Accept: application/json` on all non-streaming endpoints; SSE endpoints use `text/event-stream`. KINDX rejects requests without these content types as `415 unsupported_media_type`. The card itself is `application/json`; an optional alternate representation `application/yaml` is supported when `?format=yaml` is present (some 2026 orchestrators prefer it for human-eyeballed configs).

**Idempotency keys**. Clients may submit `Idempotency-Key: <ulid>` on `POST /tasks` and `POST /messages`. KINDX records the key against the resulting task and short-circuits any retry with the same key in the next 10 minutes to the original task id. The key namespace is per-tenant. This protects against orchestrator retry storms.

**Push notifications declared false**. The card's `capabilities.push_notifications` is `false` for this branch. Clients that request push (via the optional `push_url` field in the task payload) receive `400 push_unsupported`. SSE is the only streaming mechanism.

**State-transition history**. The card declares `capabilities.state_transition_history: true`, meaning `GET /tasks/:id` returns the full ordered list of status transitions in addition to the current status. This is implemented by reading `a2a_task_events` rows with `kind='status'` and folding them into the response payload.

**Skill input/output mode strings**. Mode strings are free-form per the protocol but KINDX standardizes on `"text"` for plain text, `"data"` for JSON structured data, `"file"` for opaque bytes, and `"image"` for image bytes with MIME subtype in the payload. Unknown modes are passed through unchanged on the wire but trigger a warning log in the runner.

## User stories

**Solo developer running KINDX locally, using Claude Code as orchestrator (MCP).** Already works in v1.3.5. No regression. After this branch ships, the same developer can register a teammate's KINDX instance as an A2A peer and dispatch hybrid queries to it without leaving Claude Code — the orchestrator does not need to know A2A; KINDX exposes `a2a.task.dispatch` as an MCP tool, which Claude Code calls, and KINDX takes care of being the A2A client on their behalf.

**Multi-agent orchestrator (e.g., a 2026-era Gemini Agent runtime).** Discovers KINDX by fetching `http://kindx.lan/.well-known/a2a/agent.json`, sees the skill list, dispatches `POST /a2a/v1/tasks` with skill `kindx.query` and an input payload, streams the result over SSE, cancels mid-stream if the user navigates away. KINDX has never seen the orchestrator before this request. The orchestrator's Bearer token is validated against the same RBAC system that gates MCP and HTTP queries.

**Operator running KINDX on a small team server.** Wants to register three peer agents — a corporate code-search agent (mTLS-pinned), a public memory-graph agent (Bearer token, trust state "trusted"), a teammate's KINDX (token, "pinned"). Runs `kindx a2a peer add` three times. Uses `kindx a2a peer test <id>` to verify handshake. Sets per-peer `allow_skills` so the code-search peer can only be dispatched `code.search`, not `fs.write`. Configures `max_concurrency` per peer to prevent any one peer from monopolizing outbound dispatch.

**Compliance-minded team in a regulated environment.** Wants every cross-agent invocation auditable. After this branch, every inbound A2A task has an entry in `audit_log` with action `a2a_inbound_task` and tenant hash; every outbound dispatch has `a2a_outbound_task`. The audit query CLI (already in v1.3.5) extends to filter by these new action kinds. Auditors can demonstrate provenance for every agent-driven query touching the local corpus.

**Tool author building a new skill.** Adds a new MCP tool through the existing `tool-registry`. On next KINDX restart, the agent card auto-includes the new skill as `kindx.<tool-id>`. No A2A-specific code is required to participate in cross-agent dispatch — the bridge handles the mapping. If the author wants a friendlier skill id (e.g., `code.search` instead of `kindx.code-search`), they edit a row in `a2a_bridge` via `kindx a2a bridge map set`.

**Power user composing local + remote retrieval.** Wants `kindx query "..."` to optionally fan out to one specific peer. Post-merge composition with the memory-graph branch enables this; this branch alone enables the building block — the peer registry, the dispatch client, and the task-streaming infrastructure.

## Proposed UX

The user-facing experience is intentionally minimal. The local KINDX behaves identically to v1.3.5 unless the operator opts in to publishing an agent card (which is on by default for the loopback interface but requires explicit listen address for non-loopback) and unless the operator registers peers (which has no default peers).

**Default behavior.** Fresh install, no operator config. `kindx serve` starts the HTTP daemon as before. `/.well-known/a2a/agent.json` and `/a2a/v1/agent-card` resolve and return a card derived from the live tool-registry. No peers are registered, so all `kindx a2a peer *` commands operate on an empty set. Inbound A2A tasks are accepted on the same port as `/mcp` and `/query`, gated by the same RBAC. Outbound A2A dispatch returns an actionable error ("no peer with id X").

**Card discovery.** The operator publishes the card by sharing the URL. The orchestrator fetches it. The card declares streaming, lists skills, and advertises Bearer + mTLS auth. The orchestrator picks the auth scheme it has credentials for and proceeds.

**Inbound task.** The orchestrator POSTs `/a2a/v1/tasks`. KINDX validates the input against the skill's Zod schema, allocates a `task_id`, persists the row with status `queued`, returns `{ task_id, status: "queued" }`. The bridge spawns the underlying MCP tool through the in-process tool-registry, clamped by the inbound policy (default `read-only` sandbox, `none` network). Status transitions to `running`. Intermediate output streams over SSE if the orchestrator opened `/a2a/v1/tasks/:id/stream`. Final result lands in `output_json`, status becomes `done`, the SSE stream emits a terminal event and closes. The task row is retained for the operator-configurable retention window (default 7 days).

**Outbound task.** Operator runs `kindx a2a task dispatch --peer corp-code --skill code.search --input-json '{"query":"impl X"}'`. KINDX validates input against the peer's cached skill schema (fetched at peer registration time and re-fetched on each `peer test`). It POSTs `/a2a/v1/tasks` to the peer with the Bearer or mTLS the operator configured. It tracks the returned `task_id` in `a2a_tasks` with `direction='outbound'`. If `--stream` was passed, it opens the peer's SSE endpoint and proxies events to stdout (or to a structured `--json` stream if requested). On success, the final payload is printed.

**Cancellation.** Cooperative on both directions. Inbound cancel sets the task row to `cancelling`, signals the in-process subagent through the existing abort channel, waits for the tool to acknowledge or the timeout to expire, transitions to `cancelled` and closes the SSE stream. Outbound cancel POSTs `/a2a/v1/tasks/:id/cancel` to the peer and updates local state.

## CLI design

All A2A commands are subcommands of `kindx a2a`. They follow KINDX's existing CLI conventions: positional ids, flag-based filters, `--json` for machine output, exit code 0 on success, non-zero with structured stderr on error.

### Agent card

```
kindx a2a card [--json] [--out <path>]
```

Prints the live agent card to stdout, or saves it to `<path>` if `--out` is given. The card is derived on the fly from the tool-registry; this command does not touch persistence. With `--json` the output is the raw card; without, it is a human-readable rendering (name, url, version, capabilities, skills table).

```
kindx a2a card update [--name <n>] [--description <s>] [--skill add|remove <id>] [--url <s>]
```

Edits the local card overrides stored in `a2a_card`. Skills are not added or removed by this command (skills come from the tool-registry); `--skill add` and `--skill remove` toggle the *hidden* flag in `a2a_bridge` for that skill, which controls whether the skill appears in the card. All other fields override the auto-derived values. Idempotent.

### Peers

```
kindx a2a peer add --url <u> [--name <n>] [--token <t>]
                   [--mtls-cert <p> --mtls-key <p>]
                   [--public-key <p>] [--trust trusted|pinned]
```

Registers a peer. Exactly one auth mode must be specified: `--token` (Bearer) or `--mtls-cert`/`--mtls-key` (mTLS). `--public-key` is optional and used for response signature verification if the peer supports it (A2A's optional payload-signing extension). `--trust pinned` means the peer's public key/certificate fingerprint is pinned at registration; subsequent rotations require an explicit `peer update`. `--trust trusted` means the operator accepts TLS chain validation alone. Default is `pinned`. After registration, KINDX immediately fetches the peer's `/.well-known/a2a/agent.json` and caches skills into `a2a_peer_skills`. If the fetch fails, the peer row is still persisted but with `last_seen=null` and a warning is printed.

```
kindx a2a peer list [--json]
```

Lists peers with id, name, url, auth mode, trust state, last-seen timestamp, and skill count.

```
kindx a2a peer remove <id>
```

Removes a peer. Cascades to `a2a_peer_skills` (skill cache discarded) but does not delete `a2a_tasks` rows that reference it — historical task records survive peer removal; the peer_id becomes a soft reference.

```
kindx a2a peer test <id>
```

Performs a handshake: fetches the agent card, refreshes the skill cache, optionally validates signature on a probe task. Returns timing and an OK/FAIL result. Suitable for cron-style readiness checks.

### Tasks

```
kindx a2a task dispatch --peer <id> --skill <s>
                        [--input-file <p> | --input-json <s>]
                        [--stream] [--timeout <ms>] [--json]
```

Dispatches an outbound task. Either `--input-file` (read JSON from disk) or `--input-json` (inline) must be provided. Input is validated against the cached skill schema before dispatch; mismatches yield an exit-2 with a Zod-style error message. With `--stream`, the SSE stream is proxied to stdout (line-delimited JSON when `--json`, human-readable otherwise). Without `--stream`, the command polls `/a2a/v1/tasks/:id` at a backoff schedule until terminal.

```
kindx a2a task status <task-id> [--json]
```

Returns the current task row plus the last few event-log entries.

```
kindx a2a task cancel <task-id>
```

Cancels a task. Works for both directions: outbound posts to the peer, inbound signals locally.

```
kindx a2a task list [--peer <id>] [--status queued|running|done|failed|cancelled] [--json]
```

Lists tasks. Filters by peer and/or status. Defaults to the most recent 50.

```
kindx a2a task stream <task-id>
```

Streams events for a task that was previously dispatched. Useful when the original dispatcher exited or for re-attaching to long-running outbound tasks.

### Skills & bridge

```
kindx a2a skills list [--json]
```

Lists the skills KINDX exposes (the inbound surface). Shows skill id, source MCP tool, hidden flag, override summary.

```
kindx a2a bridge map set --mcp-tool <name> --a2a-skill <id>
kindx a2a bridge map get --mcp-tool <name>
kindx a2a bridge map clear --mcp-tool <name>
```

Manages explicit MCP tool ↔ A2A skill mappings. Without an explicit mapping, the auto-derived id `kindx.<tool>` is used. The mapping can also flag a tool as hidden (via `kindx a2a card update --skill remove`) which is internally a row in `a2a_bridge` with `hidden=1`.

## MCP design

Each CLI subcommand corresponds to an MCP tool, registered through the existing `engine/tool-registry.ts`. The tools are namespaced under `a2a.*` and use additive Zod schemas defined in `packages/kindx-schemas`.

### Tool sketches

```ts
// a2a.peer.register
{
  name: "a2a.peer.register",
  inputSchema: z.object({
    url: z.string().url(),
    name: z.string().optional(),
    auth: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("bearer"), token: z.string() }),
      z.object({ kind: z.literal("mtls"), cert_pem: z.string(), key_pem: z.string() })
    ]),
    public_key_pem: z.string().optional(),
    trust: z.enum(["trusted", "pinned"]).default("pinned")
  }),
  outputSchema: KindxA2APeerSchema
}

// a2a.peer.list
{ inputSchema: z.object({}), outputSchema: z.array(KindxA2APeerSchema) }

// a2a.peer.remove
{ inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ removed: z.boolean() }) }

// a2a.peer.test
{ inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), latency_ms: z.number(), skill_count: z.number(), error: z.string().optional() }) }

// a2a.task.dispatch
{ inputSchema: KindxA2ATaskDispatchInputSchema,
  outputSchema: KindxA2ATaskSchema }

// a2a.task.status
{ inputSchema: z.object({ task_id: z.string() }),
  outputSchema: z.object({ task: KindxA2ATaskSchema, recent_events: z.array(KindxA2ATaskEventSchema) }) }

// a2a.task.cancel
{ inputSchema: z.object({ task_id: z.string() }),
  outputSchema: z.object({ status: z.enum(["cancelling", "cancelled", "already_terminal"]) }) }

// a2a.task.list
{ inputSchema: z.object({ peer_id: z.string().optional(),
                         status: z.enum(["queued","running","done","failed","cancelled"]).optional(),
                         limit: z.number().int().positive().max(500).default(50) }),
  outputSchema: z.array(KindxA2ATaskSchema) }

// a2a.skills.list
{ inputSchema: z.object({}),
  outputSchema: z.array(z.object({ skill_id: z.string(), mcp_tool: z.string(),
                                   hidden: z.boolean(), description: z.string() })) }

// a2a.card.get
{ inputSchema: z.object({}), outputSchema: KindxA2AAgentCardSchema }

// a2a.card.update
{ inputSchema: z.object({ name: z.string().optional(), description: z.string().optional(),
                          url: z.string().url().optional() }),
  outputSchema: KindxA2AAgentCardSchema }
```

These tools register through the same path as every other MCP tool (`tool-registry.register(...)`), so they appear in the MCP `tools/list` response automatically. An orchestrator can drive the full A2A peer registry and task lifecycle through MCP — the CLI is sugar on top.

The MCP tool handlers delegate to `engine/a2a/peers.ts`, `engine/a2a/tasks.ts`, and `engine/a2a/card.ts`. They do not contain business logic; they translate Zod-validated input into module calls and Zod-validate the responses.

### Streaming considerations

`a2a.task.dispatch` does not stream over MCP today. The streaming path is the SSE endpoint on the inbound side and the dedicated `kindx a2a task stream <id>` CLI. An orchestrator that wants to stream an outbound task does so by (a) calling `a2a.task.dispatch`, (b) using `a2a.task.status` polling, or (c) opening the SSE stream directly to KINDX's `/a2a/v1/tasks/:id/stream` after authenticating. A future extension may add MCP-native streaming once the MCP spec ratifies a streaming-tool-result shape; until then, polling + SSE is the documented pattern.

## HTTP API design

The A2A surface lives under `/a2a/v1/*` and `/.well-known/a2a/*`. It is mounted on the same HTTP daemon that already serves `/mcp`, `/query`, `/health`, `/ready`, `/metrics`. The only edit to `engine/protocol.ts` is the single insertion point that mounts the new router; the router itself is self-contained in `engine/a2a/server.ts`.

### Endpoints

**`GET /.well-known/a2a/agent.json`** — public agent card. Unauthenticated. Returns the JSON card derived from the live tool-registry plus overrides from `a2a_card`. ETag and Last-Modified headers set; supports `If-None-Match`. Rate-limited per source IP.

**`GET /a2a/v1/agent-card`** — same content as the well-known endpoint but authenticated and capability-negotiating. If the request supplies a Bearer/mTLS that maps to a tenant with restricted skill visibility, the response card hides skills that tenant cannot access. This lets multi-tenant deployments tailor the card per caller.

**`POST /a2a/v1/messages`** — synchronous message exchange. For skills marked `synchronous: true` in the bridge config (typically read-only queries with sub-second SLA). The request body is `{ skill_id, input, metadata? }`; the response is `{ output, metadata? }` or an error envelope. Bounded execution time (default 10s); skills exceeding it must be invoked via `/tasks` instead. Backed by the same in-process tool execution path as `/tasks`, just without the persistence overhead.

**`POST /a2a/v1/tasks`** — create a task. Body: `{ skill_id, input, metadata?, stream? }`. Returns `{ task_id, status: "queued", created_at }`. Inserts a row in `a2a_tasks` with `direction='inbound'`. If `stream=true`, the response includes a `stream_url` pointing to `/a2a/v1/tasks/:id/stream`.

**`GET /a2a/v1/tasks/:id`** — task status and (if terminal) result. Returns `{ task_id, status, input, output?, error?, created_at, started_at?, finished_at?, artifacts: [{id, name, mime, size}] }`. 404 if the task does not exist or the caller cannot see it.

**`POST /a2a/v1/tasks/:id/cancel`** — cooperative cancel. Returns `{ status: "cancelling" | "cancelled" | "already_terminal" }`. Idempotent.

**`GET /a2a/v1/tasks/:id/stream`** — SSE stream of task events. Events: `{event: "status", data: {status, ts}}`, `{event: "output", data: {chunk, ts}}`, `{event: "artifact", data: {id, name, mime}}`, `{event: "done", data: {status, output?, error?}}`. Backpressure: when the SSE buffer exceeds `KINDX_A2A_SSE_BUFFER_BYTES` (default 256 KiB), the slowest reader is given a 5-second grace period before being disconnected with a `terminate: backpressure` event.

**`GET /a2a/v1/tasks/:id/artifacts/:artifact_id`** — retrieve a named artifact. Artifacts are written to disk under `var/a2a/artifacts/<task_id>/<artifact_id>` by skills that opt in (most skills emit only `output_json`). Content-Type is set from the artifact's recorded mime; range requests supported.

### Operator endpoints (outbound peer management)

**`POST /a2a/peers`** — register a peer. Same shape as `a2a.peer.register` MCP tool. Requires operator role.

**`GET /a2a/peers`** — list peers.

**`DELETE /a2a/peers/:id`** — remove a peer.

**`POST /a2a/peers/:id/test`** — peer test handshake.

These are HTTP equivalents of the CLI/MCP surface for operators who prefer raw HTTP (typically automation tooling).

### Auth, RBAC, rate limits

All `/a2a/v1/*` endpoints (except `/.well-known/a2a/agent.json` and `/a2a/v1/agent-card` when configured public) require a Bearer token or mTLS client cert. The token is validated through the existing `engine/rbac.ts` machinery, extended to recognize a new principal kind `a2a_peer`. The tenant is derived from the token; quota and rate-limit policies are tenant-scoped exactly as they are for `/mcp` and `/query`.

Rate limits: per-tenant `KINDX_A2A_RPS` (default 20 requests/sec) and `KINDX_A2A_CONCURRENT_TASKS` (default 8). Exceeding either yields 429 with a `Retry-After` header.

mTLS: configured via `KINDX_A2A_MTLS_CA_PEM`. When mTLS is enabled, KINDX validates the client cert against the CA and maps the certificate subject CN to a tenant via the existing tenant-ACL config.

### Error envelope

A2A error responses follow the protocol's standard shape: HTTP status + JSON body `{ error: { code, message, details? } }` where `code` is one of the documented A2A error codes (`invalid_input`, `skill_not_found`, `auth_required`, `forbidden`, `rate_limited`, `internal`, `unavailable`, `task_not_found`, `task_terminal`). KINDX maps internal errors (Zod failures → `invalid_input`, RBAC denials → `forbidden`, etc.) onto these codes in `engine/a2a/server.ts`.

## Schema changes

All new schemas live in `packages/kindx-schemas/src/index.ts` (added, never replacing existing exports). All additive.

```ts
export const KindxA2AAgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  url: z.string().url(),
  version: z.string(),
  capabilities: z.object({
    streaming: z.boolean(),
    push_notifications: z.boolean(),
    state_transition_history: z.boolean()
  }),
  authentication: z.object({
    schemes: z.array(z.enum(["bearer", "mtls"])).min(1)
  }),
  default_input_modes: z.array(z.string()).min(1),
  default_output_modes: z.array(z.string()).min(1),
  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
    examples: z.array(z.string()).default([]),
    input_modes: z.array(z.string()),
    output_modes: z.array(z.string()),
    input_schema: z.any().optional(),
    output_schema: z.any().optional()
  }))
});

export const KindxA2APeerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  base_url: z.string().url(),
  auth_kind: z.enum(["bearer", "mtls"]),
  trust_state: z.enum(["trusted", "pinned"]),
  added_at: z.number().int(),
  last_seen: z.number().int().nullable(),
  skill_count: z.number().int().nonnegative()
});

export const KindxA2APeerSkillSchema = z.object({
  peer_id: z.string(),
  skill_id: z.string(),
  name: z.string(),
  description: z.string(),
  input_modes: z.array(z.string()),
  output_modes: z.array(z.string()),
  fetched_at: z.number().int()
});

export const KindxA2ATaskSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  peer_id: z.string().nullable(),
  skill_id: z.string(),
  status: z.enum(["queued", "running", "cancelling", "cancelled", "done", "failed"]),
  input: z.unknown(),
  output: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).nullable(),
  started_at: z.number().int(),
  finished_at: z.number().int().nullable(),
  parent_task_id: z.string().nullable(),
  tenant_hash: z.string().nullable()
});

export const KindxA2ATaskEventSchema = z.object({
  task_id: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  kind: z.enum(["status", "output", "artifact", "error", "done"]),
  payload: z.unknown()
});

export const KindxA2ATaskDispatchInputSchema = z.object({
  peer_id: z.string(),
  skill_id: z.string(),
  input: z.unknown(),
  stream: z.boolean().default(false),
  timeout_ms: z.number().int().positive().max(600_000).default(60_000),
  metadata: z.record(z.string()).optional()
});

export const KindxA2ABridgeMapSchema = z.object({
  mcp_tool: z.string(),
  a2a_skill: z.string(),
  hidden: z.boolean().default(false),
  input_overrides: z.unknown().nullable(),
  output_overrides: z.unknown().nullable()
});
```

These schemas are re-exported from `packages/kindx-client/src/index.ts` so external clients written in TypeScript can validate task payloads symmetrically.

## Storage / index changes

A single forward-only migration `engine/migrations/00X_a2a.sql` (X = next sequential number) creates the new tables and indexes. No existing tables are modified.

```sql
CREATE TABLE a2a_peers (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  base_url      TEXT NOT NULL,
  auth_kind     TEXT NOT NULL CHECK(auth_kind IN ('bearer','mtls')),
  token_ref     TEXT,                  -- secret-store reference, never plaintext
  public_key    BLOB,
  mtls_cert_ref TEXT,
  trust_state   TEXT NOT NULL CHECK(trust_state IN ('trusted','pinned')),
  last_seen     INTEGER,
  added_at      INTEGER NOT NULL
);

CREATE TABLE a2a_peer_skills (
  peer_id          TEXT NOT NULL,
  skill_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  input_modes_json TEXT NOT NULL,
  output_modes_json TEXT NOT NULL,
  input_schema_json TEXT,
  output_schema_json TEXT,
  fetched_at       INTEGER NOT NULL,
  PRIMARY KEY(peer_id, skill_id),
  FOREIGN KEY(peer_id) REFERENCES a2a_peers(id) ON DELETE CASCADE
);

CREATE TABLE a2a_tasks (
  id              TEXT PRIMARY KEY,
  direction       TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  peer_id         TEXT,
  skill_id        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','cancelled','done','failed')),
  input_json      TEXT NOT NULL,
  output_json     TEXT,
  error_json      TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  parent_task_id  TEXT,
  tenant_hash     TEXT
);

CREATE TABLE a2a_task_events (
  task_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('status','output','artifact','error','done')),
  payload_json TEXT NOT NULL,
  PRIMARY KEY(task_id, seq),
  FOREIGN KEY(task_id) REFERENCES a2a_tasks(id) ON DELETE CASCADE
);

CREATE TABLE a2a_bridge (
  mcp_tool             TEXT PRIMARY KEY,
  a2a_skill            TEXT NOT NULL,
  hidden               INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  input_overrides_json TEXT,
  output_overrides_json TEXT
);

CREATE TABLE a2a_card (
  id          INTEGER PRIMARY KEY CHECK(id = 1),
  card_json   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_a2a_tasks_status      ON a2a_tasks(status);
CREATE INDEX idx_a2a_tasks_dir_status  ON a2a_tasks(direction, status);
CREATE INDEX idx_a2a_tasks_peer        ON a2a_tasks(peer_id);
CREATE INDEX idx_a2a_tasks_started     ON a2a_tasks(started_at);
CREATE INDEX idx_a2a_peer_skills_peer  ON a2a_peer_skills(peer_id);
CREATE INDEX idx_a2a_task_events_task  ON a2a_task_events(task_id);
```

The `token_ref` and `mtls_cert_ref` columns point at the same secret-store mechanism KINDX already uses for tenant Bearer tokens (`engine/rbac.ts` already wraps this). Secrets are never stored in plaintext in this table.

No FTS or vector indexes are added; A2A does not participate in the retrieval index. The `a2a_tasks` table grows linearly with task volume; retention is governed by a janitor that deletes terminal-status rows older than `KINDX_A2A_TASK_RETENTION_DAYS` (default 7) at the end of each daily maintenance window. The janitor reuses the existing maintenance scheduler.

Storage budget: at 10k tasks/day with ~1 KiB average input + ~2 KiB output + ~5 events @ ~256 B each ≈ 5 MiB/day, ≈ 35 MiB/week. Comfortably within KINDX's existing storage envelope.

### Bridge semantics — turning MCP tools into A2A skills (and back)

The bridge is the most subtle piece of this branch. The goal: a single authoritative source for "what KINDX can do" — the MCP tool-registry — projected into two protocol views without drift.

**Outbound projection (MCP → A2A skill).** At startup, `engine/a2a/bridge.ts` walks `tool-registry.list()`. For each tool, it constructs a skill entry:

- `id`: default `kindx.<tool-id>`, overridable via `a2a_bridge.a2a_skill`.
- `name`: the tool's human name from the registry, overridable.
- `description`: the tool's docstring/description, overridable.
- `input_modes` / `output_modes`: derived from the tool's Zod input/output schema kinds (`string` → `text`, `object`/`array` → `data`, `buffer`/`bytes` → `file`, image-typed → `image`). Multi-mode skills are detected via union-typed schemas.
- `examples`: pulled from the tool's example fixtures if present, otherwise empty.
- `input_schema` / `output_schema`: the JSON-Schema rendering of the Zod schema, optionally overridden by `a2a_bridge.input_overrides_json` / `output_overrides_json`.

Tools flagged `hidden=1` in `a2a_bridge` are omitted from the card and from `/messages` and `/tasks` routing tables. Hiding is the only safe operation that can lie about KINDX's surface; advertising a skill that does not exist is rejected at write time.

**Inbound resolution (A2A skill → MCP tool).** When `POST /a2a/v1/messages` or `POST /a2a/v1/tasks` arrives with `skill_id`, the bridge resolves it through a single lookup: (a) check `a2a_bridge` for an explicit mapping; (b) if none, parse `skill_id` as `kindx.<tool-id>` and look up the tool. Unknown skills produce `404 skill_not_found`. Known skills whose underlying tool is missing from the registry (e.g., a plugin was uninstalled but the bridge row was left behind) produce `503 unavailable` rather than `404`, because the bridge entry is a promise that the operator made.

**Schema override invariants.** Override schemas MUST be a *subset* (in JSON-Schema validity terms) of the underlying tool's schema. The override validator runs at write time (`a2a.bridge.map.set`) and rejects loosening: removing a `required` field, widening an enum, weakening a pattern, increasing a maximum, decreasing a minimum, or adding new properties beyond the original. The check uses an inline implementation against the parsed Zod schemas; it does not depend on an external JSON-Schema subset checker. Tightening (hide a field, narrow an enum, decrease a maximum) is allowed.

**Reverse round-trip preservation.** A core acceptance criterion: an input that validates against the *advertised* (possibly overridden) schema MUST also validate against the *underlying* tool's schema. If it does not, the override is broken. This invariant is what makes the bridge safe — the orchestrator can trust the card.

**Schema rendering**. Zod-to-JSON-Schema conversion uses the existing `zod-to-json-schema` dependency already in KINDX's package tree. The renderer is wrapped in a deterministic-output stabilizer (sorted keys, consistent `$defs` naming) so card diffs across restarts are stable and `If-None-Match` ETag matching works.

**Hot reload**. When `a2a_bridge` rows change (via CLI, MCP tool, or HTTP endpoint), the bridge module is notified through an existing `db-change` signal that other parts of KINDX already publish. The in-memory map is rebuilt and the card's ETag is bumped. Existing in-flight tasks are unaffected; subsequent requests see the new mapping.

**Identity preservation across the bridge**. When a task arrives inbound, the runner constructs the underlying tool's input strictly from the validated A2A payload — no envelope wrapping, no metadata leaking into the input. When the tool returns, the runner emits the output verbatim as the task's `output_json`. The bridge is transparent on the data plane.

**Policy preservation across the bridge**. The policy clamp module (`engine/a2a/policy.ts`) is called *before* the bridge routes to the tool. The clamp returns a `SubagentSpawnSchema` that the runner forwards into the existing in-process subagent execution path. The clamp is the only place that combines tenant, skill, and per-bridge-row policy overrides; the runner just executes what the clamp returns.

## Implementation plan

Phase 0 — scaffolding (~0.5 week). Add the schemas to `packages/kindx-schemas`, the migration file, and an empty `engine/a2a/` directory with type stubs in `types.ts`. CI must pass with the migration applied and no behavior changes.

Phase 1 — agent card publication (~0.5 week). Implement `engine/a2a/card.ts` that derives the card from `tool-registry` plus `a2a_card` overrides and `a2a_bridge.hidden` filtering. Wire `GET /.well-known/a2a/agent.json` and `GET /a2a/v1/agent-card` in `engine/a2a/server.ts`. Mount the router from `engine/protocol.ts`. Tests: `specs/a2a-card-publication.test.ts`.

Phase 2 — inbound task lifecycle (~1 week). `engine/a2a/tasks.ts` implements `createInboundTask`, `runInboundTask`, `getTask`, `listTasks`, `cancelTask`. The runner spawns the matching MCP tool through `tool-registry`, wrapped in `subagent-contract` with `sandbox: 'read-only'` and `network: 'none'` defaults; inbound tasks may not request looser policy without an explicit per-skill override in `a2a_bridge`. Wire `POST /a2a/v1/messages`, `POST /a2a/v1/tasks`, `GET /a2a/v1/tasks/:id`, `POST /a2a/v1/tasks/:id/cancel`. Tests: `specs/a2a-inbound-task-lifecycle.test.ts`, `specs/a2a-cancel.test.ts`, `specs/a2a-policy-clamp.test.ts`.

Phase 3 — SSE streaming (~0.5 week). `engine/a2a/stream.ts` implements the per-task event-bus, the SSE encoder, the backpressure-driven drop. Wire `GET /a2a/v1/tasks/:id/stream`. The event-bus reuses the same Node `EventEmitter`-based primitive that the in-process subagent streams use, so cancellation propagation is shared. Tests: `specs/a2a-task-sse-stream.test.ts`.

Phase 4 — outbound client + peer registry (~1 week). `engine/a2a/client.ts` is a typed HTTP client wrapping `undici` with Bearer/mTLS auth, response Zod validation, SSE parsing for outbound `task stream`. `engine/a2a/peers.ts` implements registration, listing, removal, test, and skill cache refresh. Wire the operator HTTP endpoints `POST /a2a/peers`, `GET /a2a/peers`, `DELETE /a2a/peers/:id`, `POST /a2a/peers/:id/test`. Tests: `specs/a2a-outbound-dispatch.test.ts`, `specs/a2a-peer-registry.test.ts`.

Phase 5 — MCP↔A2A bridge (~0.5 week). `engine/a2a/bridge.ts` materializes the mapping. On startup it walks the tool-registry, joins with `a2a_bridge`, produces the in-memory map keyed both by `mcp_tool` and by `a2a_skill`. Hot-reload hook fires when `a2a_bridge` rows change so operators can flip hidden flags without restart. Tests: `specs/a2a-bridge-mapping.test.ts`.

Phase 6 — policy clamp integration (~0.5 week). `engine/a2a/policy.ts` is the single chokepoint that maps an inbound A2A task to a `SubagentSpawnSchema` payload. Defaults come from a table; overrides come from per-skill rows in `a2a_bridge`. The same module also clamps outbound dispatch (allow/deny lists, concurrency cap, network timeout). Wire it into the inbound runner and the outbound client. Tests: `specs/a2a-policy-clamp.test.ts` (shared with Phase 2 but extended), `specs/a2a-rbac.test.ts`.

Phase 7 — CLI (~0.5 week). All `kindx a2a *` subcommands. Each is a thin wrapper around the same module functions the MCP tools and HTTP endpoints use, so behavior is unified. Tests: integration tests through the CLI runner.

Phase 8 — docs/demo (~0.5 week). README sections, the agent-card example, a recorded end-to-end demo: KINDX A registers KINDX B as a peer, dispatches `code.search`, streams result. Update `docs/architecture` index. No new doc skill required.

Total ~5 weeks, single-owner. Parallelizable phases: 1+5 (card depends on bridge logic but the bridge module is small), 2+3 (task lifecycle and streaming share the event-bus; co-developed), 4+6 (outbound and policy share the same target functions). With two engineers, ~3 weeks.

## File-by-file changes

### New files

`engine/a2a/types.ts` — re-exports the Zod schemas from `kindx-schemas` plus internal-only types (the event-bus event union, the runner context type, the policy clamp shape, the SSE encoder options). Single source of truth for A2A type names used inside `engine/`.

`engine/a2a/card.ts` — `buildAgentCard()` reads the tool-registry, applies `a2a_bridge` (hidden filter, skill-id mapping, schema overrides), merges `a2a_card` overrides, returns a `KindxA2AAgentCard`. `updateCard(patch)` writes the overrides. Pure where possible; only `updateCard` touches the DB.

`engine/a2a/server.ts` — the HTTP router. Owns all the `/a2a/v1/*` and `/.well-known/a2a/*` route handlers. Auth-gating uses helpers from `engine/rbac.ts`. Error mapping (Zod → 400, RBAC → 403, missing → 404, terminal-task transition → 409, internal → 500). Mounted on the existing HTTP daemon by a one-line addition in `engine/protocol.ts`.

`engine/a2a/tasks.ts` — inbound task lifecycle. `createInboundTask`, `runInboundTask`, `getTask`, `listTasks`, `cancelTask`. Owns the `a2a_tasks` and `a2a_task_events` writes. Coordinates with `policy.ts` for the clamp, with `bridge.ts` for the skill→tool resolution, with `stream.ts` for event emission. Idempotent on cancel.

`engine/a2a/stream.ts` — SSE encoder + per-task event-bus + backpressure drop. Reuses Node `EventEmitter` plus a bounded buffer. Exposes `subscribe(task_id, options)` returning an async iterator the route handler can drain.

`engine/a2a/bridge.ts` — in-memory map of `mcp_tool ↔ a2a_skill` plus the join with `a2a_bridge` row data (hidden flag, schema overrides). `resolveSkillToTool(skill_id)` / `resolveToolToSkill(tool)` lookups. Hot-reload via a single SQL trigger (or polling fallback if triggers are disabled).

`engine/a2a/client.ts` — typed outbound HTTP client. Bearer and mTLS variants. Response Zod validation. SSE parser. Cancellation propagation via `AbortController`. URL allowlist check on registration time and per-dispatch time (private-IP guard, scheme guard, port guard).

`engine/a2a/peers.ts` — peer registry CRUD + `testPeer(id)` handshake + skill cache refresh. Owns `a2a_peers` and `a2a_peer_skills` writes.

`engine/a2a/policy.ts` — single chokepoint for policy clamping in both directions. Inbound: maps skill + tenant + bridge config to a `SubagentSpawnSchema` payload (sandbox, network, env, timeouts). Outbound: enforces per-peer allow/deny skill lists, concurrency cap, network timeout. Pure given the inputs; testable in isolation.

`engine/migrations/00X_a2a.sql` — the schema migration described above.

### Edited files

`engine/protocol.ts` — one insertion point that mounts the A2A router. Specifically, near the existing route mounts for `/mcp`, `/query`, `/health`:

```ts
import { mountA2ARouter } from "./a2a/server.js";
// ...
mountA2ARouter(app, { db, toolRegistry, rbac, audit, metrics });
```

No other modifications. The A2A router is fully self-contained; it does not read or modify global protocol state.

`engine/session.ts` — `KindxSession` gets an optional `a2aTaskId?: string` field so a task's audit log can correlate to the session that initiated it. `SessionRegistry` is unchanged.

`engine/rbac.ts` — recognize the new principal kind `a2a_peer`. The existing token-validation path returns a `Principal` discriminated union; this branch adds `{ kind: 'a2a_peer', peer_id, tenant }`. mTLS subject-CN → tenant mapping is added as a small helper. RBAC policy checks are unchanged.

`engine/audit.ts` — new action kinds: `a2a_inbound_task_created`, `a2a_inbound_task_completed`, `a2a_outbound_task_dispatched`, `a2a_outbound_task_completed`, `a2a_peer_added`, `a2a_peer_removed`, `a2a_peer_tested`, `a2a_card_updated`, `a2a_bridge_updated`. The audit row shape is unchanged; the action enum is extended.

`engine/kindx.ts` — CLI registration for the `kindx a2a *` subcommands. Each subcommand is a thin wrapper around the corresponding module function. The CLI's existing `--json` infra is reused.

`packages/kindx-schemas/src/index.ts` — additive Zod exports per the Schema changes section.

`packages/kindx-client/src/index.ts` — re-export the new schemas. Add typed helper methods `client.a2a.peers.list()`, `client.a2a.tasks.dispatch(...)`, etc., backed by the JSON HTTP surface. These let external TS programs drive KINDX's A2A subsystem without re-deriving the Zod types.

`engine/utils/metrics.ts` — new Prometheus metrics: counters `a2a_inbound_tasks_total{status}`, `a2a_outbound_tasks_total{status,peer}`, `a2a_peer_skills_fetched_total`, histogram `a2a_inbound_task_duration_ms{skill}`, gauge `a2a_active_tasks{direction}`. Wired through the existing metrics middleware.

### New tests

`specs/a2a-card-publication.test.ts` — derives a card from a fake tool-registry, asserts shape against `KindxA2AAgentCardSchema`, asserts hidden-skill exclusion, asserts override application from `a2a_card`.

`specs/a2a-inbound-task-lifecycle.test.ts` — POST `/a2a/v1/tasks`, polls status, asserts queued→running→done transitions, asserts persistence rows.

`specs/a2a-task-sse-stream.test.ts` — opens SSE, asserts events arrive in order, asserts terminal event closes the stream, asserts backpressure disconnects a slow reader.

`specs/a2a-cancel.test.ts` — dispatches a long-running task, cancels, asserts cooperative cancel state machine, asserts no orphaned subagent.

`specs/a2a-outbound-dispatch.test.ts` — registers a peer (mock HTTP server), dispatches, asserts payload shape, asserts response handling.

`specs/a2a-peer-registry.test.ts` — register, list, remove, test. Asserts skill cache populates and refreshes.

`specs/a2a-bridge-mapping.test.ts` — adds bridge mapping rows, asserts skill→tool resolution honors them, asserts hot-reload picks up changes.

`specs/a2a-policy-clamp.test.ts` — asserts inbound tasks run under `read-only` sandbox unless explicitly upgraded, asserts outbound dispatch respects allow/deny lists, asserts concurrency cap.

`specs/a2a-rbac.test.ts` — Bearer token validation, mTLS subject-CN mapping, per-tenant rate limit, 429 with `Retry-After`.

### Observability and operator ergonomics

Every new subsystem in KINDX ships with metrics, structured logs, and a `doctor`-style diagnostic. A2A is no exception.

**Prometheus metrics.** The new metrics in `engine/utils/metrics.ts` are:

- `kindx_a2a_inbound_tasks_total{skill,status}` — counter, increments on every terminal transition.
- `kindx_a2a_outbound_tasks_total{peer,skill,status}` — counter, mirror of inbound.
- `kindx_a2a_inbound_task_duration_ms{skill}` — histogram with buckets at 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000 ms.
- `kindx_a2a_outbound_task_duration_ms{peer,skill}` — histogram, same buckets.
- `kindx_a2a_active_tasks{direction}` — gauge.
- `kindx_a2a_sse_subscribers{task_direction}` — gauge.
- `kindx_a2a_sse_backpressure_disconnects_total` — counter.
- `kindx_a2a_peer_skill_fetch_total{peer,outcome}` — counter (outcomes: `success`, `failure`, `mismatch`).
- `kindx_a2a_card_requests_total{authenticated}` — counter for `/.well-known/...` and `/agent-card`.
- `kindx_a2a_rate_limited_total{tenant}` — counter for 429s.
- `kindx_a2a_auth_failures_total{reason}` — counter (`missing`, `invalid`, `expired`, `mtls_chain`, `mtls_cn`).
- `kindx_a2a_protocol_version_mismatch_total{peer}` — counter for negotiated-version mismatches.

A recommended alert rules file ships in `docs/observability/a2a-alerts.yml` as a follow-up; out of scope for the initial merge.

**Structured logs.** Every state transition produces a JSON log line with `subsystem: "a2a"`, `task_id`, `skill_id`, `direction`, `tenant_hash`, `peer_id` (if applicable), `latency_ms` (on terminal transitions), and an event-specific payload. Logs respect the existing `KINDX_LOG_LEVEL`. Sensitive fields (input/output bodies) are NOT logged at INFO; they are only logged at DEBUG and even then are size-truncated.

**Audit log queries.** Operators can query the audit log by the new action kinds: `kindx audit query --action a2a_inbound_task_completed --since 1h`. The existing audit query CLI already supports action-kind filters; the only change is the new enum values.

**Diagnostics (`kindx a2a doctor`, follow-up).** Although not in the initial merge, the design accommodates a future doctor command that performs: (a) fetch local agent card and validate against `KindxA2AAgentCardSchema`, (b) for each registered peer, fetch its card and validate, (c) round-trip a probe task to the loopback A2A endpoint, (d) check certificate expiry for mTLS peers, (e) report on storage retention status.

**Migration verifiability.** After `kindx migrate`, the operator can run `kindx db tables | grep a2a_` and see the seven new tables. `kindx db schema a2a_tasks` prints the CREATE statement. This is consistent with how every other KINDX subsystem's storage is introspectable.

### Worked example — end-to-end inbound dispatch with policy clamp

To make the contract concrete, here is the sequence of events for a single inbound task. This is the canonical case the integration tests assert.

1. Orchestrator fetches `GET /.well-known/a2a/agent.json` from KINDX. KINDX returns a 200 with the live card. The card declares skill `kindx.query` with `input_schema` = the JSON-Schema rendering of the `query` tool's Zod input.
2. Orchestrator constructs a payload: `{"skill_id": "kindx.query", "input": {"q": "implementations of FooBar", "k": 10}, "stream": true}`. It POSTs to `/a2a/v1/tasks` with `Authorization: Bearer <token>` and `Idempotency-Key: 01J...`.
3. The HTTP router authenticates via `engine/rbac.ts`. The token maps to tenant `team-alpha`. The router checks rate limits (`KINDX_A2A_RPS`, per-tenant). It passes the payload to `engine/a2a/tasks.ts:createInboundTask`.
4. `createInboundTask` validates the payload against `KindxA2ATaskDispatchInputSchema`. It resolves the skill through `engine/a2a/bridge.ts:resolveSkillToTool("kindx.query")` and gets `("query", input_overrides=null)`. It validates `input` against the (possibly overridden) skill's input schema, which is a strict subset of the underlying tool's input schema — so validation against the tool's own Zod schema also passes.
5. The task row is inserted into `a2a_tasks` with `direction='inbound'`, `peer_id=null`, `status='queued'`, `tenant_hash='alpha-hash'`. An audit row with action `a2a_inbound_task_created` is written. The HTTP router returns `200 {task_id, status: "queued", stream_url: "/a2a/v1/tasks/<id>/stream"}`.
6. The orchestrator immediately opens `GET /a2a/v1/tasks/<id>/stream`. The SSE handler subscribes to the task's event-bus. The current state (`queued`) is replayed as a `status` event with `seq=0`.
7. The runner picks up the queued task. It calls `engine/a2a/policy.ts:clampInbound(task, tenant)` to get a `SubagentSpawnSchema`: `sandbox='read-only'`, `network='none'`, `timeout_ms=30000`, `env={}`. It transitions the task to `running` (event `seq=1` over SSE).
8. The runner invokes the tool through the in-process tool-registry, wrapped in the subagent contract. The tool runs the hybrid query, emits two intermediate `output` events with partial result counts (event `seq=2, 3`), and produces a final result.
9. The runner writes the result to `output_json`, transitions the task to `done`, and emits a terminal `done` event (`seq=4`). An audit row with action `a2a_inbound_task_completed` is written. The SSE stream emits the terminal event and closes.
10. The orchestrator receives the final result. It can subsequently call `GET /a2a/v1/tasks/<id>` to retrieve the persisted result (within the retention window).

Failure variants of this sequence are documented in the tests: cancel arriving between step 6 and step 8 (cooperative cancel), policy violation in step 7 (immediate `failed` with `forbidden`), tool exception in step 8 (`failed` with the tool's error), backpressure on the SSE stream (slow reader disconnected after grace period).

### Test fixtures and harnesses

The test files reuse infrastructure that already exists in `specs/helpers/`. Specifically: `boot.ts` for in-memory KINDX instances, `mock-http.ts` for upstream peer simulation, `fixtures/db/v1.3.5.sqlite` for migration testing, `fixtures/cards/` (new) for canonical agent-card examples, `fixtures/payloads/` (new) for task input/output samples that cover happy paths, error envelopes, and edge sizes. Two new helpers are introduced: `helpers/sse-client.ts` (a tiny EventSource-shaped consumer that returns an async iterator of events for assertions) and `helpers/peer-fake.ts` (an in-process A2A peer that can be configured to misbehave on demand — return malformed cards, time out mid-stream, reject specific skills, etc.). Both are used across multiple test files.

CI configuration adds the new spec files to the default Vitest project. Coverage requirements: 90% line coverage for `engine/a2a/policy.ts` (the security-critical path), 80% for the other modules. The coverage report is uploaded as a CI artifact for every PR touching `engine/a2a/`.

## Test plan

Unit-test the pure modules (`card.ts`, `bridge.ts`, `policy.ts`) with table-driven Vitest tests covering edge cases (no skills, all skills hidden, missing override target, etc.).

Integration-test the HTTP surface with a Vitest harness that boots an in-memory KINDX (existing `specs/helpers/boot.ts` already provides this), POSTs requests, asserts both the HTTP response and the DB rows. Mock the upstream peer with a tiny `node:http` server in-process for outbound dispatch tests; mTLS is covered by a parallel test using `node:tls` self-signed certs.

End-to-end test the streaming path with two KINDX instances on different ports (still in-process via the test harness). Instance A registers Instance B as a peer, dispatches `kindx.query`, drains the SSE stream, asserts the result matches an equivalent direct `/query` call against Instance B. Verifies bidirectional protocol fidelity.

Migration test: run the migration against a real v1.3.5-era SQLite DB snapshot (already in `specs/fixtures/`), assert it succeeds and existing rows are unchanged.

Policy test: dispatch an inbound task that would write to disk if the sandbox were not `read-only`; assert it is denied and the audit log records the denial.

Negative tests: malformed agent-card payloads from a peer (response Zod validation should reject), expired Bearer tokens (RBAC should reject), rate-limit overflow (429), private-IP outbound URL (allowlist should reject), payload-size limits (413), unknown skill_id (404 with proper error code), cancel-after-terminal (409).

Performance check (smoke, not benchmark): 1000 sequential inbound tasks complete in under 30s on the CI runner. SSE backpressure does not leak memory across 100 disconnects.

All tests use Vitest, `.js` ESM imports, no external services.

### Performance budget

The A2A surface should not introduce measurable overhead on the existing MCP and `/query` hot paths. Specifically: agent-card generation must complete in under 5 ms for a registry with up to 200 tools (achievable with the in-memory map and a single SQLite read for overrides); inbound task creation overhead beyond the underlying tool execution must be under 10 ms (a single `a2a_tasks` insert plus a policy clamp call); SSE event emission must not block the runner (events are pushed onto a bounded queue and drained by the SSE writer in a separate microtask). Outbound dispatch latency overhead is dominated by network round-trip; KINDX adds under 5 ms of local processing on top.

A microbenchmark in `specs/bench/a2a.bench.ts` (Vitest's benchmark mode) measures each of these. The benchmarks are not gating CI but are tracked over time so regressions are visible. Memory: the per-task bookkeeping is on the order of 1 KiB resident plus the persisted SQLite rows; 10k concurrent inbound tasks would consume ~10 MiB of heap, well within budget. SSE subscribers consume ~32 KiB each for buffer plus connection state.

### Cross-platform considerations

KINDX targets Linux, macOS, and Windows. Three platform-specific concerns warrant explicit mention. First, Windows file-path handling for artifacts: paths are normalized via `path.posix` for cross-platform storage but converted at the filesystem boundary. Second, mTLS certificate loading on macOS keychain integration: the implementation reads PEM files from disk rather than touching keychains, sidestepping platform-specific certificate stores. Third, SSE keepalive on platforms with aggressive idle-connection eviction (some Windows network configurations): a 15-second heartbeat comment is emitted on every active stream by default, configurable via `KINDX_A2A_SSE_HEARTBEAT_S`.

The test suite runs on all three platforms in CI. Migration tests run against the same SQLite fixture on all three; SQLite is platform-agnostic for our purposes. The mTLS tests use self-signed certs generated in-test, which works identically across platforms.

## Acceptance criteria

1. `GET /.well-known/a2a/agent.json` returns a card that validates against `KindxA2AAgentCardSchema` and that an independent A2A reference client successfully parses.
2. `POST /a2a/v1/tasks` with valid input transitions the task through `queued → running → done` within the documented SLA (default: any tool that completes in ≤30s under MCP also completes here, with overhead ≤200ms).
3. `POST /a2a/v1/tasks/:id/cancel` is cooperative: it does not kill the underlying subagent forcibly; it signals abort and waits up to `KINDX_A2A_CANCEL_TIMEOUT_MS` (default 10s) for graceful exit, then transitions to `cancelled` regardless.
4. SSE backpressure: a stream reader that does not drain its buffer for 5 seconds is disconnected with a `terminate: backpressure` terminal event; no other readers are affected; no memory leak across repeated disconnects.
5. MCP↔A2A round-trip: an MCP tool input dispatched as an A2A task arrives at the underlying tool with identical Zod-validated input, and the output round-trips back with identical schema. The Zod schemas are *not* duplicated; the same schema object validates both shapes.
6. RBAC: a request with a token mapped to a tenant whose ACL excludes a skill receives 403 with error code `forbidden`. A peer-token request is mapped to the `a2a_peer` principal kind. mTLS subject-CN maps to a tenant per the documented helper.
7. Audit log: every inbound and outbound task lifecycle transition (created, started, completed, failed, cancelled) and every peer-management action produces a row in `audit_log` with tenant_hash set.
8. Storage retention: terminal tasks older than `KINDX_A2A_TASK_RETENTION_DAYS` are deleted by the daily maintenance run; the migration applies cleanly to a v1.3.5 DB.
9. CLI parity: every MCP tool has a CLI subcommand, and vice versa; the help text matches; `--json` works on every subcommand that returns data.
10. Backward compat: with no peers registered and no orchestrator addressing `/a2a/*`, every v1.3.5 behavior is bit-identical (modulo the addition of A2A-related rows in the audit log for peer add/remove if the operator uses them).

### Edge cases and corner behaviors

A roadmap that does not enumerate the corner cases is a roadmap that produces a partially-working implementation. These are the cases we have already identified and the intended behavior for each.

**Empty card (no tools registered).** A KINDX instance booted with no tools (unlikely, but possible during plugin development) emits a card with an empty `skills` array. The card still validates against the schema. Orchestrators that require at least one skill treat this as "no useful capabilities" and skip the agent. KINDX does not refuse to serve the card.

**Tool added after startup.** When a plugin registers a new tool after the daemon has been running, the tool-registry emits a change event. The bridge module rebuilds its in-memory map. The next card request sees the new skill. The ETag on the well-known card changes; orchestrators with cached cards re-fetch on the next If-None-Match miss.

**Tool removed after startup.** When a plugin is unloaded, the tool disappears from the registry but the `a2a_bridge` row may still reference it. Inbound tasks targeting the orphaned skill receive `503 unavailable`. The doctor command (follow-up) flags this as a configuration drift to clean up.

**Peer with mismatched protocol version.** A peer advertising A2A version `2.0` (hypothetical future bump) is registered. KINDX honors the registration but logs a `kindx_a2a_protocol_version_mismatch_total` counter increment and downgrades semantics where possible. Dispatch attempts to the peer go through; behaviors not supported by the version negotiation degrade gracefully (e.g., streaming requested but unsupported falls back to polling).

**Peer that returns a card with no skills.** The skill cache is populated with zero rows. Dispatch to that peer always returns `404 skill_not_found` regardless of skill id. The peer row is still persisted; `peer list` shows `skill_count=0`.

**Peer with circular dispatch (peer's `kindx.query` is implemented by dispatching back to us).** Single-hop dispatch is the only thing this branch supports, so the peer's tool is responsible for not looping back. If it does, the second incoming task is treated as an unrelated new task with its own task id, and resource limits cap the blast radius. Multi-hop loop detection is a future extension.

**Peer with a self-signed cert in `trusted` mode but no public-key pin.** TLS chain validation fails. Registration returns an error pointing the operator at `--trust pinned --public-key <p>`.

**SSE reconnect after task completion.** A client opens SSE for a task that is already `done`. KINDX immediately replays all events up to and including the terminal one, then closes the stream. No connection is left hanging.

**SSE on a task that does not exist.** Returns `404 task_not_found` over the initial HTTP handshake; no SSE stream is opened.

**Cancel on a queued task.** The task transitions directly to `cancelled` without ever entering `running`. The audit log records both transitions for completeness.

**Cancel after `done`.** Returns `409 task_terminal` with the current status.

**Task input exceeding size limits.** The HTTP router enforces a body-size cap (`KINDX_A2A_MAX_BODY_BYTES`, default 4 MiB). Requests exceeding the cap receive `413 payload_too_large`. The cap is independent of the underlying tool's input-size capability.

**Task output exceeding size limits.** When a tool's output exceeds `KINDX_A2A_MAX_OUTPUT_BYTES` (default 16 MiB), the runner emits an artifact instead of inlining the output in `output_json`, and the task's `output` field references the artifact id. Orchestrators that cannot fetch artifacts see a small reference document with retrieval instructions.

**Idempotency key collision across tenants.** Keys are scoped per tenant; the same key from different tenants creates separate tasks.

**Idempotency key with different payload.** If a tenant submits two requests with the same `Idempotency-Key` but different payloads, the second request returns `409 idempotency_key_mismatch` with the original task id, allowing the orchestrator to recover. The original task is unaffected.

**Card override that creates a name collision.** An operator sets `a2a_skill="foo"` for two different MCP tools. The bridge write rejects the second with `409 skill_id_in_use`.

**mTLS cert near expiry.** `peer list` shows a warning column when any pinned cert is within 14 days of expiry. `peer test` includes expiry information in its diagnostic output. The doctor follow-up surfaces this prominently.

**Outbound dispatch when the peer's skill cache is stale.** The cache is refreshed lazily on `peer test` and proactively when `KINDX_A2A_PEER_SKILL_REFRESH_INTERVAL_S` (default 3600) has elapsed since `fetched_at`. A dispatch that arrives while the cache is stale uses the cached schema but logs a `kindx_a2a_peer_skill_cache_stale_total` increment. If the cached schema rejects the input but the live schema would accept it, the operator can `peer test <id>` to refresh and retry.

**Concurrent bridge writes.** The bridge tables are updated under a single SQLite transaction; concurrent CLI invocations serialize through SQLite's write lock. No special application-side locking is required.

**Daemon restart with in-flight tasks.** Tasks in `running` state at restart are transitioned to `failed` with error code `daemon_restart` during the startup recovery pass. The recovery pass runs before the HTTP router accepts new connections, so the state is consistent by the time the first request arrives. SSE subscribers that were connected at the time of the restart receive a connection close from the OS; they reconnect and receive the terminal `failed` event.

**Mixed-version cluster of KINDX instances (rare but possible in HA setups).** Each instance publishes its own card based on its own tool-registry; they can differ. Orchestrators that round-robin between instances must tolerate differing skill lists. KINDX does not provide a shared card across instances in this branch; that is a future extension if HA becomes a documented topology.

## Risks

**Protocol drift.** Google A2A is a moving target; sub-revisions through 2026 are likely. Mitigation: pin the spec version KINDX implements in the agent card (`"version": "1.4.0"` plus a `"protocol": { "name": "a2a", "version": "X.Y" }` block in metadata) and gate behavioral differences behind feature flags. Add a `kindx a2a protocol-version` CLI to surface what KINDX speaks. Schedule a quarterly cadence to absorb spec changes; non-breaking changes go to a point release, breaking changes wait for KINDX's next major.

**Peer impersonation.** A malicious peer could spoof its agent card to claim skills it does not implement, or rotate keys to escalate. Mitigation: `trust pinned` mode is the default, which pins the public key/cert fingerprint at registration. Rotation requires an explicit `kindx a2a peer update` (planned post-merge). The skill cache is refreshed only via signed responses when the peer supports payload signing.

**SSRF on outbound dispatch.** An operator could register a peer URL pointing at an internal-only host (192.168.x.x, 169.254.169.254, etc.), and a subsequent dispatch could exfiltrate data. Mitigation: `engine/a2a/client.ts` enforces a URL allowlist policy at both registration time and dispatch time: by default, private IPs, link-local, and metadata-service addresses are rejected unless `KINDX_A2A_ALLOW_PRIVATE_HOSTS=true`. The check resolves DNS at request time to defeat DNS rebinding; resolution results are cached for a short TTL and re-validated on each dispatch.

**Task floods.** A misbehaving or hostile orchestrator could dispatch many inbound tasks to exhaust resources. Mitigation: per-tenant `KINDX_A2A_RPS` (default 20) and `KINDX_A2A_CONCURRENT_TASKS` (default 8) caps; 429 with `Retry-After`. The Prometheus gauges surface the active task counts so operators can alert on saturation.

**Cross-tenant info leaks via task ids.** Task ids are returned to the caller; an attacker could probe ids belonging to other tenants. Mitigation: `GET /a2a/v1/tasks/:id` returns 404 (not 403) when the caller's tenant does not match the task's tenant_hash. Task ids are random UUIDv7 (or equivalent) to make enumeration computationally infeasible.

**Cooperative cancel slipping.** A skill that ignores the abort signal cannot be force-killed without endangering the host process; the runner can only mark it `cancelled` and let it complete in background. Mitigation: document the contract clearly — skills SHOULD honor `AbortSignal`. The runner logs a warning when a cancelled task continues to produce events after the cancel deadline.

**Schema override misuse.** Operators could use `a2a_bridge.input_overrides_json` to advertise a schema laxer than the underlying MCP tool accepts, causing client-side validation to pass but server-side execution to fail. Mitigation: bridge override application validates the override is a *strict subset* of the underlying tool schema (no fields added, only fields hidden or constraints tightened). Loosening is rejected at write time with a clear error.

**SSE buffer growth.** Long-lived streams with very chatty skills could blow memory if multiple slow readers attach. Mitigation: per-stream bounded buffer (default 256 KiB), backpressure-driven disconnect, and a hard cap on concurrent SSE subscribers per task (default 8).

**mTLS configuration footguns.** Operators commonly mis-pin CA certs or use expired client certs. Mitigation: `kindx a2a peer test <id>` performs a TLS-only round-trip and reports expiry, chain validation, and subject CN clearly. Expiry within 14 days emits a warning during `peer list`.

### Backward-compatibility guarantees explicitly enumerated

A non-trivial chunk of the value of this branch comes from how little it disturbs the existing surface. The guarantees are:

1. Every existing MCP tool keeps its name, schema, and behavior. No renames. No deprecations.
2. Every existing HTTP endpoint (`/mcp`, `/query`, `/health`, `/ready`, `/metrics`) keeps its path, request shape, and response shape.
3. The SQLite schema migration is purely additive (CREATE TABLE / CREATE INDEX); no ALTER TABLE statements on existing tables.
4. The audit-log table shape is unchanged; only the action-kind enum gains new values.
5. The Prometheus exposition gains new metrics; existing metric names and label sets are unchanged.
6. The CLI gains new subcommands; existing subcommand names, flags, and exit codes are unchanged.
7. The Zod schemas are additive; existing exports keep their names and shapes.

A regression test sweeps the v1.3.5 release's public surface (HTTP endpoints, MCP tool list, CLI `--help` output, schema export list) and asserts each item still exists with the same shape after this branch lands. Run as part of CI on every PR.

### Acceptance criteria — operator-facing readiness

Beyond the engineering acceptance criteria above, four operator-readiness items are required before the branch is declared shippable. They do not all need to be in code, but each must have a documented outcome.

**Operator quickstart.** A copy-pasteable five-step quickstart in the README that takes a fresh KINDX install from "no A2A" to "card published, one peer registered, one task round-tripped." Tested by a non-author engineer following the steps verbatim.

**Security note.** A short security advisory in `docs/security/` that lists the new attack surface, the threat model summary, and the recommended hardening defaults. Reviewed by at least one engineer not on the implementation team.

**Sample orchestrator.** A 50-line example in `examples/a2a-orchestrator.ts` that uses the typed client to register a peer, dispatch a task, drain a stream, and print the result. Lives in the repo and is exercised by a CI smoke test.

**Changelog with explicit upgrade notes.** The 1.4.0 changelog calls out the new RBAC principal kind, the new config-env variables (all optional with defaults), and the audit-log action enum additions. Operators auditing access reviews must be able to find this in one scroll.

## Non-goals

This branch does not build an agent marketplace. There is no central registry, no public peer directory, no signed-skill-catalog. Peer discovery is by URL; the operator chooses what to register.

This branch does not implement multi-hop agent routing. A peer can dispatch to KINDX; KINDX can dispatch to one peer per task. Chains of three or more agents are out of scope. A future extension may add `parent_task_id` traversal for federated graph queries, but the dispatcher does not transparently re-route.

This branch does not auto-discover peers via mDNS / DNS-SD / WS-Discovery. Operators add peers explicitly. Auto-discovery is a separate plumbing problem with its own privacy story.

This branch does not federate the retrieval index. Peer dispatch is per-task; it does not silently broadcast a `query` to every peer and merge results. Federated retrieval is a memory-graph-branch composition target.

This branch does not provide push notifications. The agent card sets `push_notifications: false`. Streaming over SSE covers the streaming need; webhook-style push is a future extension.

This branch does not change the MCP surface. No new MCP-spec endpoints, no MCP protocol version bump, no breaking change to any existing MCP tool. The A2A tools listed under `a2a.*` are new MCP tools that follow existing registration conventions.

This branch does not implement an artifact-storage subsystem beyond a simple disk-backed retrieval. Artifacts are an opt-in feature for skills that emit large outputs; the default skill output flow uses `output_json` only. A future extension can add chunked artifact upload, MIME sniffing, and content-addressed dedup.

This branch does not provide an SDK in non-TS languages. The `packages/kindx-client` Typescript client is the only first-party client. Other languages can use raw HTTP per the documented endpoints; a Python client is a possible community contribution but is not on this roadmap.

### Threat model summary

Putting the risk mitigations together, the threat model for this branch can be summarized along three axes. **Confidentiality**: peer impersonation, cross-tenant leaks, audit-log injection. Mitigated by pinned trust state, tenant-scoped task visibility (404-instead-of-403), tenant_hash on every persisted row, structured-only audit log writes. **Integrity**: schema-override loosening, bridge entries pointing at missing tools, cooperative-cancel race conditions. Mitigated by subset-only override validation, `503 unavailable` for missing tools, monotonic-state-machine assertions enforced in the runner. **Availability**: task floods, SSE buffer exhaustion, peer DNS rebinding to internal networks, recursive dispatch loops. Mitigated by per-tenant rate limits, bounded SSE buffers with backpressure disconnects, DNS resolution per dispatch with private-IP guards, single-hop dispatch (no transparent re-routing).

For each axis, the corresponding test specs (`a2a-rbac.test.ts`, `a2a-policy-clamp.test.ts`, `a2a-bridge-mapping.test.ts`) include negative cases that simulate the threat and assert the mitigation behavior. The threat model is reviewed quarterly alongside the upstream A2A spec revisions; new attacker capabilities (e.g., a hypothetical replay attack against a future signed-payload extension) are added to the test suite as they are identified.

## Future extensions

**Federated retrieval (compose with memory-graph branch).** Once the memory-graph branch lands, `kindx query` can accept `--federate <peer-id-list>`, fan out to peers via `a2a.task.dispatch` with skill `kindx.query`, merge results using the graph branch's score-fusion machinery, and surface a combined ranking. The plumbing here — peer registry, skill cache, dispatch — is the prerequisite; the composition is implemented in the memory-graph branch.

**Peer trust signals (compose with provenance branch).** The provenance branch's trust scorer can consume `a2a_peers.trust_state`, `last_seen`, and recent task success/failure stats as features. A trusted, recently-active peer with a low failure rate contributes higher to result provenance scoring than a never-seen-before peer.

**Observability traces (compose with observability branch).** When the observability branch lands, `engine/a2a/*` is instrumented with OpenTelemetry spans: one span per task, child spans per stream event, span links across peer boundaries via the W3C traceparent header (already standard in A2A's metadata block). End-to-end multi-hop traces become possible without changing the A2A wire format.

**Marketplace publication (compose with plugin-marketplace branch).** The marketplace branch's skill catalog can pull `KindxA2AAgentCardSchema` directly from KINDX instances to populate listings. The card is already the source of truth.

**Push notifications.** Add webhook-style notifications: peers register a callback URL, KINDX POSTs task transitions instead of (or in addition to) SSE. Useful for serverless orchestrators that cannot maintain SSE connections. Requires careful retry/backoff and idempotency-key design; out of scope for this branch.

**Artifact streaming.** Chunked artifact upload, content-addressed storage, MIME sniffing, range-resumed downloads. Pairs naturally with the observability branch's storage metrics.

**Multi-hop peer routing.** When a task's underlying skill resolves to a remote peer rather than a local tool, transparently re-dispatch outbound. This is sketched but deliberately deferred — it requires careful loop detection and policy-clamp propagation across hops.

**Federated authentication.** Today each peer relationship is configured independently. A future extension could integrate with an enterprise identity provider so a single SSO token authorizes KINDX-to-peer dispatch.

**Auto-rotation of pinned keys.** When a peer rotates its public key, the operator must manually re-pin. A future extension supports OOB attestation (e.g., DNS TXT records, signed JSON Web Keys at a well-known URL) so rotation is verifiable without operator action.

**A2A version negotiation.** Today the card declares one protocol version. A future extension supports `Accept-Protocol-Version` headers so a single KINDX can speak multiple A2A revisions during the transition.

**Per-skill rate limits.** Today rate limits are per-tenant. A future extension scopes them per-skill so a noisy `kindx.query` cannot starve a quieter `kindx.embed`. The implementation will reuse the existing token-bucket primitive in `engine/rbac.ts`.

**Streaming MCP tool results into A2A tasks.** Once the MCP spec ratifies a streaming-tool-result shape, the bridge will be able to forward intermediate output from the underlying tool to A2A SSE subscribers in real time, rather than buffering the entire output before emitting events. The current design treats SSE events as runner-emitted only.

**Federated authorization.** Today each peer carries its own token. A future extension supports OAuth/OIDC delegation chains: the orchestrator's token is exchanged for a peer-scoped token at dispatch time, with the audit trail recording the delegation. This integrates with the provenance branch's identity chain.

**Skill versioning.** Today a skill's id is monotonic; if the underlying tool's input schema changes incompatibly, the operator must rename the skill. A future extension adds `version` to the skill id (`kindx.query@2`) and supports concurrent live versions, allowing clients to pin.

**Card signing.** A future extension signs the agent card with a long-lived KINDX-instance key so orchestrators can verify the card's authenticity beyond TLS. The signature lives in a `signature` extension field; the public key is published at a separate well-known URL.

**Health-check skill.** A reserved skill `kindx.health` always present, returning the same data as `/health`. Lets orchestrators probe via the protocol rather than HTTP-out-of-band. Trivial to add post-merge.

## Merge notes

The branch is **purely additive** by construction. The HTTP surface lives entirely under `/a2a/v1/*` and `/.well-known/a2a/*`, namespaces that did not exist before. The MCP surface gains new tools under the `a2a.*` namespace, which is a non-conflicting addition. The SQLite schema gains seven new tables and several new indexes; no existing tables are modified. The migration is forward-only; rollback is not supported (consistent with KINDX's standing policy), but un-using the feature is harmless — the tables sit empty.

The edit to `engine/protocol.ts` is one import and one router-mount call. The edit to `engine/rbac.ts` extends a discriminated union by one variant — TypeScript compilation will fail anywhere in the codebase that exhaustively matched on `Principal`, which is a small finite set and is the intended early-warning. The edit to `engine/audit.ts` extends the action-kind enum; consumers that switch over it will need to handle the new kinds (with the same finite-set caveat). `engine/session.ts` adds one optional field, no breakage. `engine/kindx.ts` adds new subcommands, no breakage. `engine/utils/metrics.ts` adds new metrics, no breakage.

Configuration surface added (all optional, all with defaults):

- `KINDX_A2A_ENABLED` (default `true`).
- `KINDX_A2A_PUBLIC_CARD` (default `true` on loopback, `false` otherwise).
- `KINDX_A2A_RPS` (default `20`).
- `KINDX_A2A_CONCURRENT_TASKS` (default `8`).
- `KINDX_A2A_TASK_RETENTION_DAYS` (default `7`).
- `KINDX_A2A_CANCEL_TIMEOUT_MS` (default `10000`).
- `KINDX_A2A_SSE_BUFFER_BYTES` (default `262144`).
- `KINDX_A2A_ALLOW_PRIVATE_HOSTS` (default `false`).
- `KINDX_A2A_MTLS_CA_PEM` (no default; required only when accepting mTLS inbound).
- `KINDX_A2A_PROTOCOL_VERSION_PIN` (no default; rarely set).

When unset, KINDX behaves identically to v1.3.5 plus an unused-but-functional `/a2a/v1/*` surface. The first time an operator runs `kindx a2a peer add` or an external client fetches `/.well-known/a2a/agent.json`, the new tables receive writes; until then, persistence cost is zero rows in seven new tables, which is negligible.

Recommended merge order if running in parallel with the other 2026 branches: merge this branch first or second (it has no dependencies and unlocks the composition points the other branches reference). Merge before observability if you want trace propagation across A2A hops at the same time observability ships. Merge before memory-graph if you want federated retrieval at the same time graph queries ship. Merge before plugin-marketplace if you want catalog publication to use the agent card from day one. Provenance is independent in either order.

Documentation requirements at merge: update `docs/architecture/protocols.md` to add an A2A section paralleling the existing MCP section; update the README with a brief "KINDX is also an A2A agent" note and a link to this roadmap; record a screencast or asciinema of peer registration + outbound dispatch + SSE streaming for the changelog. No new top-level doc tree is required; the new content fits inside the existing `docs/architecture/` and `docs/cli/` structures.

Release vehicle: KINDX 1.4.0. The minor bump reflects the new protocol surface; the additive nature keeps it from being a major bump. The agent card declares `"version": "1.4.0"` to match the package version, making protocol-vs-product version reasoning trivial for operators.

Post-merge follow-ups (tracked separately, not blocking): (1) a `kindx a2a peer update` subcommand for key rotation, (2) a `kindx a2a doctor` diagnostic that exercises every endpoint and prints a health report, (3) Prometheus alert rules for the new metrics shipped as a recommended-rules file in `docs/observability/`, (4) a small reference orchestrator script in `examples/` that drives both directions to make the feature easy to demo, (5) a smoke test in CI that registers a loopback peer and round-trips one task to assert protocol fidelity at every release boundary, (6) a release-note paragraph that explicitly calls out the new RBAC principal kind so operators auditing access lists know to look for `a2a_peer` entries.

The release is intentionally conservative on defaults: no peers ship pre-registered, mTLS is opt-in via `KINDX_A2A_MTLS_CA_PEM`, the well-known card is loopback-only by default, and rate limits start tight (20 RPS) rather than permissive. Operators who need higher throughput can raise the limits; that's the safer default direction. Subsequent minor releases (1.4.x) may relax defaults based on observed deployment patterns, but the initial merge errs on the side of "off until you turn it on."

Coordinating with downstream consumers: KINDX's TypeScript client (`packages/kindx-client`) gains the new typed methods at the same major-minor as the engine, so an orchestrator upgrading the client and engine in lockstep gets the new surface immediately. Consumers using raw HTTP do not need to upgrade; the new endpoints simply appear. Consumers using the MCP surface only do not need to upgrade either; the new `a2a.*` tools are additive and ignorable.

Definition-of-done for the merge: all ten acceptance criteria are met, all nine new test files pass on CI across the three supported platforms (Linux, macOS, Windows), the migration applies cleanly to all DB fixtures in `specs/fixtures/`, the documentation update is in, the changelog entry is written, the protocol-version pin in the agent card matches the spec revision the team has implemented against, and a brief operator-facing security note (covering the threat model summary above) is published alongside the release. With those in place, the branch can merge to main and ship as KINDX 1.4.0.
