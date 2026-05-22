# Provenance, Trust, and Freshness for KINDX Results

> Roadmap design document for the `feat/provenance-trust-freshness` branch.
> Target release: KINDX v1.5.0 (post v1.4 observability cut).
> Status: design-frozen, implementation-ready.
> Authoring date: 2026-05-22. Engine baseline: v1.3.5.

> **TL;DR.** Turn every KINDX search result into an audit-grade artifact by adding three additive, optional fields — `provenance`, `trust`, `freshness` — backed by Ed25519 signing, a composite explainable trust scorer, and per-collection freshness policies driven by the existing watcher. Forward-only migration, no new top-level dependencies, no breaking changes, no cloud requirements. CLI, MCP, and HTTP surfaces ship in the same release.

## Branch

`feat/provenance-trust-freshness`

Branched from `main` at the v1.3.5 tag (commit `53489504`, "test: fix typecheck blockers and cover new engine surfaces"). This branch is sibling to `feat/observability` and `feat/a2a-peer-federation` and is expected to merge before either of those, because both downstream branches additively read the `provenance`, `trust`, and `freshness` fields introduced here. The branch will host its own SQLite migration (`00X_provenance_trust_freshness.sql`) and a single `KINDX_SCHEMA_VERSION` bump from 12 to 13. No backports beyond v1.4.x are planned.

## Owner type

Single engine maintainer (core engine + repository team). The feature crosses repository, watcher, protocol, CLI, and `packages/kindx-schemas` modules, so a single owner threading the schema and decorator changes end to end is the right shape rather than splitting between multiple sub-owners. RBAC tagging, sidecar I/O, and key handling involve security-sensitive code paths; the owner should pair-review with whoever currently owns `engine/rbac.ts` and `engine/audit.ts`.

## Problem

KINDX search results are returned as flat hybrid scores with no machine-readable answer to three questions that local-first knowledge users keep asking the engine in 2026:

1. **Where did this content come from and has it been tampered with since it was indexed?** Today the engine stores a `content` row keyed by `hash`, but there is no signature, no signer identity, no verification step, and no way for a downstream agent (or the user) to know whether the bytes on disk still match what was hashed at index time without re-reading the entire file. The hash is descriptive, not evidentiary; nothing binds a hash to a producer.
2. **Should I trust this document relative to others in the result set?** The hybrid ranker combines BM25 and vector similarity into a single score, but score is a relevance signal, not a trust signal. A high-ranking document can be: stale, drafted by an untrusted contributor, the third revision of a contested fact, an orphan with no inbound links, or a manually flagged source. None of those signals reach the caller. The engine has the raw inputs — `document_links`, `document_versions`, `content` timestamps, collection metadata — but never composes them.
3. **Is this still current enough for me to act on?** The watcher tracks change events and reconciliations, but freshness is implicit: a document modified two years ago and one modified two minutes ago look identical to a result consumer. There is no per-collection TTL, no warn/fail threshold, and no policy that lets an operator say "anything in `incidents/` older than 24 hours must surface as stale."

The pragmatic effect is that KINDX is structurally well-positioned to answer these three questions — content addressing, append-only audit, deterministic indexer, watcher — but exposes none of the answers in the result envelope. Downstream MCP clients, A2A peers, and the CLI all receive thin `SearchResult` objects that force the caller to re-implement provenance, trust, and freshness themselves, usually badly and inconsistently.

This branch closes that gap by making provenance, trust, and freshness **first-class additive properties** on every `SearchResult`, with persistent storage, optional Ed25519 signing, a composite trust score with explainable factors, and per-collection freshness policies driven by the watcher.

## Why now in 2026

Three forcing functions converged in the last year and make this the right quarter to ship the work:

1. **Agent-to-agent retrieval is the dominant consumer.** Through 2025 the share of KINDX queries originating from MCP clients overtook direct CLI usage, and the A2A federation branch will push it higher still. When an agent calls another agent, "where did this come from" stops being a UX nicety and becomes the only viable defense against silent corruption. A receiving agent that re-emits content it cannot verify is a transitive trust failure.
2. **Local-first compliance posture.** Several regulated verticals (clinical notes, legal discovery, incident response) have started requiring detached signatures and freshness SLAs on local knowledge bases as part of the audit trail. KINDX already has the audit log and the content-addressable store; the missing primitive is a verifiable signer identity bound to each indexed document.
3. **Trust signals are cheap to compute and expensive to retrofit.** Every factor we need (link in-degree, supersession depth, content-hash stability, collection weight, age) is already present in the schema. Adding a scoring pass now, while the search response envelope is being extended for observability anyway, is roughly one migration. Retrofitting it after observability ships would mean two migrations and two protocol revs.
4. **Result envelope churn budget.** Adding fields to a search response is cheap once; doing it twice (once for observability, once for provenance) is twice the migration. The observability branch is in flight and is also touching `KindxSearchResultSchema`. Sequencing this branch ahead consolidates the envelope change into a single revision.
5. **Ed25519 maturity.** Ed25519 is a Node built-in (`crypto.generateKeyPairSync('ed25519')`), has 32-byte keys and 64-byte signatures, is fast, deterministic, and has no known weaknesses for our threat model. Picking it now sidesteps a long debate about cipher agility while leaving room via the `alg` column to add a second primitive later.
6. **Hybrid ranker is stable enough to decorate.** The hybrid ranker has been stable across three minor releases. The decoration pass is post-rank and additive; the risk of shaking loose ranker bugs is small. Doing this work on a moving ranker would be substantially more dangerous.

The competitive landscape also shifted. Through 2024–2025 the assumption was that trust would live in a separate sidecar service that wrapped the retrieval engine. That model has not held: every wrapping layer ends up duplicating the engine's own metadata. The 2026 expectation is that the retrieval engine itself emits provenance and freshness as part of the result, and the wrapper merely consumes them.

## Competitive gap

A scan of the comparable local-first retrieval engines and MCP servers in early 2026 shows a consistent shape: most surface a relevance score and a path, and stop there. A few expose `mtime`, fewer expose source URI when content came from a fetch, and almost none expose a signer identity or a composite trust score. None of the comparable engines integrate per-collection freshness SLAs into the result envelope; freshness is treated as a dashboard concept that the caller reconstructs.

The gap KINDX can close:

- **Verifiable provenance at the row level.** No mainstream local retrieval engine ships detached Ed25519 signing with verification on every read, and almost none persist a fetch chain (file → http → mcp → a2a) per content hash. KINDX's existing content-addressable layout makes this a natural fit.
- **Explainable trust.** Many engines emit a single opaque trust number or skip it; KINDX can emit a vector of named, weighted factors with their contributions, suitable for both UI rendering and policy enforcement.
- **Freshness as policy, not vibe.** Most engines surface "modified at" and call it freshness. A real freshness signal needs a policy (TTL, warn, fail), a state machine (`fresh` → `warn` → `stale`), and a watcher-driven update path. KINDX has the watcher; this branch wires the rest.

## KINDX opportunity

KINDX is unusually well-suited to this work for four structural reasons:

1. **Content addressing already exists.** `content (hash PK, doc, created_at)` and `document_versions` give us a stable signing target. We sign `hash`, not `path`, which means renames and supersessions do not invalidate signatures.
2. **The audit log is append-only.** Sign and verify events plug into `engine/audit.ts` with tenant-hashed records without inventing a parallel log.
3. **The watcher is already debounced and reconciled.** `engine/watcher.ts` is the natural place to update `document_freshness.last_changed_at` and `last_checked_at` because chokidar already gives us the event timing and the reconciliation walk handles cold-start.
4. **`SearchResult` is a Zod-defined envelope.** Additive fields on `KindxSearchResultSchema` propagate automatically through `packages/kindx-schemas`, `packages/kindx-client`, the MCP server, and the HTTP API. The cost of adding three optional fields is one schema edit and one decorator.

The opportunity is to ship a coherent, testable, additively-typed feature in one branch that turns KINDX from "fast local hybrid search" into "fast local hybrid search you can defend in an audit."

## User stories

The user stories below are framed as concrete operator-and-agent scenarios. Each one maps onto specific CLI, MCP, or HTTP surfaces, and each one ties back to at least one acceptance criterion.

1. **Solo researcher with mixed sources.** "I import notes from a personal vault and from a shared team repo. I want everything from the team repo to be signed by the team's key, and I want my search results to visually flag anything from the team repo that fails verification."
2. **Incident responder.** "When I search `incidents/` I want anything older than 6 hours to be marked warn and anything older than 24 hours to be marked stale, and I want the CLI to exit non-zero if I pass `--fail-on-stale`."
3. **Agent author building on MCP.** "When my agent gets a result from KINDX, I want the response to contain a `trust.score` so I can decide whether to cite the document or downrank it, and a `trust.factors` array so I can show the user why I chose what I chose."
4. **Compliance reviewer.** "Give me a freshness report for the `policies/` collection showing the state distribution and the top 20 stalest documents, as JSON, so I can drop it into our quarterly review."
5. **Operations engineer.** "I rotated the team signing key. I want to `kindx provenance key import` the new key, `kindx provenance sign --all` against the old key's documents that were re-issued, and `kindx provenance verify --json --fail-on-untrusted` in CI."
6. **A2A peer operator.** "When my KINDX node fetches a document from a peer KINDX node, I want the fetch chain to be appended into `provenance.fetch_chain` so the downstream consumer can reconstruct where a result originally came from across two hops of federation."
7. **Manual reviewer.** "Document `runbooks/db-failover.md` was independently audited last week. I want to set its trust override to 0.95 with a reason string and have the override survive recompute passes."
8. **Watcher integrator.** "I just renamed a file in `notes/`. I expect the freshness state to be re-evaluated and the trust score to be recomputed at the next reconciliation tick without me running anything."

