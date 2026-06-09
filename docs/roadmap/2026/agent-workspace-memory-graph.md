# Agent Workspace Memory Graph

A typed entity / relation / observation layer over KINDX's existing scoped KV
memory store, plus a traversal API and a graph-aware hook into hybrid
retrieval. The goal is to give long-running agents a persistent, local-first
"working memory" that knows about *things* and *how those things relate*,
without leaving SQLite and without introducing a separate graph database.

## Branch

`feat/agent-workspace-memory-graph`

Targets `main` at KINDX `v1.3.5`. Cuts release `v1.4.0` (minor; additive
surface area, forward-only migration `00X_memory_graph.sql`, no breaking
changes to existing memory APIs).

Branch is designed to be merged independently of, but compose cleanly with,
three siblings:

- `feat/provenance-trails` — entities and relations expose a `provenance`
  property bag; the graph layer is provenance-aware but does not require
  provenance to function.
- `feat/observability-traces` — every entity/relation/observation mutation
  emits a span; traversal queries emit a parent span with neighbor counts
  and depth as attributes.
- `feat/agent-to-agent` — peers can export a sub-graph (`memory.graph.export`)
  and another peer can ingest it (`memory.graph.import`), allowing partial
  shared world models.

## Owner type

Single-maintainer, scoped to the `engine/memory/**` and `engine/repository/
retrieval/**` packages. No infra dependencies, no new runtime services, no
external graph engine. Reviewable as one large but mechanically simple PR
because each new module is independent and the migration is forward-only.

## Problem

KINDX agents today have two memory primitives:

1. **KV memory** in `engine/memory.ts` — scoped, semantically deduped via
   cosine ≥ 0.92, with supersession chains, TTL, tags, hit-rate, and
   lifecycle consolidation. Excellent for "remember this fact" or "remember
   this preference."
2. **Document link extraction** in `engine/repository/link-extractor.ts` —
   flat `document_links` rows joining one doc to another. Useful for crawl
   neighborhoods but not exposed as a traversal API.

Neither primitive lets an agent encode statements like:

- `Project("KINDX") DEPENDS_ON Library("better-sqlite3")`
- `Person("Ritesh") OWNS Project("KINDX")`
- `Project("KINDX") HAS_COMPONENT Module("engine/memory.ts")`

…and then ask *"give me everything in the 2-hop neighborhood of Project
KINDX in workspace scope, filtered to relations of kind DEPENDS_ON."*

Concretely, the following user journeys are blocked:

- **Decision recall.** "What does the agent know about `engine/memory.ts`?"
  Today the answer is a free-text grep over memory values. There is no
  notion of `engine/memory.ts` as a first-class entity.
- **Context expansion for retrieval.** A query like "how does the memory
  consolidator pick which memories to merge?" should pull in entities like
  `MemoryConsolidator`, `MemoryRecord`, `cosine`, and follow relations to
  the actual code paths. Today hybrid retrieval sees only tokens and
  embeddings.
- **Cross-session continuity.** Session A learns that `LinkExtractor`
  outputs feed `HybridRetriever`. Session B starts fresh and has to
  re-derive that. A graph in workspace scope persists this knowledge.
- **Auditable agent reasoning.** When a subagent writes "I concluded X
  because of Y," there is no structure to point at — only a value blob.
- **Portability.** Users cannot dump the agent's world model to a file and
  reload it on another machine, or diff two snapshots.

## Why now in 2026

Three trends converged in the last 18 months and turn this from a "nice to
have someday" into table stakes for any local agent runtime:

1. **Long-horizon agent loops.** The dominant interaction is no longer a
   single-turn query but a multi-day, multi-session investigation. The
   harness has to keep facts straight for *weeks*, and flat KV is the
   wrong shape — you lose connective tissue. Every serious agent vendor
   (LangGraph, Letta, Mem0, LightRAG) ships some form of graph memory.
2. **GraphRAG and friends.** Microsoft's GraphRAG paper, LightRAG, and the
   subsequent wave of "knowledge-graph augmented retrieval" papers all
   show double-digit improvements in Hit@k on multi-hop questions over
   vanilla dense retrieval. KINDX's hybrid retriever leaves that on the
   table.
3. **A2A and federation.** With the agent-to-agent branch in flight, peers
   need a portable, schema-stable way to exchange "what I know about the
   world." JSON-LD and RDF-Turtle are decades old; JSONL-of-triples is
   trivial. The graph layer makes federation tractable.

Crucially, SQLite has matured enough — recursive CTEs, FTS5, JSON1, the
`generated columns` machinery — that a serviceable graph engine fits in a
few hundred lines of SQL. We do not need Neo4j, Memgraph, Kuzu, or DuckDB
to ship the v1 of this.

## Competitive gap

| Tool                | Graph memory | Local-first | SQLite only | Typed entities | Traversal CTE | Hybrid expansion | Import/export |
|---------------------|:------------:|:-----------:|:-----------:|:--------------:|:-------------:|:----------------:|:-------------:|
| LightRAG-MCP        | yes          | partial     | no (faiss)  | weak           | n/a           | yes              | partial       |
| LlamaIndex KG       | yes          | partial     | no          | yes            | n/a           | yes              | yes           |
| Mem0                | yes (hosted) | no          | no          | yes            | hidden        | yes              | partial       |
| Letta               | yes          | partial     | no          | yes            | hidden        | partial          | yes           |
| Neo4j + plugin      | yes          | optional    | no          | yes            | cypher        | manual           | yes           |
| Memgraph            | yes          | optional    | no          | yes            | cypher        | manual           | yes           |
| Kuzu / DuckDB-PGQ   | yes          | yes         | no          | yes            | yes           | manual           | yes           |
| **KINDX (today)**   | **no**       | **yes**     | **yes**     | **no**         | **no**        | **no**           | **no**        |
| **KINDX (this PR)** | **yes**      | **yes**     | **yes**     | **yes**        | **yes**       | **yes**          | **yes**       |