9. **Federated retrieval consumer.** "My agent queried a local KINDX node, which fanned out to two peer nodes over A2A. I want the response to carry a `provenance.fetch_chain` array with one entry per hop so I can audit the data path end-to-end without sampling logs from three different machines."

10. **CI gatekeeper.** "Our CI pipeline runs `kindx provenance verify --json --fail-on-untrusted` on the canonical `policies/` collection on every release branch. If any document is unsigned or signed by an untrusted kid, the build fails and the release is blocked."

11. **Reader-only consumer.** "I do not generate keys, set policies, or write overrides. I run `kindx search` and read what comes back. Nothing about my workflow changes; the new fields appear only when the operators around me opt in."

12. **Tenant administrator.** "I run a multi-tenant KINDX instance. I want each tenant to manage its own trust overrides and freshness policies without those settings leaking across tenant boundaries, and I want the global audit log to record every administrative action under a tenant-hashed identity."

## Proposed UX

The user experience is split across four surfaces — CLI, MCP, HTTP, and watcher-driven background behavior — and the design treats them as variations on the same underlying state, not as independent products. The same `KindxProvenanceSchema`, `KindxTrustSchema`, and `KindxFreshnessSchema` shapes flow through all four surfaces. The same audit events back all four. The same RBAC rules apply.


The user experience principle is: **provenance, trust, and freshness are always present and never required.** Every existing CLI and MCP call continues to work exactly as it does today; the new fields are additive on responses and optional on inputs. When a user opts in (by generating a key, setting a policy, or signing documents), the engine begins emitting richer envelopes immediately and persists the state so subsequent reads are cheap.

The four UX surfaces:

- **CLI default output** stays terse. Provenance, trust, and freshness do not pollute default human output. They appear in `--json` mode, in `kindx provenance show`, `kindx trust explain`, and `kindx freshness report`, and as compact glyphs in interactive search when the engine detects a tty.
- **MCP responses** carry the three fields when they are populated. Clients that do not understand the fields ignore them (Zod additive). Clients that do understand them can render trust glyphs and freshness states inline.
- **HTTP responses** mirror MCP. RBAC determines whether the `trust.factors` array is included (some tenants may not want raw factors leaked to all callers).
- **Watcher behavior** is invisible to the user. The watcher updates `document_freshness.last_changed_at` and `last_checked_at` on every debounced event and on every reconciliation walk; it does not need to be configured.

When a user runs `kindx search` interactively without `--json`, the engine prints one extra annotation line per result only if the document has a non-default trust state or non-fresh freshness state:

```
1. notes/security/key-rotation.md  (score 0.812)
     trust 0.72  fresh  signed by team-2026-q1
2. archive/old/database-schema.md  (score 0.741)
     trust 0.41  stale 38d  unsigned
```

Color is reserved for `--color always` and the tty path: green for `fresh` and trust ≥ 0.7, yellow for `warn` or 0.4 ≤ trust < 0.7, red for `stale` or trust < 0.4 or untrusted-signer-detected. No emoji are emitted by default.

The interactive annotation line is computed in a single pass through the decorated result list and is bounded to one extra terminal line per result; this matches the existing single-line-per-result convention and does not break pagers that depend on line counts.

The `--json` envelope is the canonical machine surface. Every consumer that needs to act on provenance, trust, or freshness should read `--json`. The human surface is allowed to evolve (column ordering, color choices, glyph variants) without a contract change; the JSON surface is contract-stable and is governed by the Zod schemas in `packages/kindx-schemas`.

Three explicit UX commitments shape the design:

- **No surprise mutation.** Reading a document never mutates its trust score or freshness state. Only `recompute`, `set`, and `clear` write. The watcher writes only `last_changed_at` and `last_checked_at` on observed events, never on reads.
- **No surprise failure.** Default search and list commands never fail because of trust or freshness state. The only commands that exit non-zero on a policy violation are the ones with explicit `--fail-on-*` flags. Existing scripts continue to pass.
- **No surprise cost.** Result decoration is bounded to two batched SQLite reads per result page. We do not load factor JSON unless `--explain` or `include_factors: true` is requested.

## CLI design

All new commands live under three sub-namespaces of the existing `kindx` CLI surface defined in `engine/kindx.ts`. Every command accepts `--json` for machine-readable output. Every mutating command writes an audit record via `engine/audit.ts`. All exit codes follow the existing engine convention: `0` success, `2` validation error, `3` not found, `4` policy violation (used by `--fail-on-untrusted` and `--fail-on-stale`), `1` unexpected.

### `kindx provenance ...`

```
kindx provenance show <path> [--json]
kindx provenance sign (--all | <path>...) [--key <path>] [--out sidecars]
kindx provenance verify [<path>...] [--json] [--fail-on-untrusted]
kindx provenance key generate [--label <label>] [--out <path>] [--json]
kindx provenance key list [--json]
kindx provenance key export <kid> [--out <path>]
kindx provenance key import <path> [--label <label>] [--trust]
kindx provenance key trust <kid>
kindx provenance key untrust <kid>
```

- `provenance show` returns the persisted signature row(s) for the document at `<path>`, including signer kid, alg, signed_at, and whether the signer is currently trusted. With `--json`, returns the full `KindxProvenanceSchema` value.
- `provenance sign` signs either `--all` documents in the active tenant or an explicit list. If `--key` is omitted the engine uses the default key (the one marked `default = 1` in `signer_keys`; if none exist, exit 2 with a guided error). With `--out sidecars`, also writes `<path>.kindx-sig` next to each source file using `engine/utils/atomic-write.ts`.
- `provenance verify` verifies the signatures for the given paths (or all signed documents if none given). Reads the current file bytes, recomputes the hash, looks up signatures by hash, and verifies each. Exits 4 if `--fail-on-untrusted` is set and any signature is by an untrusted or unknown signer or any hash mismatches.
- `provenance key generate` produces a new Ed25519 keypair, stores the private key under `~/.kindx/keys/<kid>.ed25519` with `0600` perms, persists the public key into `signer_keys`, and returns the kid. `--out` overrides the private key location.
- `provenance key list/export/import/trust/untrust` manage the local key cabinet. `trust` sets `trust_state = 'trusted'`; `untrust` sets it to `'untrusted'`; an additional `pinned` state is reserved for future use where the engine accepts only one specific kid per collection.

### `kindx trust ...`

```
kindx trust score <path> [--json]
kindx trust explain <path> [--json]
kindx trust recompute [--collection <c>] [--all] [--json]
kindx trust override set <path> --score <n> [--reason s]
kindx trust override clear <path>
```

- `trust score` returns the persisted `document_trust.score` (or computes it lazily if missing). With `--json`, returns just `{ score, computed_at }`.
- `trust explain` returns the full factor breakdown: each factor's name, weight, raw value, normalized value, contribution, and the resulting composite. This is the human-debuggable surface.
- `trust recompute` rescores either a single collection, all collections, or everything. Idempotent. Writes one audit entry per scored document.
- `trust override set/clear` writes to `trust_overrides`. An override pins the final score regardless of factor outputs (with `factors_json` still recorded for transparency), and is preserved across recomputes.

### `kindx freshness ...`

```
kindx freshness policy set    --collection <c> [--glob <g>] --ttl <duration> [--warn <duration>] [--fail <duration>] [--json]
kindx freshness policy get    --collection <c> [--json]
kindx freshness policy list   [--json]
kindx freshness policy remove --collection <c> [--glob <g>]
kindx freshness check  [<path>...] [--collection <c>] [--json] [--fail-on-stale]
kindx freshness report [--collection <c>] [--state warn|stale|fresh] [--json]
```

- Durations accept `30s`, `15m`, `2h`, `7d`, `30d` style; the parser lives in a shared util.
- `policy set` upserts a policy by `(collection, glob)`. Default `warn` is `ttl × 0.8`; default `fail` is `ttl × 1.0`.
- `policy list` enumerates all policies; `policy get` returns the resolved policy for a specific collection (matching glob with most-specific-wins).
- `freshness check` evaluates the live freshness state of one or more paths against their resolved policy; emits the state, age, and policy id. `--fail-on-stale` exits 4 on any `stale`.
- `freshness report` aggregates state distribution and lists the top N (default 50, configurable via env) documents per state.

Examples:

```
# Generate a key and sign the entire team collection
$ kindx provenance key generate --label team-2026-q1 --json
{"kid":"a8f3…","public_key":"ed25519:…","label":"team-2026-q1"}

$ kindx provenance sign --all --out sidecars
signed 412 documents (412 new, 0 already-signed)
wrote 412 sidecars under <collection>/*.kindx-sig

# Verify with CI-style strictness
$ kindx provenance verify --json --fail-on-untrusted | jq '.results[] | select(.ok == false)'
# (empty on success; non-empty rows on failure)

# Inspect a single document's trust breakdown
$ kindx trust explain runbooks/db-failover.md --json
{
  "score": 0.78,
  "factors": [
    {"name":"signer_presence","weight":0.20,"value":1.00,"contribution":0.20},
    {"name":"collection_weight","weight":0.15,"value":0.80,"contribution":0.12},
    {"name":"age_decay","weight":0.10,"value":0.65,"contribution":0.065},
    {"name":"link_in_degree","weight":0.20,"value":0.90,"contribution":0.18},
    {"name":"supersession_depth","weight":0.10,"value":1.00,"contribution":0.10},
    {"name":"content_hash_stability","weight":0.10,"value":1.00,"contribution":0.10},
    {"name":"manual_override","weight":0.15,"value":0.10,"contribution":0.015}
  ],
  "computed_at":"2026-05-22T14:01:33.812Z"
}

# Apply a per-collection freshness policy
$ kindx freshness policy set --collection incidents --ttl 24h --warn 6h --fail 24h --json
{"id":"f_…","collection":"incidents","ttl_seconds":86400,"warn_seconds":21600,"fail_seconds":86400,"created_at":"…","updated_at":"…"}

# Run the freshness report
$ kindx freshness report --collection incidents --json | jq '.distribution'
{"fresh":118,"warn":12,"stale":3,"unknown":0}
```

## MCP design

All MCP tools are registered in `engine/protocol.ts` next to the existing tool registrations. Each one defines a Zod input schema, a Zod output schema, and a handler. The names use dotted namespacing consistent with existing tool conventions.

```ts
// engine/protocol.ts (sketch — additive registrations)
import {
  KindxProvenanceSchema,
  KindxTrustSchema,
  KindxFreshnessSchema,
  KindxSignInputSchema,
  KindxVerifyInputSchema,
  KindxTrustOverrideInputSchema,
  KindxFreshnessPolicySchema,
} from '@kindx/schemas';

server.tool('provenance.get', {
  input: z.object({ path: z.string(), tenant: z.string().optional() }),
  output: KindxProvenanceSchema.nullable(),
}, async ({ path, tenant }) => repository.provenance.get({ path, tenant }));

server.tool('provenance.sign', {
  input: KindxSignInputSchema,
  output: z.object({
    signed: z.array(z.object({ path: z.string(), hash: z.string(), kid: z.string() })),
    skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
}, async (input) => repository.provenance.sign(input));

server.tool('provenance.verify', {
  input: KindxVerifyInputSchema,
  output: z.object({
    results: z.array(z.object({
      path: z.string(),
      hash: z.string(),
      kid: z.string().optional(),
      ok: z.boolean(),
      reason: z.string().optional(),
      trust_state: z.enum(['trusted', 'untrusted', 'pinned', 'unknown']).optional(),
    })),
  }),
}, async (input) => repository.provenance.verify(input));

server.tool('trust.score',     { input: z.object({ path: z.string() }), output: KindxTrustSchema }, …);
server.tool('trust.explain',   { input: z.object({ path: z.string() }), output: KindxTrustSchema }, …);
server.tool('trust.recompute', { input: z.object({ collection: z.string().optional(), all: z.boolean().default(false) }), output: z.object({ scored: z.number(), skipped: z.number() }) }, …);
server.tool('trust.override',  { input: KindxTrustOverrideInputSchema, output: z.object({ ok: z.boolean(), score: z.number().nullable() }) }, …);

server.tool('freshness.policy.set',    { input: KindxFreshnessPolicySchema, output: KindxFreshnessPolicySchema }, …);
server.tool('freshness.policy.get',    { input: z.object({ collection: z.string() }), output: KindxFreshnessPolicySchema.nullable() }, …);
server.tool('freshness.policy.list',   { input: z.object({}).strict(), output: z.array(KindxFreshnessPolicySchema) }, …);
server.tool('freshness.policy.remove', { input: z.object({ collection: z.string(), glob: z.string().optional() }), output: z.object({ removed: z.number() }) }, …);

server.tool('freshness.check',   { input: z.object({ paths: z.array(z.string()).optional(), collection: z.string().optional() }), output: z.array(KindxFreshnessSchema.extend({ path: z.string() })) }, …);
server.tool('freshness.report',  { input: z.object({ collection: z.string().optional(), state: z.enum(['warn', 'stale', 'fresh']).optional(), limit: z.number().int().positive().max(1000).default(50) }), output: z.object({
  distribution: z.record(z.enum(['fresh', 'warn', 'stale', 'unknown']), z.number()),
  documents: z.array(z.object({ collection: z.string(), path: z.string(), state: z.enum(['fresh', 'warn', 'stale', 'unknown']), age_seconds: z.number() })),
}) }, …);
```

Tools are RBAC-gated using the existing tenant model in `engine/rbac.ts`. Read tools (`provenance.get`, `trust.score`, `trust.explain`, `freshness.check`, `freshness.report`, `freshness.policy.get|list`) require `read` on the target collection. Write tools (`provenance.sign`, `trust.override`, `trust.recompute`, `freshness.policy.set|remove`) require `admin` on the target collection. `provenance.verify` is read-only.

Tool error envelopes follow the existing MCP convention: every handler returns either a successful result conforming to the declared output schema, or throws a structured error that the protocol layer maps to a `{ code, message }` envelope. New error codes added in this branch:

- `E_SIGN_NO_KEY` — sign called without a key path and no default key configured.
- `E_SIGN_KEY_NOT_FOUND` — explicit key path does not resolve to a known private key.
- `E_VERIFY_HASH_MISMATCH` — the on-disk hash no longer matches the hash that was signed.
- `E_VERIFY_NO_SIGNATURE` — verify was called against a path that has no signatures.
- `E_TRUST_DOCUMENT_NOT_FOUND` — trust read against a path not in `documents`.
- `E_FRESHNESS_NO_POLICY` — `freshness.check` evaluated a path for which no policy resolves (returns `unknown` rather than erroring in batch mode, but errors for single-path calls when explicitly requested).
- `E_RBAC_DENIED` — re-used; same as elsewhere in the engine.

These error codes are added to `packages/kindx-schemas` as a discriminated union for typed client consumption.

## HTTP API design

The optional HTTP front-end (loaded only when `KINDX_HTTP=1`) gains the following routes. All routes accept JSON request bodies, return JSON responses, and reuse the existing bearer-token tenant resolution.

```
GET    /provenance/:hash
POST   /provenance/sign
POST   /provenance/verify

GET    /trust/:collection/:path
POST   /trust/recompute
POST   /trust/overrides
DELETE /trust/overrides/:collection/:path

POST   /freshness/policies
GET    /freshness/policies
GET    /freshness/policies/:collection
DELETE /freshness/policies/:collection
POST   /freshness/check
GET    /freshness/report
```

- `GET /provenance/:hash` returns all signature rows for the given content hash plus signer metadata. RBAC: any tenant that has a document pointing at that hash.
- `POST /provenance/sign` accepts `KindxSignInputSchema` and signs the specified paths. RBAC: `admin` on the target collection. Rate-limited to 10 req/min per tenant; signing is CPU-cheap but disk-write-heavy when sidecars are enabled.
- `POST /provenance/verify` verifies the specified paths; no rate limit (read-only and bounded by document count).
- `GET /trust/:collection/:path` returns persisted trust. RBAC: `read`.
- `POST /trust/recompute` is rate-limited to 5 req/min per tenant. RBAC: `admin`.
- `POST /trust/overrides` and `DELETE /trust/overrides/:collection/:path` manage overrides. RBAC: `admin`.
- Freshness policy routes follow the same pattern.
- `POST /freshness/check` and `GET /freshness/report` are read-only.

All routes emit an audit log entry through the existing `engine/audit.ts` pipeline with the tenant hash, route, and a one-line summary of the action. No request bodies are logged in full.

Rate limiting matrix (per tenant, per route):

| Route | Limit | Window | Notes |
|---|---|---|---|
| `POST /provenance/sign` | 10 req | 60 s | bursts allowed up to 3 req in 1 s |
| `POST /provenance/verify` | unlimited | — | read-only; bounded by document count |
| `GET  /provenance/:hash` | 600 req | 60 s | typical search-page consumer |
| `GET  /trust/:collection/:path` | 600 req | 60 s | same envelope as provenance reads |
| `POST /trust/recompute` | 5 req | 60 s | CPU-bound; admins only |
| `POST /trust/overrides` | 30 req | 60 s | bounded by reasonable admin cadence |
| `POST /freshness/policies` | 30 req | 60 s | configuration churn is rare |
| `POST /freshness/check` | 300 req | 60 s | scriptable; bounded but generous |
| `GET  /freshness/report` | 60 req | 60 s | aggregation cost is non-trivial |

Limits are enforced by the existing token-bucket middleware. Excess requests return `429` with a `Retry-After` header. The limits are configurable via environment variables prefixed `KINDX_RATE_*` for installations that need to tune them.

Authentication reuses the existing bearer-token resolver. RBAC matrix:

- Read endpoints require `read` on the target collection.
- Mutation endpoints require `admin` on the target collection (or global admin if no collection is implied).
- `POST /provenance/verify` is read-only and only requires `read`.
- `GET /provenance/:hash` requires that the requesting tenant has at least one document pointing at that hash; otherwise `403`.

## Schema changes

All schemas live in `packages/kindx-schemas/src/index.ts`. They are exported additively; no existing schema becomes stricter.