The right column is where we want to land. Nobody else gives you a typed,
traversable, scoped, deduped, locally-persisted graph that round-trips to
JSONL and Turtle and feeds into a hybrid retriever — all on a single
SQLite file.

## KINDX opportunity

KINDX's existing differentiators stack neatly under a graph layer:

- **Scope discipline.** `memory_scope_config` and `KindxSession`'s
  `explicit > session > workspace > default` resolution already exist. The
  graph layer reuses the resolver unchanged; entities and relations carry
  a `scope` column that gates every read and write.
- **Semantic dedup.** `entity.name` is normalized and runs through the
  same cosine-≥-0.92 path. Two entities created from `"better-sqlite3"`
  and `"better_sqlite3"` collapse to one with a supersession chain.
- **Forward-only migrations.** The schema is appended, never rewritten.
  Existing memory rows are untouched.
- **Single-file portability.** Backups remain `cp kindx.db elsewhere/`.
- **MCP-native.** Every new capability ships as a Zod-typed MCP tool, a
  CLI subcommand, and an HTTP endpoint, in lockstep.

## User stories

1. *As an agent author*, I want to record "Ritesh OWNS the KINDX project"
   as a typed edge, so that future sessions can answer "what does Ritesh
   own?" without grepping memory values.
2. *As an agent*, when I'm asked about `engine/memory.ts`, I want the
   hybrid retriever to also surface chunks tagged with related entities
   (`MemoryConsolidator`, `MemoryRecord`), so my answer has the right
   neighborhood loaded.
3. *As a power user*, I want `kindx memory graph neighbors <id> --depth 2`
   to print the 2-hop ego graph as JSON or a tree, so I can debug what the
   agent thinks it knows.
4. *As an integrator*, I want to import a JSONL stream of
   entity/relation/observation triples into a fresh workspace scope, so I
   can bootstrap a new agent with curated knowledge.
5. *As a session*, I want to record observations like "saw `cosine` used
   in `dedupBatch()` on 2026-05-22" attached to the `MemoryConsolidator`
   entity, so that the entity accumulates evidence over time.
6. *As a workspace owner*, I want to define a saved graph view —
   `dependencies_of(project)` — and call it with parameters, so I don't
   re-author the CTE every time.
7. *As an A2A peer*, I want to export a sub-graph filtered by scope and
   kind, sign it, ship it, and have the receiving peer ingest it idempotently.
8. *As an auditor*, I want every entity mutation, relation mutation, and
   observation to land in the audit log with actor, before/after, and
   timestamp.

## Proposed UX

The default UX is "graph as a thin layer over memory" — users who don't
care about graphs see no change. Users who do see:

- A new `kindx memory entity / relation / observation / graph ...`
  subcommand tree, mirroring the existing `kindx memory ...` shape.
- A new family of MCP tools under the `memory.entity.*`, `memory.relation.*`,
  `memory.observation.*`, and `memory.graph.*` namespaces.
- A new optional flag on the hybrid retriever, `expandWithGraph`, which
  pulls in chunks attached to neighbors of any entity matched by the
  query terms. Off by default; the existing retrieval path is byte-for-byte
  unchanged unless the flag is set.
- Pretty-printed graphs in the CLI when `--json` is not passed: a tree
  view for `neighbors`, a numbered path for `path`, a table for `list`.

All output is stable under `--json`. The JSON shape is the Zod schema's
output type, so MCP and CLI consumers see exactly the same payload.

## CLI design

The new subtree lives under `kindx memory` and is registered in
`engine/kindx.ts` next to the existing `kindx memory get/put/list/...`.

### Entity CRUD

```
kindx memory entity add \
  --scope workspace \
  --kind Project \
  --name "KINDX" \
  --prop language=typescript \
  --prop repo=https://github.com/ambicuity/KINDX \
  [--json]

kindx memory entity get <id> [--json]

kindx memory entity list \
  --scope workspace \
  [--kind Project] \
  [--name-like "kin%"] \
  [--limit 50] \
  [--json]

kindx memory entity update <id> \
  [--name "Kindx"] \
  [--prop language=typescript] \
  [--unset-prop deprecated] \
  [--json]

kindx memory entity delete <id> [--cascade] [--json]
```

Notes:

- `--prop` may be passed many times; the parser produces a flat
  `Record<string, string | number | boolean>`. Numbers and booleans are
  inferred from `42`/`3.14`/`true`/`false`; everything else is a string.
- `--cascade` removes all relations where the entity is `src` or `dst`,
  and all observations attached to it. Without `--cascade`, delete errors
  if any relation references the entity (FK-style check enforced in code,
  not in SQLite, because we want a friendly error).
- IDs are `ULID`-shaped strings (lexicographically sortable, time-prefixed)
  using the same generator as `engine/memory.ts`.

### Relation CRUD

```
kindx memory relation add \
  --scope workspace \
  --src 01HXXX...A \
  --dst 01HXXX...B \
  --kind DEPENDS_ON \
  [--weight 0.8] \
  [--prop discovered_by=link-extractor] \
  [--ttl 30d] \
  [--json]

kindx memory relation list \
  --scope workspace \
  [--src <id>] \
  [--dst <id>] \
  [--kind DEPENDS_ON] \
  [--limit 100] \
  [--json]

kindx memory relation delete <src> <dst> [--kind DEPENDS_ON] [--json]
```