```ts
// packages/kindx-schemas/src/index.ts (sketch — additive exports)

export const KindxProvenanceSchema = z.object({
  signer_kid: z.string().optional(),
  signed_at: z.string().datetime().optional(),
  alg: z.literal('ed25519').optional(),
  source_uri: z.string().optional(),
  content_hash: z.string(),
  fetch_chain: z.array(z.object({
    kind: z.enum(['file', 'http', 'mcp', 'a2a']),
    ref: z.string(),
    observed_at: z.string().datetime(),
  })).optional(),
});

export const KindxTrustFactorSchema = z.object({
  name: z.string(),
  weight: z.number().min(0).max(1),
  value: z.number().min(0).max(1),
  contribution: z.number(),
});

export const KindxTrustSchema = z.object({
  score: z.number().min(0).max(1),
  factors: z.array(KindxTrustFactorSchema),
  computed_at: z.string().datetime(),
  override: z.object({ score: z.number(), reason: z.string().optional(), set_by: z.string(), set_at: z.string().datetime() }).optional(),
});

export const KindxFreshnessSchema = z.object({
  age_seconds: z.number().int().nonnegative(),
  sla_state: z.enum(['fresh', 'warn', 'stale', 'unknown']),
  policy_id: z.string().optional(),
  last_changed_at: z.string().datetime().optional(),
});

export const KindxFreshnessPolicySchema = z.object({
  id: z.string(),
  collection: z.string(),
  glob: z.string().nullable().optional(),
  ttl_seconds: z.number().int().positive(),
  warn_seconds: z.number().int().positive().optional(),
  fail_seconds: z.number().int().positive().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const KindxSignInputSchema = z.object({
  paths: z.array(z.string()).optional(),
  all: z.boolean().default(false),
  key_path: z.string().optional(),
  write_sidecars: z.boolean().default(false),
}).refine(v => v.all || (v.paths && v.paths.length > 0), { message: 'paths or all required' });

export const KindxVerifyInputSchema = z.object({
  paths: z.array(z.string()).optional(),
  fail_on_untrusted: z.boolean().default(false),
});

export const KindxTrustOverrideInputSchema = z.object({
  path: z.string(),
  collection: z.string().optional(),
  score: z.number().min(0).max(1).nullable(), // null = clear
  reason: z.string().optional(),
});

// Additive extension of the existing SearchResult schema:
export const KindxSearchResultSchema = KindxSearchResultBaseSchema.extend({
  provenance: KindxProvenanceSchema.optional(),
  trust: KindxTrustSchema.optional(),
  freshness: KindxFreshnessSchema.optional(),
});
```

The additive extension is critical: existing v1.3.x clients that import `KindxSearchResultSchema` continue to parse v1.5.0 responses successfully because all three new fields are `.optional()`. The base schema (`KindxSearchResultBaseSchema`) is also re-exported so older code paths that do not want decoration can opt out.

## Storage / index changes

A single new migration `engine/migrations/00X_provenance_trust_freshness.sql` adds the following tables and indexes. The migration bumps `KINDX_SCHEMA_VERSION` from 12 to 13. The migration is forward-only and includes no data backfill beyond inserting a default `signer_keys` row for the local engine key when it is later generated.

```sql
-- engine/migrations/00X_provenance_trust_freshness.sql

CREATE TABLE document_signatures (
  hash       TEXT    NOT NULL,
  signer_kid TEXT    NOT NULL,
  signature  BLOB    NOT NULL,
  alg        TEXT    NOT NULL DEFAULT 'ed25519',
  signed_at  INTEGER NOT NULL,
  PRIMARY KEY (hash, signer_kid)
);
CREATE INDEX idx_document_signatures_kid ON document_signatures (signer_kid);
CREATE INDEX idx_document_signatures_signed_at ON document_signatures (signed_at);

CREATE TABLE signer_keys (
  kid          TEXT    PRIMARY KEY,
  public_key   BLOB    NOT NULL,
  trust_state  TEXT    NOT NULL CHECK (trust_state IN ('trusted', 'untrusted', 'pinned')) DEFAULT 'trusted',
  label        TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0,
  added_at     INTEGER NOT NULL
);
CREATE INDEX idx_signer_keys_trust_state ON signer_keys (trust_state);

CREATE TABLE document_trust (
  collection   TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  score        REAL    NOT NULL,
  factors_json TEXT    NOT NULL,
  computed_at  INTEGER NOT NULL,
  PRIMARY KEY (collection, path)
);
CREATE INDEX idx_document_trust_computed_at ON document_trust (computed_at);
CREATE INDEX idx_document_trust_score ON document_trust (score);

CREATE TABLE trust_overrides (
  collection TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  score      REAL    NOT NULL,
  reason     TEXT,
  set_by     TEXT    NOT NULL,
  set_at     INTEGER NOT NULL,
  PRIMARY KEY (collection, path)
);

CREATE TABLE freshness_policies (
  id            TEXT    PRIMARY KEY,
  collection    TEXT    NOT NULL,
  glob          TEXT,
  ttl_seconds   INTEGER NOT NULL,
  warn_seconds  INTEGER,
  fail_seconds  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_freshness_policies_collection ON freshness_policies (collection);

CREATE TABLE document_freshness (
  collection       TEXT    NOT NULL,
  path             TEXT    NOT NULL,
  last_changed_at  INTEGER NOT NULL,
  last_checked_at  INTEGER NOT NULL,
  sla_state        TEXT    NOT NULL CHECK (sla_state IN ('fresh', 'warn', 'stale', 'unknown')),
  policy_id        TEXT,
  PRIMARY KEY (collection, path)
);
CREATE INDEX idx_document_freshness_sla_state ON document_freshness (sla_state);
CREATE INDEX idx_document_freshness_last_changed_at ON document_freshness (last_changed_at);
CREATE INDEX idx_document_freshness_policy_id ON document_freshness (policy_id);
```

Notes on the storage choices:

- **`document_signatures` keys on `hash`, not on `(collection, path)`.** This is deliberate: signing content addresses means renames, moves, and identical content in multiple collections all share one signature row. The `documents` table's `(collection, path)` is the navigation index; `content` and `document_signatures` are the substance.
- **`signer_keys` carries `is_default`.** Exactly one row is allowed to have `is_default = 1`; this is enforced at the application layer because SQLite partial unique indexes are awkward here and the table is tiny.
- **`document_trust` is rebuilt by scorer passes.** It is a cache. Losing it does not lose data; the next recompute restores it. This is why we do not foreign-key it to `documents`.
- **`trust_overrides` survives recompute.** The scorer reads overrides last, and writes the final composite into `document_trust.score` while preserving the raw factor breakdown in `factors_json`.
- **`document_freshness.sla_state` is the materialized current view.** The watcher updates `last_changed_at` and `last_checked_at`; a separate scheduled tick (and any read that touches the row) re-evaluates `sla_state` against the resolved policy.
- **Indexes are tuned for the report paths.** The biggest hot read is "give me everything in `collection=X` with `sla_state='stale'` ordered by `last_changed_at` ASC limit 50" — that goes against `idx_document_freshness_sla_state` and a filter on `collection`.

The migration is single-statement-per-table, all `CREATE` (no `ALTER`), which matches existing migration style in `engine/migrations/` and keeps the diff reviewable. No existing tables are modified.

Storage budget on a realistic 10,000-document vault:

- `document_signatures` — assume 1 signature per signed document, 64-byte raw signature + ~24-byte fixed-width fields = ~96 bytes/row * 10k = ~960 KB.
- `signer_keys` — 32-byte public key + ~64 bytes metadata, expected row count is small (<100).
- `document_trust` — 8-byte score + ~250-byte factor JSON + fixed-width = ~300 bytes/row * 10k = ~3 MB.
- `trust_overrides` — sparse; expected <1% of documents.
- `freshness_policies` — sparse; expected <100 rows total.
- `document_freshness` — ~60 bytes/row * 10k = ~600 KB.

Total marginal storage on a 10k-document vault is ~5 MB, dwarfed by `content` (the actual document bytes) and by `content_vectors`. The branch does not change the disk-cost profile of the engine in any meaningful way.

Concurrency notes: all writes go through the existing `better-sqlite3` connection which is WAL-mode and exclusive-write. The decoration read path issues two parameterized `SELECT … WHERE hash IN (?, ?, …)` queries per result page and is read-concurrent. The watcher's freshness writes are batched into a 5-second window to avoid write amplification on bursty file system activity.

Edge cases the schema accommodates explicitly:

- **Identical content in two collections.** Both `documents` rows point at the same `content.hash`, both share the same `document_signatures` row, but each has its own `document_trust` and `document_freshness` row keyed by `(collection, path)`.
- **Same path, different content over time.** As `documents.hash` evolves, signatures keyed by old hashes remain in `document_signatures` until garbage collected. A separate `kindx maintenance prune-signatures` follow-up command will reap orphans, but it is not required for v1.5.0.
- **Deleted documents.** When `documents.active = 0`, decoration skips the row; `document_trust` and `document_freshness` rows are retained for audit purposes and pruned by the same future maintenance command.
- **No collection.** Documents indexed without a collection inherit a synthetic `default` collection for policy resolution.

## Implementation plan

The work is sequenced in eight phases. Each phase is independently testable and merges atomically into the branch.

### Phase 0 — Migration and schema scaffolding

Before any module-level work, land the migration file and the Zod schema additions in `packages/kindx-schemas`. This phase has no runtime behavior change; it bumps `KINDX_SCHEMA_VERSION` from 12 to 13 and introduces the new tables empty. Doing this first means every subsequent phase can write its own integration tests against a real schema without inflight stub layers.

Deliverables:

- `engine/migrations/00X_provenance_trust_freshness.sql` added.
- `KINDX_SCHEMA_VERSION` constant bumped.
- New Zod schemas exported additively from `packages/kindx-schemas/src/index.ts`.
- `KindxSearchResultSchema` extended additively; base schema preserved.
- Compatibility test in `specs/schema-compat.test.ts` asserts a v1.3.5-shape envelope round-trips through the new schema.

### Phase 1 — Key management (`engine/provenance/keys.ts`)

- Implement `generateKey()`, `loadPrivateKey(kidOrPath)`, `loadPublicKey(kid)`, `listKeys()`, `trustKey(kid)`, `untrustKey(kid)`, `setDefaultKey(kid)`, `importKey(path, opts)`, `exportKey(kid)`.
- Private keys live under `~/.kindx/keys/<kid>.ed25519` with `0600` permissions; public keys live in `signer_keys`.
- `kid` is the lower-hex SHA-256 of the public key, truncated to 16 bytes. Stable and self-verifying.
- Use Node's built-in `crypto.generateKeyPairSync('ed25519')` to avoid native deps.

### Phase 2 — Sign / verify pipeline (`engine/provenance/sign.ts`, `engine/provenance/verify.ts`, `engine/provenance/sidecar.ts`)

- `sign({ paths, all, key_path, write_sidecars })` resolves the doc → hash, signs `hash` bytes, upserts into `document_signatures`. If `write_sidecars`, also writes `<path>.kindx-sig` via `engine/utils/atomic-write.ts` in a compact `kid:base64(sig)` form with a magic prefix.
- `verify({ paths, fail_on_untrusted })` re-reads file bytes, recomputes hash, looks up signatures for that hash, verifies each, joins to `signer_keys.trust_state`, returns rows.
- The sidecar codec is symmetric: `engine/provenance/sidecar.ts` writes and parses the same format; verification can prefer the sidecar when present, falling back to the DB row.

### Phase 3 — Trust scorer (`engine/trust/factors.ts`, `engine/trust/scorer.ts`, `engine/trust/store.ts`)

- `factors.ts` defines a registry of factor functions. Each factor has a name, a weight (in `[0, 1]` and weights across all factors sum to 1.0 ± epsilon), and a `compute(doc, ctx)` returning a normalized `[0, 1]` value.
- Initial factors:
  - `signer_presence` (0.20): 1 if any trusted signature exists, 0.5 if any signature exists, 0 otherwise. -1 contribution clamped to 0 if signature is by an `untrusted` kid.
  - `collection_weight` (0.15): per-collection configured weight (default 0.5).
  - `age_decay` (0.10): exponential decay against age; half-life is per-collection-configurable, default 365 days.
  - `link_in_degree` (0.20): log-scaled count of inbound links from `document_links`.
  - `supersession_depth` (0.10): 1 if this is the latest version of its content lineage, decaying with depth.
  - `content_hash_stability` (0.10): 1 if hash unchanged in the last N reconciliations; lower otherwise.
  - `manual_override` (0.15): present only as an override hook; if an override is set, it replaces the composite; otherwise contributes 0.
- `scorer.ts` composes factors, writes `document_trust` row, returns the trust object.
- `store.ts` is the thin SQLite wrapper.

### Phase 4 — Freshness policies and state (`engine/freshness/policies.ts`, `engine/freshness/state.ts`, `engine/freshness/report.ts`)

- `policies.ts` is the CRUD layer over `freshness_policies` with most-specific-glob resolution per `(collection, path)`.
- `state.ts` exposes `recompute(path)` which reads `last_changed_at`, age = now - last_changed_at, resolves policy, computes state by comparing to warn/fail thresholds, writes `document_freshness`. Also exposes `recomputeCollection(c)` and `recomputeAll()`.
- `report.ts` aggregates state distribution and top-N stalest documents per state.

### Phase 5 — Watcher integration (`engine/watcher.ts` edits)

- On every debounced `change`, `add`, or `unlink` event, update `document_freshness.last_changed_at` for the affected `(collection, path)` and schedule `state.recompute(path)` on the next 5-second batch tick.
- On reconciliation walk, refresh `last_checked_at` for all rows it visits, and recompute SLA state for any row whose `last_checked_at` is older than `min(warn_seconds, ttl_seconds / 4)`.
- The watcher does not run the trust scorer inline. Instead it appends an entry to a small in-memory "trust dirty" set and the scorer drains the set on its own 30-second cadence (configurable via `KINDX_TRUST_DEBOUNCE_MS`).

### Phase 6 — Result decoration (`engine/repository/retrieval/hybrid.ts` edits)

- After the hybrid ranker produces its result rows, a `decorate(results)` pass batch-loads `document_signatures`, `document_trust`, and `document_freshness` for all `(hash)` and `(collection, path)` pairs in the result set in two prepared statements with `IN (?, ?, ?, …)` clauses.
- Decoration is opt-out via a request-level flag `decorate=false` so legacy callers can skip the extra work. Default is on.
- The decoration code paths are O(1) per result row after the batch loads; the budget is < 1ms p95 per hit (validated by an explicit benchmark spec).

### Phase 7 — CLI surface (`engine/kindx.ts` edits)

- Add the three sub-namespaces (`provenance`, `trust`, `freshness`) with their commands. Each command is implemented by calling into the engine modules above.
- All commands accept `--json`. All commands write one audit entry per mutation.
- The `kindx search` interactive path is updated to render the new annotation line when trust < 0.7 or freshness != fresh.

### Phase 8 — MCP / HTTP / client / docs

- Register MCP tools in `engine/protocol.ts`.
- Add HTTP routes in the HTTP front-end module.
- Add client methods in `packages/kindx-client/src/index.ts`.
- Update `engine/diagnostics.ts` with one new check: "freshness policy resolves for every collection that has documents." This surfaces orphan collections.
- Add an `examples/provenance/` walkthrough and a short demo script.

### Phase ordering rationale

The eight phases are ordered to minimize rework and keep each phase merge-ready in isolation. Specifically:

- **Phase 1 → 2** because sign/verify needs a key cabinet.
- **Phase 2 → 3** because `signer_presence` is a trust factor that depends on signatures existing.
- **Phase 3 → 4** is sequential by convention; freshness and trust are independent at runtime, but the test fixtures share a vault layout, and producing them once is cheaper.
- **Phase 4 → 5** because the watcher writes to tables that the freshness module owns.
- **Phase 5 → 6** because the decorator reads what phases 2–5 wrote.
- **Phase 6 → 7** because the CLI exercises the decorated result envelope.
- **Phase 7 → 8** because the MCP / HTTP surface mirrors the CLI surface; designing the CLI first surfaces ambiguities cheaply.

Each phase has its own dedicated PR within the branch (squashed at merge), letting reviewers focus on one storage table or one module at a time.

## File-by-file changes

### New files

- **`engine/provenance/keys.ts`** — Ed25519 keypair generation, file-based private key cabinet, public key persistence in `signer_keys`, kid derivation, trust state mutations, default-key bookkeeping. ~200 lines.
- **`engine/provenance/sign.ts`** — `sign()` and `signBatch()` operating against hashes, with optional sidecar emission. ~150 lines.
- **`engine/provenance/verify.ts`** — `verify()` and `verifyBatch()` with hash re-computation, signer trust resolution, and result row construction. ~180 lines.
- **`engine/provenance/sidecar.ts`** — encoder and decoder for the `.kindx-sig` format. Symmetric, format-versioned (`v1` magic prefix), and atomic-write friendly. ~100 lines.
- **`engine/trust/factors.ts`** — Factor registry, default factor implementations, weight validation, and composition utilities. ~220 lines.
- **`engine/trust/scorer.ts`** — Orchestrator: gather inputs, compute factors, apply overrides, persist. ~180 lines.
- **`engine/trust/store.ts`** — Thin SQLite wrappers over `document_trust` and `trust_overrides`. ~120 lines.
- **`engine/freshness/policies.ts`** — Policy CRUD with most-specific-glob resolution. ~160 lines.
- **`engine/freshness/state.ts`** — Per-document state evaluation and persistence. ~150 lines.
- **`engine/freshness/report.ts`** — Aggregation and top-N stale lookups. ~120 lines.
- **`engine/migrations/00X_provenance_trust_freshness.sql`** — Single migration file as specified above. ~80 lines including comments.
- **`engine/provenance/index.ts`** — Barrel module re-exporting the public surface of `keys`, `sign`, `verify`, `sidecar`. ~30 lines.
- **`engine/trust/index.ts`** — Barrel module for the trust subsystem. ~30 lines.
- **`engine/freshness/index.ts`** — Barrel module for the freshness subsystem. ~30 lines.
- **`engine/provenance/errors.ts`** — Typed error classes for `E_SIGN_*`, `E_VERIFY_*`, mapped to MCP error codes. ~80 lines.
- **`engine/trust/errors.ts`** — Typed error classes for trust-related failures. ~50 lines.
- **`engine/freshness/errors.ts`** — Typed error classes for freshness-policy failures. ~50 lines.
- **`engine/provenance/audit.ts`** — Thin helpers that wrap `engine/audit.ts` calls with the new event kinds, ensuring uniform payload shape. ~80 lines.
- **`examples/provenance/walkthrough.sh`** — End-to-end shell walkthrough for the operator. ~100 lines including comments. Verified by a smoke test in CI.
- **`examples/provenance/README.md`** — Brief explainer pointing at the walkthrough and the related docs. ~30 lines.

### Edited files