Notes:

- `--ttl` is parsed by the existing `parseDuration()` from
  `engine/memory.ts`; once `expires_at < now`, the row is hidden by reads
  and physically removed by the consolidator pass.
- A relation without `--kind` on delete removes every kind between `src`
  and `dst`.
- `weight` defaults to `1.0`. The graph expander uses it to rank candidate
  neighbors when more are reachable than the limit allows.

### Observations

```
kindx memory observation add \
  --entity <id> \
  --text "Module exports parseDuration() used by relation TTL." \
  [--source "engine/kindx.ts:lineRef"] \
  [--json]

kindx memory observation list --entity <id> [--since 2026-01-01] [--json]
```

Observations are append-only by design — they are the audit trail of
*what the agent has seen* about an entity. They never supersede each
other. The consolidator may *summarize* them into the entity's `props_json`
later (a future extension), but never deletes them implicitly.

### Graph traversal

```
kindx memory graph neighbors <id> \
  [--depth 1] \
  [--limit 20] \
  [--kind DEPENDS_ON] \
  [--direction out|in|both] \
  [--json]

kindx memory graph path \
  --from <id> \
  --to <id> \
  [--max-hops 4] \
  [--kind DEPENDS_ON] \
  [--json]

kindx memory graph query \
  --view dependencies_of \
  --params project=01HXXX... \
  [--params depth=2] \
  [--json]
```

- `neighbors`: BFS outward from a root entity, capped by depth and limit.
  Default depth is `1`, default limit is `20`. The CLI without `--json`
  prints an ASCII tree; with `--json` it returns
  `{ root, levels: [{depth, entities: [...], relations: [...]}] }`.
- `path`: shortest-path search using a bidirectional BFS with depth cap.
  Returns `null` if no path within `max-hops`; otherwise the ordered list
  of `(entity, relation)` pairs.
- `query`: invokes a saved view, substituting `--params` into its
  parameter slots after validating each against the view's
  `params_schema_json` (Zod-compatible JSON Schema subset).

### Saved views

```
kindx memory graph view save \
  --name dependencies_of \
  --scope workspace \
  --sql "WITH RECURSIVE deps(id, depth) AS (
            SELECT :project, 0
            UNION ALL
            SELECT r.dst, d.depth+1
              FROM memory_relations r JOIN deps d ON r.src=d.id
              WHERE r.kind='DEPENDS_ON' AND d.depth < :depth
          )
          SELECT * FROM memory_entities WHERE id IN (SELECT id FROM deps)" \
  --params project=string,depth=integer

kindx memory graph view list [--scope workspace] [--json]
kindx memory graph view delete --name dependencies_of [--json]
```

Saved views are *not* arbitrary SQL — they are parameterized templates
that the engine compiles once, statically validates against an allowlist
of tables (`memory_entities`, `memory_relations`, `memory_observations`,
`memory_graph_views`), and re-binds at runtime. We do not give callers a
generic SQL exec.

### Import/export

```
kindx memory graph export \
  --scope workspace \
  [--format jsonl|ttl] \
  [--out file.jsonl] \
  [--include-observations] \
  [--filter-kind Project,Module]

kindx memory graph import \
  --scope workspace \
  --format jsonl|ttl \
  --in file.jsonl \
  [--dry-run] \
  [--on-conflict skip|update|fail]
```

- `jsonl` is the canonical format: one record per line, discriminated by
  a `type` field (`"entity" | "relation" | "observation"`).
- `ttl` is a minimal Turtle subset for round-trip with semantic-web tools.
  Entities become subjects, relations become predicates, observations
  become `kindx:observed` triples. We do not implement full RDF; we ship
  enough to be useful and refuse files we can't round-trip.

## MCP design

Each CLI verb has a matching MCP tool. Tool inputs and outputs are Zod
schemas exported from `packages/kindx-schemas/src/index.ts`. Tools are
registered in `engine/protocol.ts` through `engine/tool-registry.ts`.

### Entities

```ts
// memory.entity.upsert
const KindxMemoryEntityUpsertInput = z.object({
  scope: z.string().optional(),
  id: z.string().optional(),                     // present = update
  kind: z.string().min(1).max(64),
  name: z.string().min(1).max(512),
  props: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1),
});

const KindxMemoryEntitySchema = z.object({
  id: z.string(),
  scope: z.string(),
  kind: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  props: z.record(z.unknown()),
  confidence: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  source: z.string().nullable(),
  supersededBy: z.string().nullable(),
});

// memory.entity.get -> { entity: KindxMemoryEntitySchema | null }
// memory.entity.list { scope, kind?, nameLike?, limit?, cursor? }
//                   -> { entities: KindxMemoryEntitySchema[], nextCursor? }
// memory.entity.delete { id, cascade?: boolean } -> { ok: true }
```

### Relations

```ts
const KindxMemoryRelationSchema = z.object({
  src: z.string(),
  dst: z.string(),
  kind: z.string(),
  weight: z.number(),
  props: z.record(z.unknown()),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  source: z.string().nullable(),
});

// memory.relation.upsert { scope, src, dst, kind, weight?, props?, ttl?, source? }
// memory.relation.list   { scope, src?, dst?, kind?, limit?, cursor? }
// memory.relation.delete { scope, src, dst, kind? }
```

### Observations