- **`engine/repository/types.ts`** — Add `SearchResultExtensions` interface and merge into `SearchResult` additively. Add `ProvenanceRow`, `TrustRow`, `FreshnessRow`, `FreshnessPolicyRow` for internal repository use. No removals.
- **`engine/repository/retrieval/hybrid.ts`** — Add a `decorate(results, opts)` pass post-rank that batch-loads provenance/trust/freshness and attaches them. Gate via `opts.decorate ?? true`.
- **`engine/repository/indexing.ts`** — On `upsertDocument`, if there is an existing signature row keyed by the *new* hash, propagate it. If the hash changed and the path previously had signatures, leave old rows in place keyed by old hash (they are content-addressed, not path-addressed). Mark the document trust dirty.
- **`engine/watcher.ts`** — On debounced events, write `document_freshness.last_changed_at` and queue a state recompute. On reconciliation, refresh `last_checked_at` and recompute state for stale rows.
- **`engine/protocol.ts`** — Register the 12 new MCP tools described above.
- **`engine/kindx.ts`** — Add the three CLI sub-namespaces and their commands.
- **`engine/audit.ts`** — Add new event kinds: `provenance.sign`, `provenance.verify`, `provenance.key.generate`, `provenance.key.trust`, `provenance.key.untrust`, `trust.recompute`, `trust.override.set`, `trust.override.clear`, `freshness.policy.set`, `freshness.policy.remove`. Each event carries tenant hash, target path or collection, and a one-line summary.
- **`engine/diagnostics.ts`** — Add health checks: "every collection has a resolvable freshness policy", "no orphan signatures (hash present in `document_signatures` but no `content` row)", "no orphan trust rows (path present in `document_trust` but no active `documents` row)".
- **`packages/kindx-schemas/src/index.ts`** — Export the new Zod schemas described above; extend `KindxSearchResultSchema` additively.
- **`packages/kindx-client/src/index.ts`** — Add typed client methods: `provenance.show`, `provenance.sign`, `provenance.verify`, `provenance.key.*`, `trust.score`, `trust.explain`, `trust.recompute`, `trust.override.set`, `trust.override.clear`, `freshness.policy.*`, `freshness.check`, `freshness.report`. Each method is a thin wrapper around the MCP transport.

### New tests

All test files live in `specs/` and follow the existing Vitest layout. ESM with `.js` imports.

- **`specs/provenance-sign-verify.test.ts`** — Round-trip signing, multi-signer, sidecar emission and consumption, missing key handling, batch sign performance.
- **`specs/provenance-tamper.test.ts`** — Sign a document, mutate its bytes on disk without going through the repo, verify and expect `ok: false` with `reason = 'hash_mismatch'`. Also: sign with a key that is later marked `untrusted` and expect `trust_state: 'untrusted'` in the verify result.
- **`specs/trust-scorer.test.ts`** — Factor composition correctness: weights sum to 1, contributions sum to score within epsilon, monotonicity tests (adding a trusted signer never lowers score; raising `link_in_degree` never lowers score).
- **`specs/trust-overrides.test.ts`** — Override pins score across recomputes; clearing override returns to computed score; reason and set_by survive round-trip.
- **`specs/freshness-policies.test.ts`** — Most-specific-glob resolution, warn/fail derivation defaults, idempotent upsert, removal cascade behavior, duration parser edge cases.
- **`specs/freshness-watcher-events.test.ts`** — Simulate chokidar events, assert `document_freshness.last_changed_at` updates and `sla_state` transitions through `fresh → warn → stale` at the right wall-clock thresholds (with virtual clock).
- **`specs/result-decoration.test.ts`** — Hybrid search returns results with `provenance`, `trust`, `freshness` populated. Decoration off when `decorate=false`. Decoration latency p95 < 1ms per hit on a fixture of 1000 results.
- **`specs/provenance-mcp.test.ts`** — All 12 MCP tools registered and round-trip through the in-process protocol harness with valid Zod schemas.
- **`specs/provenance-http.test.ts`** — All HTTP routes return correct status codes, RBAC denials produce 403, rate limits trigger 429 at the right thresholds.

Additional changes to existing tests:

- **`specs/repository-search.test.ts`** — Existing assertions are unchanged (additive fields). A new `it.skip`-able block asserts the presence of the additive fields when decoration is enabled.
- **`specs/watcher.test.ts`** — Extend with the freshness side effect assertions when policies exist.
- **`specs/audit.test.ts`** — Extend with assertions that the new event kinds are accepted by the audit layer with the documented payload shapes.
- **`specs/rbac.test.ts`** — Extend with negative assertions for the new MCP tools (denied tenants get `E_RBAC_DENIED`).
- **`specs/diagnostics.test.ts`** — Extend with the three new health-check assertions.
- **`specs/perf/hybrid.bench.ts`** — Extend with the decoration-on and decoration-off variants; assert the ±5% / ±1% regression budgets.

The total estimated new test code is ~2,500 lines across the new specs and ~300 lines of additions to existing specs. The total estimated production code is ~1,800 lines across the new modules and ~400 lines of additions to existing modules. The ratio is intentional: this branch is heavily invested in test coverage because it introduces a security boundary (signing) and a policy boundary (freshness, RBAC) that we want pinned by tests against regression.

## Test plan

1. **Unit-level correctness.** Each new module ships with focused unit tests. The factor registry has property-based-style tests for monotonicity. The duration parser has table-driven tests across the input grammar. The sidecar codec is fuzzed against malformed input.

2. **Integration: sign → verify round-trip.** A fixture with 100 small documents, signed in a single batch, verified one by one and as a batch. Hash mismatch synthesized by mutating a byte. Trust state transitions exercised by marking the signer untrusted mid-test.

3. **Integration: scorer determinism.** With fixed inputs, the scorer produces identical output bit-for-bit across runs. Recompute is idempotent: `recompute(); recompute();` yields the same `document_trust` row.

4. **Integration: freshness watcher.** A virtual clock + a tmpfs vault + the chokidar daemon. Drive the clock forward across warn and fail thresholds; assert state transitions; assert that touching the file resets `last_changed_at` and returns the state to `fresh` synchronously after the next debounce tick.

5. **End-to-end: CLI.** Spawn `kindx provenance key generate`, then `kindx provenance sign --all`, then `kindx provenance verify --json --fail-on-untrusted`. Assert exit codes, JSON shapes, and that the audit log has the expected rows.

6. **End-to-end: MCP.** Run the in-process MCP transport and exercise all 12 new tools through the typed client.

7. **Performance gates.**
   - Sign 100 documents: total wall time < 5 seconds on a baseline laptop profile.
   - Verify 100 documents: total wall time < 2 seconds.
   - Decoration overhead: p95 < 1ms per result row for result sets up to 1000.
   - Trust recompute over 10,000 documents: < 30 seconds.

8. **Tamper detection.** A dedicated test harness writes a signed file, then overwrites a byte through a non-engine path, then calls verify. Required outcome: 100% detection with `ok: false`, `reason: 'hash_mismatch'`.

9. **Migration safety.** Bring up a v1.3.5 database (snapshot fixture), run the v1.5.0 migration, assert all new tables exist with the right shape and no existing rows were touched. Run a round-trip indexing operation and confirm `documents`, `content`, and `document_versions` behave identically to v1.3.5.

10. **Backward compatibility.** A v1.3.5 client (pinned `@kindx/schemas` version) talks to a v1.5.0 server; assert that `KindxSearchResultSchema.parse(...)` on the client side accepts the v1.5.0 envelope (the additive fields are tolerated because the old schema was non-strict; verified explicitly).

11. **RBAC and rate limiting.** Tenant A cannot read trust factors for tenant B's documents. Sign/verify rate limits trigger 429 at the documented thresholds; the limiter resets after a minute.

12. **Diagnostics.** The new health checks fire correctly on a synthesized broken database (orphan signatures, orphan trust rows, collection without policy).

13. **Property-based tests for the scorer.** Using `fast-check` (the existing engine dependency for the few property tests in `specs/`), assert the monotonicity invariants by generating arbitrary factor inputs and confirming the composition function respects: weight non-negativity, contribution sum equality, override dominance, and clamping to `[0, 1]`. Shrink-friendly counterexamples are saved into the spec output on failure.

14. **Watcher correctness under churn.** Generate 1,000 file system events in a 5-second window against a 500-document vault. Assert at the end of the run that:
    - `document_freshness.last_changed_at` is set for every touched document.
    - No row is left in an inconsistent state (state is one of the four enum values, never NULL).
    - The trust-dirty set is drained within one trust debounce window after the burst stops.

15. **Sidecar interop.** A sidecar written by `provenance sign --out sidecars` can be consumed by `provenance verify` after the SQLite `document_signatures` row is removed. This proves the sidecars are a true backup, not a hint.

16. **Locale and time-zone correctness.** All timestamps are emitted as RFC 3339 with explicit `Z` suffix; durations are parsed and emitted in seconds in the JSON envelope. A locale-agnostic test asserts no `Date.toString()` calls leak into output paths.

17. **Snapshot tests for human output.** The non-JSON CLI output for `provenance show`, `trust explain`, and `freshness report` is snapshotted to guard against accidental column re-ordering or color leakage in non-tty contexts.

## Acceptance criteria

The branch is mergeable when all of the following are demonstrably true on a clean CI run plus a manual smoke pass:

- **Signature round-trip:** signing then verifying 100 documents end-to-end completes in under 50ms per document on the baseline profile (i.e. < 5s total signing, < 2s total verify), measured by the dedicated benchmark spec.
- **Tamper detection:** 100% of byte-level mutations applied through non-engine paths produce a `verify` result with `ok: false` and `reason: 'hash_mismatch'`. No false negatives across the test corpus.
- **Trust monotonicity invariants** hold in property tests:
  - Adding a trusted signer never decreases the composite score.
  - Increasing `link_in_degree` never decreases the composite score.
  - Marking a previously trusted signer untrusted never increases the composite score.
  - Setting a manual override produces exactly that score regardless of factors; clearing it restores the factor-derived score.
- **Freshness state transitions** are observable via the watcher within one debounce window (default 1.5s) of a file system event. The state machine never skips intermediate states: a document cannot go `fresh → stale` without passing through `warn` if a `warn_seconds` is configured (validated by a deterministic-clock test).
- **Result decoration overhead** is < 1ms p95 per result row for result sets up to 1000, measured by the decoration benchmark spec.
- **Trust recompute throughput** is at least 333 docs/s (i.e. < 30s for 10,000 docs) on the baseline profile.
- **Schema additive compatibility:** a v1.3.5 client successfully parses a v1.5.0 search response, validated by a pinned-version compat test under `specs/`.
- **CLI exit codes:** `kindx provenance verify --fail-on-untrusted` exits 4 on any failure; `kindx freshness check --fail-on-stale` exits 4 on any stale; all other failures map to documented exit codes.
- **Migration is idempotent:** running the migration twice does not error. The schema version moves from 12 to 13 exactly once.
- **Audit completeness:** every mutating operation across CLI / MCP / HTTP produces exactly one audit entry with the correct kind and tenant hash. Verified by a dedicated `specs/audit-coverage.test.ts` extension.
- **Diagnostics:** `kindx diagnostics --json` includes the three new checks; all three pass on a clean engine.
- **Type-check and lint pass with zero suppressions added** in the branch (the existing baseline is the ceiling).
- **Vitest pass rate is 100%** across the new and modified specs.
- **No regression in existing benchmarks.** The existing hybrid-retrieval benchmark in `specs/perf/` is within ±5% of the v1.3.5 baseline with decoration enabled and within ±1% with decoration disabled.
- **No new top-level dependencies.** The branch adds no new direct npm dependencies; signing uses Node's built-in `crypto` module exclusively.
- **Public API surface review signed off.** The new exports from `packages/kindx-schemas` and `packages/kindx-client` are reviewed against the existing API conventions and the additive-only contract is verified.
- **Examples and walkthrough green.** `examples/provenance/walkthrough.sh` runs end-to-end on a clean machine and produces the documented output.

## Risks

1. **Key compromise.** If a private key under `~/.kindx/keys/` is exfiltrated, the attacker can forge signatures that pass verification. Mitigations:
   - The default key is one-per-engine, not one-per-document, so blast radius is large but bounded.
   - `trust_state` revocation through `kindx provenance key untrust <kid>` invalidates all signatures by that kid in one statement; subsequent verifies return `trust_state: 'untrusted'`.
   - Sidecar files include the kid, so post-incident triage can list affected documents in O(1) per kid via the existing `idx_document_signatures_kid` index.
   - We will document the key-rotation flow explicitly in the examples directory.

2. **False-positive untrusted flagging.** If `signer_keys.trust_state` is mis-set (operator typo on `untrust`), legitimate results are flagged. Mitigations: every key state transition writes an audit entry; the CLI confirms before flipping a default key; trust state is a per-engine concept and does not propagate over A2A automatically.

3. **Factor weight tuning is empirical.** The default weights are a starting heuristic, not a proven optimum. The risk is that early adopters perceive the trust score as opinionated or wrong. Mitigations:
   - Factor breakdown is always exposed via `trust explain`, so the score is never opaque.
   - Weights are configurable per engine via a `~/.kindx/trust-weights.json` file (read at startup, validated by Zod).
   - The override mechanism gives operators a clean escape hatch.
   - We do not surface trust as the primary ranking signal; it is decoration, not ranker input. (Reordering by trust is a future extension.)

4. **Watcher latency under load.** On large vaults, the debounce → recompute path can drift behind change events. Mitigations:
   - Freshness recompute is O(1) per affected path; the bottleneck is SQLite write throughput, not computation.
   - The recompute queue is bounded and drops dupes; backpressure is observable via diagnostics.
   - For very large vaults, the reconciliation walk picks up missed updates on its periodic tick.

5. **Additive response bytes.** Every search response grows by approximately 200–500 bytes per result row when all three decorations are present. For high-throughput callers this is non-trivial. Mitigations:
   - Decoration is opt-out per request via `decorate=false`.
   - The factor array can be elided in MCP responses via a per-tool `include_factors: false` input flag (defaulting to true).

6. **Sidecar file proliferation.** Writing `.kindx-sig` next to every signed file can clutter version control. Mitigations: sidecars are opt-in via `--out sidecars` on the sign command; we document the suggested `.gitignore` pattern; sidecar emission is per-batch, not per-event.

7. **Migration risk on large existing databases.** The migration only adds tables, so it is fast, but the indexing operations have non-trivial startup cost on large vaults if a future change adds a backfill. We commit to no backfill in this migration; trust and freshness are computed lazily on first read or first watcher event.

8. **RBAC gaps.** A new tool means a new RBAC entry point. The mitigation is to wire each MCP tool registration through the existing `engine/rbac.ts` middleware and add a dedicated `specs/rbac-provenance.test.ts` that exercises every tool against denied tenants.

9. **Cryptographic agility.** Ed25519 is hard-coded today. The `alg` column exists in `document_signatures` precisely so we can add new algs (e.g., a post-quantum primitive) later without a schema change, but the verify path is not yet alg-dispatched. We accept this risk for v1.5.0 with a TODO in `verify.ts`.

10. **Concurrent sign of the same hash.** Two callers signing the same hash with two different default keys concurrently can race. The `(hash, signer_kid)` primary key serializes per-kid; cross-kid races are by-design (multi-sig) and not a bug.

11. **Sidecar drift.** A `.kindx-sig` sidecar can fall out of sync with the `document_signatures` row if a user manually edits the sidecar. The verify path always recomputes the hash from the file bytes and treats the sidecar as authoritative only when the DB row is missing, so drift never produces a silent false-positive. We document this clearly in the operator guide.

12. **Recompute storms.** A pathological pattern (e.g., a script that touches every file in the vault in a tight loop) can saturate the recompute queue. Mitigations: the queue is bounded, deduped, and drained on a fixed cadence; the watcher emits a diagnostics warning when the queue depth exceeds 10x the documents-per-second baseline.

13. **Schema version skew across clients.** A v1.3 client and a v1.5 client can both connect to the same server. The wire contract is backward-compatible (additive), but a v1.3 CLI cannot invoke the new tools. The mitigation is a clear error message from the protocol layer when an unknown tool is invoked.

14. **Operator confusion between trust and relevance.** Users may interpret a low trust score as low relevance. The mitigation is documentation, not code: trust is a separate axis from rank, and the CLI annotates them distinctly. The fact that trust is not yet a ranker input (a deliberate non-goal) helps prevent this conflation.

15. **Audit log volume.** Every mutating operation writes an audit entry. On a large CI integration that signs every release, this is a meaningful row count. Mitigation: the existing audit retention policy applies; this branch does not introduce any new categorical event that would dominate the log.

## Non-goals

The following are explicitly out of scope for this branch and should be deferred to follow-up work:

- **Full PKI hierarchy and CA trust roots.** We are not building or integrating with a certificate authority. `signer_keys.trust_state` is a flat local concept.
- **X.509 certificates.** Public keys are raw Ed25519 bytes, not certificates. We do not parse or validate X.509 chains. Importing from an X.509 source is a follow-up.
- **Blockchain or distributed-ledger anchoring of signatures.** Signatures live in SQLite and optionally in sidecars; we do not anchor to any external ledger.
- **Signed reranker outputs.** The hybrid ranker's output is not itself signed. Only source documents are. Signing rerank decisions is a credible future feature but is out of scope here.
- **Signed search responses.** The MCP / HTTP response envelope itself is not signed in v1.5.0. (Per-result `provenance` is.) Wrapping the full response in a signature is a follow-up that pairs with the observability branch.
- **Cross-engine federated trust.** Trust scores from a peer KINDX node do not influence the local trust score. The A2A branch will carry `provenance.fetch_chain` across hops, but trust composition stops at the local engine.
- **Automatic key rotation policies.** Key rotation is documented and supported via the CLI but not scheduled or automated.
- **Encryption at rest of private keys.** Private key files are protected by file system permissions. A passphrase-wrapped variant is a future extension.
- **Post-quantum signatures.** Reserved via the `alg` column but not implemented.
- **Trust as a ranking input.** v1.5.0 surfaces trust on results; it does not feed trust into the hybrid ranker. A `trust_boost` factor in the ranker is a future flag.
- **Per-field freshness.** Freshness is at the document level, not at the field or chunk level. Per-chunk freshness can be revisited if specific use cases demand it.

## Future extensions

Once this branch is in, several adjacent features become straightforward:

- **Sigstore-style transparency log.** Append every signing event to an external transparency log (Rekor or equivalent). The `document_signatures` table is already content-addressed, so emission is mechanical; verification can then require a witnessed timestamp.
- **In-toto attestations.** Replace the simple Ed25519 detached signature with a richer in-toto envelope that carries predicates (e.g., "produced by this build pipeline at this commit"). The `alg` column generalizes naturally to an `envelope_format` extension.
- **Multi-party signing thresholds.** Require N-of-M signatures from a configured key set before a document's `signer_presence` factor counts as 1.0. The `document_signatures (hash, signer_kid)` composite key already supports many signatures per hash; the only new piece is a `signing_policy` table.
- **Trust as a soft ranker input.** Add a configurable boost in `engine/repository/retrieval/hybrid.ts` that multiplies the hybrid score by a function of the trust score before final sort. Gated on a feature flag; disabled by default.
- **Freshness-driven recrawl.** When a document transitions to `stale`, optionally enqueue a recrawl job (for HTTP-sourced content) or a reindex (for local content). This requires a job queue, deferred to the observability or scheduler branch.
- **Provenance graphs.** Combined with `document_links`, expose a graph endpoint that returns the full provenance subgraph for a result, including upstream sources and downstream consumers. The data is all already in SQLite; the missing piece is a graph query API.
- **Encrypted private key storage.** Add an opt-in passphrase wrap for private keys using libsodium's `crypto_secretbox`. Stored under the same filename with a `.enc` suffix.
- **Per-tenant signer policies.** Allow a tenant to declare "only signatures by these kids are trusted in my collections", overriding the engine-level `signer_keys.trust_state`.
- **Freshness webhooks.** When a document transitions out of `fresh`, fire a webhook. Useful for incident response collections.
- **Signed sidecar bundles.** A single `.kindx-sig.bundle` per directory that contains all sidecar signatures for the directory, reducing file count.
- **Cross-engine signature propagation over A2A.** When the A2A branch lands, signatures travel with the document; the receiving engine can verify locally and decide whether to trust the originating signer.
- **UI provenance badges.** A future TUI / web UI consumes the additive fields directly and renders trust glyphs, freshness colors, and signer popovers. No further engine work required.
- **Trust score history.** Persist a rolling window of past trust scores per document so that the score over time is itself a queryable signal. Useful for spotting documents whose trust degraded silently.
- **Freshness alerting.** A small daemon-mode emitter that watches `document_freshness.sla_state` transitions and pushes them to a configured channel (webhook, MQTT, syslog). The data is already there; the missing piece is the emitter.
- **Pluggable factor registry.** Allow operators to drop a `~/.kindx/trust-factors.d/*.mjs` file that exports a factor implementation; the scorer dynamically registers it. Locks down execution via a small allowed-imports list. Gives advanced operators full control without forking the engine.
- **HSM and OS keychain integration.** Add a `KINDX_KEYS_BACKEND=keychain|hsm|file` env var; the keychain backend uses macOS Keychain / Windows DPAPI / Linux Secret Service. The signing path is abstracted as `sign(message, kid)`; backend swap is a single interface implementation.
- **Provenance-aware diff.** A `kindx diff <path>@<sig-1> <path>@<sig-2>` command that takes two signature kids and shows the content diff between the signed snapshots. Requires keeping signed content in the content-addressable store, which we already do.
- **Re-sign on schedule.** A cron-driven re-sign pass that refreshes signatures past a configurable age, useful for environments where signature recency is itself a compliance signal.
- **Sidecar bundling for distribution.** A `kindx provenance pack <collection>` that bundles content + sidecars into a self-describing archive that can be verified offline by a third party with only the public key.

## Merge notes

This branch is designed to merge cleanly into `main` ahead of the observability and A2A branches. Three points coordinate the merge:

1. **Additive `SearchResult` fields are forward-compatible.** Existing clients of `KindxSearchResultSchema` continue to parse v1.5.0 responses because the new fields are `.optional()`. The base schema (`KindxSearchResultBaseSchema`) is re-exported for any caller that explicitly wants the v1.3-shape; nothing in the engine itself uses the base schema after the decoration pass, but it remains in the public API as an opt-out.

2. **Observability branch reads provenance/trust/freshness fields if present.** The observability work (in flight on `feat/observability`) emits per-query telemetry; it has already been updated in design to record `trust.score` distributions and `freshness.sla_state` counts when those fields are present in the result set. Because both branches independently parse responses through `KindxSearchResultSchema`, no merge conflict on the wire format is expected; the only conflict surface is `engine/protocol.ts` where both branches register new tools. Conflict resolution is mechanical (concatenate tool registrations).

3. **A2A branch propagates `provenance.fetch_chain` across peer hops.** The federation work appends one entry to `provenance.fetch_chain` per network hop. When this branch merges first, the A2A branch only has to:
   - Initialize `fetch_chain` to `[{ kind: 'file' | 'http' | 'mcp', ref, observed_at }]` at the originating engine if it is not already present.
   - Append `{ kind: 'a2a', ref: peer_uri, observed_at: now }` on every cross-engine relay.
   - The receiving engine treats the chain as authoritative metadata, not as trust input.

Pre-merge checklist:

- All acceptance criteria signed off.
- Migration applied to a staging snapshot and confirmed idempotent.
- `KINDX_SCHEMA_VERSION` bumped to 13 in exactly one place.
- `CHANGELOG.md` updated with the v1.5.0 entry summarizing the three additive fields and the new CLI / MCP / HTTP surfaces.
- `examples/provenance/` walkthrough added and verified end-to-end.
- Diagnostics output reviewed for the three new health checks.
- RBAC tests cover every new MCP tool and HTTP route.
- Performance gates green on the baseline profile and on a 10k-document fixture.

Post-merge follow-ups (tracked as separate issues, not blocking the merge):

- Write the operator-facing key rotation runbook under `docs/ops/`.
- Add a `kindx provenance bundle` CLI command for batch sidecar export (carved out of scope as a v1.5.1 nicety).
- Wire `trust.score` distributions into the observability dashboard once that branch lands.
- Coordinate with the A2A branch owner on `fetch_chain` semantics during cross-engine relay (already aligned in design, but a joint test fixture is desirable).
- Investigate moving the trust scorer onto a worker thread for very large recompute passes; current synchronous implementation is acceptable for the v1.5.0 acceptance gates but may become a hotspot beyond 100k documents.
- Add a maintenance command (`kindx maintenance prune-signatures`) to reap orphan signatures whose hashes are no longer referenced by any active document.
- Add a `kindx provenance show --all-versions <path>` variant that walks `document_versions` and emits signatures across the lineage.
- Audit the diagnostics output for cardinality — the three new checks should not produce more than a handful of lines on a healthy engine.

### Coordination matrix with adjacent branches

The branch lives between `feat/observability` and `feat/a2a-peer-federation`. The coordination contract:

- **vs. `feat/observability`.** Both branches extend `KindxSearchResultSchema`. Provenance/trust/freshness land first; observability rebases on top and adds its own optional fields. The merge order is `provenance-trust-freshness → main → observability rebase`. The protocol registration order in `engine/protocol.ts` is enforced by an `import` ordering convention rather than physical line order, so conflicts are limited to the registration block.
- **vs. `feat/a2a-peer-federation`.** A2A reads `provenance.fetch_chain` and appends one hop per relay. The branch contract is one-way: A2A imports types from `@kindx/schemas` and does not modify them. The reverse dependency does not exist.
- **vs. existing `engine/audit.ts`.** New event kinds are appended; no existing kinds are renamed or repurposed. Audit consumers that filter by kind continue to ignore unknown kinds (the existing tail/parsing tools are tolerant).
- **vs. existing `engine/diagnostics.ts`.** Three new checks added; no existing check is removed. The diagnostics JSON output gains three keys; consumers iterating over checks (the recommended pattern) pick them up automatically.

### Final scope statement

This branch ships, in one coherent unit: detached Ed25519 signing tied to content hashes; a composite trust score with explainable factors and operator overrides; per-collection freshness policies driven by the watcher; an additive decoration pass on hybrid search results; CLI, MCP, and HTTP surfaces over all of the above; a forward-only migration; and the test, performance, and security gates required to ship to v1.5.0. Anything beyond that is in the future-extensions list.

The design is intentionally conservative: no new top-level dependencies, no breaking changes, no opinion injected into the ranker, and no cloud requirements. The features compose with the engine's existing local-first posture and leave every escape hatch (sidecars, overrides, opt-out decoration, configurable weights) open for operators who need to depart from the defaults.

### Appendix: glossary

- **Content hash.** The SHA-256 of the indexed document bytes, stored as the primary key of the `content` table. Signatures are over this value, not over the path.
- **Kid.** A 16-byte truncation of the SHA-256 of the public key, lower-hex encoded. Stable, self-verifying, and short enough to be human-pasteable.
- **Sidecar.** A small file next to the source content named `<filename>.kindx-sig`, containing a versioned encoding of `kid:signature`.
- **Factor.** One named contribution to a composite trust score. Each factor has a weight in `[0, 1]`, a value in `[0, 1]`, and a contribution computed as `weight * value`.
- **Override.** A persistent operator-set trust score for a specific `(collection, path)` that replaces the factor-derived score until cleared.
- **Policy.** A per-collection (optionally per-glob) freshness contract: `ttl`, `warn`, `fail` thresholds, with `most-specific-wins` resolution against a target path.
- **SLA state.** One of `fresh`, `warn`, `stale`, `unknown`. Computed from age and the resolved policy; persisted in `document_freshness`.
- **Decoration.** The post-rank pass on hybrid search results that batch-loads provenance, trust, and freshness for the returned rows and attaches them additively to the response.
- **Fetch chain.** The ordered list of hops a piece of content traversed before reaching the engine (`file`, `http`, `mcp`, `a2a`). Each entry carries an observation timestamp.
- **Trust dirty set.** An in-memory deduplicating queue of `(collection, path)` pairs whose trust score should be recomputed at the next scheduled tick.

This branch is the foundation for treating KINDX results as audit-grade artifacts. After it lands, every downstream surface — observability dashboards, A2A federation, future UI work, compliance reports — can rely on a stable contract that says: every result carries its own evidence, its own score, and its own clock.