```ts
const KindxMemoryObservationSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  text: z.string(),
  source: z.string().nullable(),
  observedAt: z.number(),
  evidenceRef: z.string().nullable(),
});

// memory.observation.add { entityId, text, source?, evidenceRef? }
// memory.observation.list { entityId, since?, until?, limit?, cursor? }
```

### Graph traversal and views

```ts
const KindxMemoryGraphNeighborsInputSchema = z.object({
  scope: z.string().optional(),
  id: z.string(),
  depth: z.number().int().min(1).max(6).default(1),
  limit: z.number().int().min(1).max(500).default(20),
  kind: z.string().optional(),
  direction: z.enum(["out", "in", "both"]).default("both"),
});

const KindxMemoryGraphPathInputSchema = z.object({
  scope: z.string().optional(),
  from: z.string(),
  to: z.string(),
  maxHops: z.number().int().min(1).max(8).default(4),
  kind: z.string().optional(),
});

const KindxMemoryGraphQueryInputSchema = z.object({
  scope: z.string().optional(),
  view: z.string(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

// memory.graph.neighbors -> { root, levels: [...] }
// memory.graph.path      -> { path: [{ entity, relation }, ...] | null }
// memory.graph.query     -> { rows: unknown[], columns: string[] }
// memory.graph.export    -> { count, format, bytes? }
// memory.graph.import    -> { applied, skipped, failed, errors[] }
// memory.graph.view      -> save/list/delete variants
```

All tools follow the existing protocol contract: synchronous, return
plain JSON, never throw across the MCP boundary; errors are surfaced as
`{ error: { code, message, details? } }`.

## HTTP API design

Mirrors MCP one-to-one for callers that prefer REST. All endpoints
accept and return JSON; scope is derived from the `X-Kindx-Scope`
header, then from the session, then from workspace, then from default,
matching the existing resolver.

```
POST    /memory/entities                       { kind, name, props?, ... }
GET     /memory/entities?scope=&kind=&nameLike=
GET     /memory/entities/:id
PATCH   /memory/entities/:id                   { name?, props?, ... }
DELETE  /memory/entities/:id?cascade=true

POST    /memory/relations                      { src, dst, kind, weight?, ... }
GET     /memory/relations?src=&dst=&kind=
DELETE  /memory/relations/:src/:dst?kind=

POST    /memory/observations                   { entityId, text, source? }
GET     /memory/observations?entityId=&since=&until=

GET     /memory/graph/neighbors?id=&depth=&limit=&kind=&direction=
GET     /memory/graph/path?from=&to=&maxHops=&kind=
POST    /memory/graph/query                    { view, params }
GET     /memory/graph/export?scope=&format=&includeObservations=
POST    /memory/graph/import                   (multipart: file=, format=)

GET     /memory/graph/views
POST    /memory/graph/views                    { name, sql, paramsSchema }
DELETE  /memory/graph/views/:name
```

Response envelopes:

```jsonc
// success
{ "ok": true, "data": { ... } }

// error
{ "ok": false, "error": { "code": "ENTITY_NOT_FOUND", "message": "...", "details": { ... } } }
```

All write endpoints return `201` on creation, `200` on update; reads are
`200` or `404`. Standard `ETag` on entity GETs (`W/"<updated_at>"`) so
clients can do conditional `PATCH` with `If-Match` to avoid lost updates.

## Schema changes

Forward-only migration `engine/migrations/00X_memory_graph.sql`. Bumps
`KINDX_SCHEMA_VERSION` from its current value to `current + 1`. The
migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF
NOT EXISTS`) so a partial apply followed by a re-run completes cleanly.

```sql
-- 00X_memory_graph.sql

CREATE TABLE IF NOT EXISTS memory_entities (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  props_json      TEXT NOT NULL DEFAULT '{}',
  embedding_ref   TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  source          TEXT,
  superseded_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_scope_kind
  ON memory_entities(scope, kind);
CREATE INDEX IF NOT EXISTS idx_memory_entities_normalized_name
  ON memory_entities(normalized_name);
CREATE INDEX IF NOT EXISTS idx_memory_entities_updated_at
  ON memory_entities(updated_at);

CREATE TABLE IF NOT EXISTS memory_relations (
  src         TEXT NOT NULL,
  dst         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  props_json  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  source      TEXT,
  PRIMARY KEY (src, dst, kind)
);

CREATE INDEX IF NOT EXISTS idx_memory_relations_src
  ON memory_relations(src);
CREATE INDEX IF NOT EXISTS idx_memory_relations_dst
  ON memory_relations(dst);
CREATE INDEX IF NOT EXISTS idx_memory_relations_kind
  ON memory_relations(kind);
CREATE INDEX IF NOT EXISTS idx_memory_relations_expires_at
  ON memory_relations(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_observations (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  text          TEXT NOT NULL,
  source        TEXT,
  observed_at   INTEGER NOT NULL,
  evidence_ref  TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_observations_entity_id
  ON memory_observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_observations_observed_at
  ON memory_observations(observed_at);

CREATE TABLE IF NOT EXISTS memory_graph_views (
  name              TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  sql_template      TEXT NOT NULL,
  params_schema_json TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_entities_fts USING fts5(
  name,
  normalized_name,
  content='memory_entities',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts USING fts5(
  text,
  content='memory_observations',
  content_rowid='rowid',
  tokenize='unicode61'
);

-- Triggers to keep FTS in sync. Same pattern used elsewhere in KINDX.
CREATE TRIGGER IF NOT EXISTS memory_entities_ai AFTER INSERT ON memory_entities BEGIN
  INSERT INTO memory_entities_fts(rowid, name, normalized_name)
  VALUES (new.rowid, new.name, new.normalized_name);
END;
CREATE TRIGGER IF NOT EXISTS memory_entities_ad AFTER DELETE ON memory_entities BEGIN
  INSERT INTO memory_entities_fts(memory_entities_fts, rowid, name, normalized_name)
  VALUES ('delete', old.rowid, old.name, old.normalized_name);
END;
CREATE TRIGGER IF NOT EXISTS memory_entities_au AFTER UPDATE ON memory_entities BEGIN
  INSERT INTO memory_entities_fts(memory_entities_fts, rowid, name, normalized_name)
  VALUES ('delete', old.rowid, old.name, old.normalized_name);
  INSERT INTO memory_entities_fts(rowid, name, normalized_name)
  VALUES (new.rowid, new.name, new.normalized_name);
END;

CREATE TRIGGER IF NOT EXISTS memory_observations_ai AFTER INSERT ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_observations_ad AFTER DELETE ON memory_observations BEGIN
  INSERT INTO memory_observations_fts(memory_observations_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
```

Notes on storage choices:

- `props_json` is `TEXT` with a `CHECK(json_valid(props_json))` constraint
  applied at the application layer (we want a typed error, not a SQLite
  one). Maximum depth is enforced in code at 4; deeper trees error.
- `embedding_ref` is a pointer into `memory_embeddings` (existing table)
  so entities can share the same embedding pool as KV memories. Not
  populated in v1; reserved for the auto-extraction extension.
- `superseded_by` mirrors the supersession pattern from `memory.ts` so
  that semantic-dedup merges of entities follow the same chain shape.
- `memory_relations` deliberately has no surrogate `id`. The triple
  `(src, dst, kind)` *is* the identity. This keeps imports idempotent.

## Storage / index changes

Index rationale, with the worst-case query each one supports:

- `idx_memory_entities_scope_kind` — `WHERE scope=? AND kind=?` is the
  bread-and-butter lookup for `entity list`.
- `idx_memory_entities_normalized_name` — dedup check on insert and
  `--name-like` scans.
- `idx_memory_entities_updated_at` — recently-modified listings and
  consolidation passes.
- `idx_memory_relations_src` / `_dst` — BFS expansion in both directions.
- `idx_memory_relations_kind` — filtered traversal by relation kind.
- `idx_memory_relations_expires_at` (partial) — TTL sweeps don't scan the
  whole table.
- `idx_memory_observations_entity_id` — `observation list --entity` and
  the entity-detail page join.
- `idx_memory_observations_observed_at` — `--since` filters.

FTS5 virtual tables on entity names and observation text give us fast
fuzzy lookup for `--name-like` and for the query-time entity extraction
in the graph expander.

WAL mode and `PRAGMA foreign_keys=ON` are already set by KINDX bootstrap;
the new tables inherit both. We deliberately do *not* declare FK
constraints between `memory_relations` and `memory_entities` so that
import can land relations before their endpoints (and `import` can
re-order them in a single transaction). Application-level integrity is
enforced by `engine/memory/relations.ts`.

## Implementation plan

Six phases, each landable independently behind a single feature flag
`KINDX_MEMORY_GRAPH=1`. The flag exists only during development; the
feature is on by default at merge time.

### Phase 1 — schema + migrations (≈1 day)

- Write `engine/migrations/00X_memory_graph.sql`.
- Wire it into the migration runner. Verify idempotency.
- Bump `KINDX_SCHEMA_VERSION`.
- Update `docs/architecture/schema.md` with new tables (existing doc, not
  a roadmap).

### Phase 2 — core CRUD (≈2 days)

- `engine/memory/entities.ts`: `upsert`, `get`, `list`, `update`, `delete`,
  `findByNormalizedName`, `dedupOnInsert` (cosine ≥ 0.92, reuses
  `engine/memory.ts`'s embedder hook).
- `engine/memory/relations.ts`: `upsert`, `list`, `delete`, `expireSweep`.
- `engine/memory/observations.ts`: `add`, `list`, `pruneOlderThan`.
- All three import `engine/memory.ts`'s scope resolver and `auditEvent`
  helper so behavior is identical for scope handling and audit emission.

### Phase 3 — traversal CTEs (≈2 days)

- `engine/memory/graph/traverse.ts`: `neighbors(rootId, opts)`,
  `path(from, to, opts)`. Implemented as recursive CTEs with depth and
  visited-set bookkeeping in SQL (not in JS) so the round-trips stay flat.
- `engine/memory/graph/views.ts`: save/list/delete; runtime validator
  that the saved SQL touches only allowlisted tables and uses only named
  parameters that appear in `params_schema_json`.

### Phase 4 — graph expander hook (≈1 day)

- `engine/memory/graph/expander.ts`: given a query string and options,
  extract candidate entity references (FTS5 match against
  `memory_entities_fts`), pull their 1- or 2-hop neighborhood, project
  to the chunk space (via `embedding_ref` and the existing
  `document_links` table), and return a re-rankable candidate set.
- `engine/repository/retrieval/hybrid.ts`: extend `HybridQueryOptions`
  with `expandWithGraph?`; if set, call the expander before the rerank
  stage and merge candidates with a configurable weight (default 0.3 of
  total score budget).

### Phase 5 — CLI / MCP / HTTP (≈2 days)

- `engine/kindx.ts`: new commander subcommands.
- `engine/protocol.ts`: register the new tools through
  `engine/tool-registry.ts`.
- `packages/kindx-schemas/src/index.ts`: Zod schemas exported.
- `packages/kindx-client/src/index.ts`: typed client methods for each
  endpoint.

### Phase 6 — import/export + docs/demo (≈1 day)

- `engine/memory/graph/import.ts`, `engine/memory/graph/export.ts`:
  streaming JSONL and small Turtle subset. Both are transactional;
  partial failure rolls the whole import back unless `--on-conflict skip`
  is passed.
- Author one demo notebook in `examples/memory-graph/`. Author a short
  README in the package describing the JSONL line shape.

Total elapsed wall-clock estimate: 9 dev days. Each phase ends with green
specs and is mergeable.

## File-by-file changes

### New files

- `engine/memory/entities.ts` — entity table accessor; cosine dedup;
  supersession chain helpers; emits `audit.entity.{created,updated,deleted}`.
- `engine/memory/relations.ts` — relation table accessor; TTL sweep
  hook; cycle-tolerant inserts; emits `audit.relation.*`.
- `engine/memory/observations.ts` — append-only writer; range queries;
  optional `pruneOlderThan` for retention.
- `engine/memory/graph/traverse.ts` — `neighbors()`, `path()`, and a
  small private helper `compileTraversalCte()` that emits the right CTE
  depending on direction.
- `engine/memory/graph/expander.ts` — query-to-neighborhood projection
  used by hybrid retrieval.
- `engine/memory/graph/views.ts` — saved-view CRUD and the SQL allowlist
  validator.
- `engine/memory/graph/import.ts` — JSONL/Turtle ingestion.
- `engine/memory/graph/export.ts` — JSONL/Turtle emission.
- `engine/migrations/00X_memory_graph.sql` — the migration above.

### Edited files

- `engine/memory.ts` — re-export the new modules under `memory.entities`,
  `memory.relations`, `memory.observations`, `memory.graph`. Existing
  KV API is unchanged; no signatures change; all existing tests pass
  byte-for-byte.
- `engine/repository/retrieval/hybrid.ts` — extend
  `HybridQueryOptions` with `expandWithGraph?` and invoke the expander
  before rerank. Default off.
- `engine/protocol.ts` — register `memory.entity.*`, `memory.relation.*`,
  `memory.observation.*`, `memory.graph.*` tools via the existing
  registry.
- `engine/tool-registry.ts` — declare the new tool descriptors with their
  Zod schemas.
- `engine/kindx.ts` — wire up the new CLI subtree.
- `engine/session.ts` — no API change; only an internal hint that the
  scope resolver is now reused by graph accessors (documented in code
  comments, not in signatures).
- `engine/audit.ts` — add new event constants
  (`MEMORY_ENTITY_CREATED`, `MEMORY_RELATION_DELETED`, etc.). The audit
  envelope shape does not change.
- `packages/kindx-schemas/src/index.ts` — Zod exports for the schemas
  listed above; additive only.
- `packages/kindx-client/src/index.ts` — typed client methods that wrap
  HTTP endpoints.
- `docs/architecture/schema.md` — append the four new tables.
- `docs/cli/memory.md` — append the new subcommand reference.

### New tests

- `specs/memory-entity-crud.test.ts` — create/get/list/update/delete;
  scope filter; `--cascade` removes relations and observations; semantic
  dedup at cosine ≥ 0.92 collapses near-duplicate names.
- `specs/memory-relation-crud.test.ts` — upsert is idempotent on
  `(src, dst, kind)`; TTL hides expired rows; `relation delete` without
  `--kind` removes all kinds between endpoints.
- `specs/memory-observation.test.ts` — append-only; `--since` filter;
  bulk insert under transaction.
- `specs/memory-graph-neighbors.test.ts` — depth 1/2/3 over a fixture of
  ~20 entities; `direction=out|in|both`; `--kind` filter; limit cap.
- `specs/memory-graph-path.test.ts` — shortest path between connected
  pairs; `null` when no path within `max-hops`; correct path when several
  exist (lex-smallest by relation kind as tie-break).
- `specs/memory-graph-cycle-guard.test.ts` — cycles do not loop; visited
  set in the CTE bounds recursion; depth cap is respected even on
  pathological graphs (K10).
- `specs/memory-graph-import-export.test.ts` — JSONL round-trip;
  Turtle round-trip on a Turtle-clean subset; `--dry-run` reports the
  plan without writing; conflict modes behave as documented.
- `specs/memory-graph-hybrid-expand.test.ts` — golden set with 30
  questions where the correct chunk is two hops away from the queried
  entity; assert Hit@3 improves by ≥ 15 % vs baseline.
- `specs/memory-graph-scope-isolation.test.ts` — entities and relations
  created in `session` scope are invisible from `workspace` scope and
  vice versa; explicit scope override wins.
- `specs/memory-graph-views.test.ts` — saved view round-trip; the SQL
  allowlist rejects views touching forbidden tables; param schema
  validation catches missing/extra/typed-wrong params.

Existing tests (memory KV, hybrid retrieval, protocol, session) must
continue to pass byte-for-byte. CI gate.

## Test plan

The branch ships with the spec files above and the following manual
verification checklist for the release notes:

1. `kindx memory entity add --scope workspace --kind Project --name KINDX`
   returns an entity with a stable ULID and `scope=workspace`.
2. Re-running the same `add` reuses the existing row (semantic dedup),
   bumps `updated_at`, and does not create a duplicate.
3. `kindx memory relation add` between two valid entities is idempotent.
4. `kindx memory graph neighbors <project> --depth 2 --json` matches the
   shape exported by `memory.graph.neighbors` via MCP.
5. `kindx memory graph path --from A --to D` over a known chain
   `A -DEPENDS_ON-> B -DEPENDS_ON-> C -DEPENDS_ON-> D` returns the full
   four-node path.
6. `kindx memory graph export --format jsonl --out /tmp/g.jsonl`
   followed by `import --in /tmp/g.jsonl --scope=fresh` yields an
   identical graph in the new scope.
7. With `expandWithGraph` set, a question about `MemoryConsolidator`
   surfaces a chunk that mentions `cosine` only by virtue of the
   `USES` relation — not by token match.
8. Audit log contains one event per write. Scope leakage probe queries
   return zero rows across scopes.
9. BFS depth 4 over a synthetic 10k-entity / 30k-relation graph
   completes in under 100 ms on commodity hardware (M-series Mac, the
   project's reference target).
10. JSON output is stable under `--json`; pretty output is stable under
    `--no-color` and matches a golden snapshot.

## Acceptance criteria

- All ten manual verification items pass.
- All new spec files green; no existing spec changes required.
- `KINDX_SCHEMA_VERSION` bumped; running v1.3.5 binary against a
  v1.4.0 database errors clearly; running v1.4.0 binary against a v1.3.5
  database migrates forward in one transaction.
- BFS depth 4, breadth ≤ 20 per level, completes in `< 100 ms` on the
  reference machine for a 10k-entity / 30k-relation graph (assertion in
  `memory-graph-neighbors.test.ts` with a generous CI multiplier).
- Cycle detection: graphs with cycles do not produce infinite output,
  do not allocate more than `O(depth × limit)` rows, and respect the
  depth cap exactly.
- Scope isolation: cross-scope reads return zero rows; cross-scope
  writes error with `SCOPE_MISMATCH`.
- JSONL import/export is a fixed point: `export → import → export`
  produces byte-identical output modulo timestamps.
- Hybrid expansion: on the 30-question graph-aware golden set, Hit@3
  improves by ≥ 15 % over the baseline; precision@5 does not regress
  by more than 2 %.
- Every entity/relation/observation write emits exactly one audit event.

## Risks

### Graph blow-up

Dense many-to-many relations can produce exponential BFS frontiers. We
mitigate with: a per-level `limit` cap (default 20), a hard `depth` cap
(max 6 in MCP input, max 4 in HTTP defaults), and a global per-traversal
visited-set bound enforced inside the CTE. The expander applies an
additional `weight`-based ranker so that "popular" relations (high
in-degree) don't crowd out specific ones.

### Name canonicalization

Two agents creating `"KINDX"` and `"kindx"` should land on the same
entity. We normalize via `normalize-text` (lowercase, NFC, collapse
whitespace) before the cosine check. Edge cases: acronyms, language
variants, and stylized names. We accept this is imperfect and provide a
manual `entity merge` flow as a future extension.

### Scope leakage

Every accessor must take `scope` as the first argument and every SQL
statement must include `WHERE scope = ?` for tables that have a scope
column. Relations and observations inherit scope from their endpoint
entity; we verify scope alignment in code and refuse cross-scope
relations with `SCOPE_MISMATCH`. A dedicated `memory-graph-scope-isolation.test.ts`
guards this.

### Hybrid expansion polluting precision

Adding graph neighbors to the retrieval candidate set can hurt precision
on short, lexical queries where the graph adds noise. Mitigations: the
expander activates only when query terms match at least one entity name
via FTS5 above a confidence threshold; the merge weight is capped (0.3
of total budget by default); the feature is opt-in per query via
`expandWithGraph`.

### Props injection

`props_json` is user-controlled JSON. Risks: depth-blow-up, oversized
values, control characters in keys. We enforce `maxDepth=4`,
`maxKeyLength=128`, `maxValueLength=4096`, and `maxObjectKeys=64` at
the application layer; violations error with `INVALID_PROPS`.

### Saved-view SQL injection

`graph view save` accepts SQL templates. Defenses: (1) parsed and
re-emitted via a tiny tokenizer that rejects `;`, comments, `PRAGMA`,
`ATTACH`, `DETACH`, and any identifier outside an allowlist of tables
and columns; (2) only named parameters that appear in
`params_schema_json` may be referenced; (3) values are bound, never
interpolated; (4) at registration time we EXPLAIN the query and reject
plans that touch unintended tables.

### TTL sweep contention

The relation TTL sweep could interfere with hot reads. We piggyback on
the existing memory consolidator pass (low-priority background loop)
rather than running our own ticker, and use small transactions
(`LIMIT 200`) to keep WAL pressure bounded.

### Migration rollback

Forward-only is non-negotiable. We do not ship a `down` script. The
mitigation for "I shouldn't have upgraded" is the existing single-file
backup pattern: `cp kindx.db kindx.db.pre-1.4.0` before running the
migration; documented in the release notes.

## Non-goals

- **Distributed graph.** No replication, no consensus, no
  multi-master. A graph is local to one KINDX instance; cross-peer
  sharing is via export/import.
- **OWL / SHACL / full RDF.** We support a Turtle subset for
  interoperability, not full semantic-web reasoning.
- **Real graph database backend.** No Neo4j, Memgraph, Kuzu, or
  DuckDB-PGQ adapter in this branch. We stay in SQLite. If users need
  Cypher, they can export and load elsewhere.
- **Automatic entity extraction from documents.** Entities are created
  explicitly by callers in v1. The auto-extractor is a future extension
  (below) so we don't ship the heavy LLM-call path before the schema
  is stable.
- **Property graph query language (Cypher / Gremlin / PGQ).** The CTE
  approach is enough for the documented user stories. Adding a query
  language is a future extension.
- **Inline embeddings for entities.** `embedding_ref` is reserved but
  not populated. The deduper uses the entity's *name* embedding via the
  existing memory embedder; full per-entity context embeddings come
  later.
- **A web UI for the graph.** The CLI's pretty-printed tree, plus JSON
  output, is the v1 affordance. A separate `kindx-ui` package may pick
  up visualization later.

## Future extensions

- **Auto entity extraction** during document ingestion. Hook into the
  existing `link-extractor.ts` pipeline; use a small local extractor
  (regex + spaCy-style heuristics, optionally upgraded to an LLM call
  behind a flag) to populate entities and `USES`/`CONTAINS`/`MENTIONS`
  relations from indexed docs. Feeds `evidence_ref` on observations.
- **Property graph query language.** Compile a tiny Cypher subset
  (`MATCH (a)-[r:KIND]->(b) RETURN ...`) down to the same CTE machinery.
  Lets users skip the saved-view step for ad hoc traversals.
- **GraphQL surface.** Expose entities/relations/observations as a
  GraphQL schema with depth-limited resolvers; useful for downstream
  UIs that already speak GraphQL.
- **RDF* / quads.** Add a fourth column (`graph TEXT`) to relations for
  full named-graph support; required for richer Turtle/JSON-LD
  round-trips.
- **Federated graph across A2A peers.** Compose with the A2A branch:
  each peer publishes a manifest of its graph slice; a query planner
  fans out subqueries to peers and merges results. Provenance branch
  ensures each merged row knows which peer it came from.
- **Entity merge / split UX.** `kindx memory entity merge --winner A
  --loser B` rewrites all relations to point at `A`, supersedes `B`,
  and records the merge in observations. Inverse `split` is harder and
  may stay manual.
- **Time-travel.** Use the existing `created_at`/`updated_at` plus a
  small `memory_entity_history` table (event-sourced delta log) to let
  callers ask "what did the agent know on 2026-03-01?"
- **Confidence propagation.** Today `confidence` is a per-row scalar.
  Future work could propagate confidence along traversal paths (multiply
  along edges) so the expander can prefer high-confidence neighborhoods.
- **Vector index for entity embeddings.** When `embedding_ref` is
  populated, expose `entity nearest <id>` to find semantically similar
  entities regardless of name.

## Merge notes

This branch is intentionally additive. No existing API changes shape or
semantics. The migration is forward-only; reading old data with the new
binary works without manual intervention. Reading new data with the old
binary errors at startup with a schema-version mismatch, which is the
existing behavior.

### Composition with `feat/provenance-trails`

Provenance is carried as well-known keys in `props_json` on entities and
relations (`provenance.source`, `provenance.confidence`, etc.). The
graph layer treats these as opaque properties; the provenance branch
adds typed helpers on top. Order of merge does not matter: if
provenance lands first, this branch consumes its helpers; if this
branch lands first, provenance adds its helpers without schema change.

### Composition with `feat/observability-traces`

Every public entry point in `engine/memory/{entities,relations,observations}.ts`
and every traversal in `engine/memory/graph/traverse.ts` opens a span
with attributes `kindx.memory.scope`, `kindx.memory.kind`,
`kindx.memory.entity_id` (where applicable), and for traversals
`kindx.memory.depth`, `kindx.memory.limit`, and
`kindx.memory.result_count`. If the observability branch is not merged,
these calls go to a no-op tracer.

### Composition with `feat/agent-to-agent`

Export/import is the lingua franca. A2A peers exchange JSONL
sub-graphs, optionally signed. We add a small extension point in
`import.ts` to call out to a verification hook; absent the A2A branch,
the hook defaults to "accept all."

### Conflicts and rebase order

No file conflicts are expected with any of the three sibling branches.
Merge order recommendation: provenance → observability → memory graph
→ A2A, because the graph branch's import/export is the natural seam
for federation and benefits from provenance and tracing being already
in place. If timing forces a different order, the branch is
self-contained and merges cleanly in any sequence.

### Release notes outline

- Headline: "Typed entity/relation/observation graph over scoped memory,
  with CTE-powered traversal and a hybrid-retrieval graph-expansion
  hook. SQLite-only, local-first, JSONL/Turtle round-trip."
- Migration warning: bump to schema version N+1; back up `kindx.db`
  before upgrade.
- New CLI: `kindx memory entity|relation|observation|graph ...`.
- New MCP tools: `memory.entity.*`, `memory.relation.*`,
  `memory.observation.*`, `memory.graph.*`.
- New HTTP endpoints: `/memory/entities`, `/memory/relations`,
  `/memory/observations`, `/memory/graph/*`.
- Opt-in hybrid retrieval flag: `expandWithGraph` on
  `HybridQueryOptions`.
- Performance: BFS depth 4 over 10k entities < 100 ms on the reference
  target.
- Known limitations: no automatic entity extraction yet; no Cypher; no
  remote graph DB; Turtle subset only.

### Post-merge follow-ups

1. Ship the `examples/memory-graph/` demo notebook to the docs site.
2. Open a tracking issue for "auto entity extraction during ingest"
   under the future extensions list.
3. Open a tracking issue for "Cypher-subset over CTE" once we have
   real-world traversal patterns to inform the subset.
4. Update the architecture diagram in `docs/architecture/overview.md`
   to add the graph layer next to KV memory.
5. Coordinate with the A2A branch owner to align on JSONL line shape
   and signing envelope before A2A's federation work lands.
