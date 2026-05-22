# KINDX Named Indexes — Design

**Date:** 2026-05-22
**Status:** Draft, awaiting review
**Branch:** `feature/named-indexes`
**Priority:** P0
**Depends on:** Team A (program/strategic-refactor W1 — repository decomposition)

---

## 1. Purpose and Scope

This design introduces **named indexes** — a layer above the existing single-index architecture that gives each index its own SQLite database, collection configuration, RBAC scoping, and lifecycle management. Cross-index query federation is supported via explicit opt-in.

### In Scope

- Each named index has its own SQLite database at `~/.cache/kindx/{indexName}.sqlite`
- Each named index has its own catalog config at `~/.config/kindx/{indexName}.yml`
- Index registry at `~/.config/kindx/indexes.yml` for discovery and lifecycle tracking
- RBAC scoped to indexes + collections (both levels)
- Cross-index query federation via query-time `indexes: string[]` parameter
- Index lifecycle: create, delete, list, migrate (collections between indexes)
- CLI commands: `kindx index {list,create,delete,migrate}`
- MCP tools: `index_list`, `index_create`, `index_delete`, `index_migrate`

### Out of Scope

- Per-index replication, backup scheduling, or encryption policy (use existing per-DB mechanisms)
- Index renaming (delete + recreate as workaround)
- Distributed indexes across machines
- Per-index embedding model configuration

### Success Criteria

- Two named indexes can coexist with independent SQLite databases and independent collection sets
- An RBAC tenant can be granted access to index "alpha" but denied index "beta"
- `kindx query "draft proposal" --indexes alpha,beta` returns merged, deduplicated results with `_index` provenance annotations
- `kindx index create my-project` creates a valid, queryable index
- `kindx index delete my-project --force` removes all artifacts
- `kindx index migrate logs --from alpha --to beta` copies collection data between indexes
- All existing 59 tests pass
- Benchmarks (`bench:quality`, `bench:regressions`, `bench:latency`) within ±5% of baseline
- Existing single-index workflows continue working without changes

---

## 2. Architecture Overview

An **index** is a self-contained unit with exactly one SQLite database and one YAML catalog file. The existing default `"index"` becomes the first named index — zero migration for current users.

### File Layout

```
~/.config/kindx/
├── indexes.yml              ← NEW: index registry (name → metadata)
├── index.yml                ← existing default index catalog (collections)
├── my-project.yml           ← NEW: per-named-index catalog
├── tenants.yml              ← MODIFIED: add allowedIndexes field
└── tenant_secret            ← unchanged

~/.cache/kindx/
├── index.sqlite             ← existing default index DB
├── my-project.sqlite        ← NEW: per-named-index DB
├── index.sqlite-wal         ← WAL sidecar (per DB)
├── my-project.sqlite-wal    ← WAL sidecar (per DB)
└── shards/                  ← per-shard DBs, unchanged (per-parent-DB)
    ├── {collection1}/shard-0.sqlite
    └── {collection2}/shard-0.sqlite
```

### What Changes

| File | Change | Issue List |
|---|---|---|
| `engine/repository/paths.ts` | No logic changes needed — `getDefaultDbPath(indexName)` already accepts index name. Verify during implementation. | Yes |
| `engine/repository/store-init.ts` | No logic changes needed — `initializeDatabase(db)` is DB-agnostic and works with any SQLite file. Verify during implementation. | Yes |
| `engine/catalogs.ts` | Already has `setConfigIndexName()`. Expose helpers for listing indexes via the registry. Duplicate config file discovery from `indexes.yml` entries. | Yes |
| `engine/rbac.ts` | Add `allowedIndexes` field to `Tenant` and `ResolvedIdentity`. Update `enforce()` to check index access, then collection access. Add `allowed_indexes` to tenants.yml schema. | Yes |
| `engine/protocol.ts` | Add `indexes: string[]` param to `query`/`get`/`multi_get` tools. Add 4 new MCP tools: `index_list`, `index_create`, `index_delete`, `index_migrate`. | Yes |
| `engine/repository.ts` | `createStore()` accepts `indexName` parameter. New `createStoreForIndex()` lightweight helper. New `federatedQuery()` function for cross-index fan-out. | No (issue listed paths.ts, catalogs.ts, rbac.ts, protocol.ts instead) |

### New Files

| File | Purpose |
|---|---|
| `engine/index-manager.ts` | Index registry CRUD: load, save, list, register, unregister. Reads/writes `~/.config/kindx/indexes.yml`. Library module consumed by commands, protocol, and repository. |
| `engine/commands/index-command.ts` | CLI subcommands: `kindx index {list,create,delete,migrate}`. Delegates to index-manager for registry ops and to repository for DB ops. |

### What Does NOT Change

- `engine/schema.ts` — same table structure per-index (each DB gets the same schema)
- `engine/sharding.ts` — sharding works identically per-index; shard root is adjacent to each DB
- `engine/store-init.ts` — `initializeDatabase()` unchanged
- `engine/inference.ts`, `engine/encryption.ts`, `engine/backup.ts`, `engine/memory.ts`, `engine/audit.ts`, `engine/ai-usage.ts` — unchanged
- `engine/resilient-store.ts` — unchanged (already re-creates store on failure; just needs index name propagation)

---

## 3. Store Creation & Index Resolution

The current flow creates one store for one database. The new flow creates a store for a specific named index.

### Current Flow

```
kindx.ts / protocol.ts
  → createStore(dbPath?)
    → getDefaultDbPath("index")       // always "index"
    → openDatabase(path)
    → initializeDatabase(db)
```

### New Flow

```
kindx.ts / protocol.ts
  → resolveIndexName()                // from --index flag, KINDX_INDEX env, or "index"
  → createStore(dbPath?, indexName?)
    → getDefaultDbPath(indexName)     // already supports indexName param
    → openDatabase(path)
    → initializeDatabase(db)

  // For cross-index queries:
  → createStoreForIndex(indexName)
    → getDefaultDbPath(indexName)
    → openDatabase(path)
    → initializeDatabase(db)
```

### Implementation Notes

- `getDefaultDbPath(indexName)` at `paths.ts:175` already accepts `indexName` — no change needed
- `createStore()` at `repository.ts:395` currently calls `getDefaultDbPath()` with no argument (defaults to `"index"`). Add optional `indexName` parameter that propagates to `getDefaultDbPath()`
- `createStoreForIndex(indexName: string): Store` — thin wrapper, analogous to `createStore(resolvedPath)` but derived from the index name
- `resolveIndexName()` reads from (in priority order): `--index` CLI flag, `KINDX_INDEX` env var, `indexes.yml` default field, fallback `"index"`

---

## 4. RBAC — Index + Collection Scoping

Current RBAC scopes tenants to collections within the single index. The new model adds index-level scoping while preserving collection-level.

### Changes to `engine/rbac.ts`

**New field on `Tenant`:**
```typescript
export interface Tenant {
  id: string;
  name: string;
  role: TenantRole;
  tokenHash: string;
  allowedCollections: string[];     // existing — collections within allowed indexes
  allowedIndexes: string[];         // NEW — which named indexes this tenant can access
                                    // ["*"] means all indexes (admin default)
  createdAt: string;
  description?: string;
  active: boolean;
}
```

**Updated `ResolvedIdentity`:**
```typescript
export interface ResolvedIdentity {
  tenantId: string;
  role: TenantRole;
  allowedCollections: string[] | "*";
  allowedIndexes: string[] | "*";   // NEW
}
```

**Updated `enforce()` signature:**
```typescript
export function enforce(
  identity: ResolvedIdentity,
  operation: RBACOperation,
  indexName?: string,               // NEW
  collectionName?: string,
): void {
  // Tier-1: permission check (unchanged)
  if (!isPermitted(identity, operation)) { throw RBACDeniedError; }

  // Tier-2: index access check (NEW)
  if (indexName && !canAccessIndex(identity, indexName)) { throw RBACDeniedError; }

  // Tier-3: collection access check (existing)
  if (collectionName && !canAccessCollection(identity, collectionName)) { throw RBACDeniedError; }

  // Tier-4: rate limit (unchanged)
  enforceRateLimit(identity.tenantId, operation);
}
```

**New helper:**
```typescript
function canAccessIndex(identity: ResolvedIdentity, indexName: string): boolean {
  const allowed = identity.allowedIndexes;
  if (allowed === "*") return true;
  if (!Array.isArray(allowed)) return true; // legacy: no field = open access
  return allowed.includes(indexName);
}
```

**New admin-only operations:**
```typescript
| "index_create" | "index_delete" | "index_migrate" | "index_list"
```
Added to the admin and editor permission sets. Viewer cannot perform lifecycle operations.

**Updated `tenants.yml` format:**
```yaml
tenants:
  agent-alpha:
    id: agent-alpha
    name: "Alpha Agent"
    role: editor
    tokenHash: "hmac:a1b2c3..."
    allowed_indexes: ["my-project", "shared-docs"]
    allowed_collections: ["docs", "designs"]
    createdAt: "2026-05-01T00:00:00Z"
    active: true
```

**Backward compatibility:** When `allowed_indexes` is absent in existing tenant records, default to `["*"]` (all indexes). When loading legacy YAML that lacks the field, populate it as `["*"]` at the type level.

### Cross-Index RBAC Enforcement

For cross-index queries, `enforce()` is called per-index before opening that index's database. Unauthorized indexes are silently skipped — partial results from allowed indexes are returned. This avoids a single denied index blocking the entire query.

---

## 5. Cross-Index Query Federation

Query federation is opt-in at query time via an `indexes: string[]` parameter. Without it, queries target the default/current index (unchanged behavior).

### MCP Tool Schema Changes

**`query` tool:**
```typescript
{
  name: "query",
  inputSchema: {
    query: z.string().describe("Search query"),
    indexes: z.array(z.string()).optional().describe("Named indexes to query. Omits defaults to the current index."),
    collection: z.string().optional(),
    limit: z.number().optional(),
    // ... existing params unchanged
  }
}
```

**`get` and `multi_get` tools** gain the same optional `indexes` parameter.

### Behavior Matrix

| `indexes` param | Action |
|---|---|
| Not provided / `undefined` | Query the caller's current/default index (unchanged behavior) |
| `["alpha"]` | Query only "alpha" index |
| `["alpha", "beta"]` | Fan out to both, merge results |
| `[]` (empty array) | No-op — same as not provided (default index) |

### Fan-Out Implementation

New function in `engine/repository.ts`:

```typescript
interface FederatedMatch extends MatchResult {
  _index: string;             // source index name
}

interface FederatedResult {
  matches: FederatedMatch[];
  indexes_queried: string[];   // which indexes were successfully queried
  indexes_skipped: string[];   // which indexes were skipped (unauthorized, missing, corrupt)
}

function federatedQuery(
  indexes: string[],
  query: string,
  identity: ResolvedIdentity,
  options: QueryOptions,
): FederatedResult {
  const results: { index: string; matches: MatchResult[] }[] = [];
  const skipped: string[] = [];

  for (const indexName of indexes) {
    try {
      enforce(identity, "query", indexName, options.collection);
    } catch {
      skipped.push(indexName);
      continue;
    }
    try {
      const store = createStoreForIndex(indexName);
      const matches = store.hybridQuery(query, options);
      results.push({ index: indexName, matches });
    } catch (e) {
      quietWarn("federated_query.index_failed", { index: indexName, err: errString(e) });
      skipped.push(indexName);
    }
  }

  // Deduplicate by (hash, seq): same content in multiple indexes → keep highest score
  // Annotate each result with source index
  // Merge by descending score, return top-N
  return mergeFederatedResults(results, skipped, options.limit);
}
```

### Deduplication

Content may exist in multiple indexes (especially after migrate). Deduplicate by `(hash, seq)` composite key — keep the highest-scoring copy from any index.

### Result Annotations

Each match in a federated result includes a `_index` field identifying its source index. This enables consumers to display provenance and allows refined re-querying of a specific index.

### CLI Integration

```
kindx query "draft proposal" --indexes alpha,beta
```

The `--indexes` flag accepts comma-separated index names. Output format adds `_index` field when multiple indexes are queried.

---

## 6. Index Registry

A new registry file at `~/.config/kindx/indexes.yml` is the authority on which named indexes exist.

### Schema

```yaml
version: 1
default: "index"             # default index name when none specified
indexes:
  index:
    created_at: "2024-01-01T00:00:00Z"
    description: "Default index"
  my-project:
    created_at: "2026-05-22T10:30:00Z"
    description: "Project Alpha knowledge base"
```

The `db_path` is derived from the index name via `getDefaultDbPath(name)` — not stored redundantly. The registry only stores metadata. If a DB file exists but is not in the registry, it's an orphan (surfaced by `kindx doctor`).

### Operations

- `loadRegistry(): IndexRegistry` — reads and parses `indexes.yml`, caches with mtime invalidation (same pattern as `catalogs.ts:loadConfig`)
- `saveRegistry(registry): void` — writes via `atomicWriteFile`
- `getDefaultIndex(): string` — returns the `default` field or `"index"`
- `listIndexes(): NamedIndex[]` — returns all entries with stats (collection count, DB size) by reading each config

### Edge Cases

- **File missing:** Treated as a legacy deployment. Registry is lazily initialized on first index create or first explicit `--index` use, with the existing `"index"` auto-registered.
- **Concurrent writes:** `atomicWriteFile` prevents corruption.
- **Orphaned DBs:** `.sqlite` files in the cache dir that are not in `indexes.yml` are ignored by normal operations but flagged by `kindx doctor`.

---

## 7. Index Lifecycle

### 7.1 Create

**CLI:** `kindx index create <name> [--description "..."] [--collections <paths>...]`

**MCP:** `index_create` tool (admin only)

**Validation:**
- Name must match `^[a-z][a-z0-9-]{1,63}$` (lowercase, 2-63 chars)
- Name must not already exist in `indexes.yml`

**Process:**
1. Validate name
2. Compute paths: `~/.cache/kindx/{name}.sqlite`, `~/.config/kindx/{name}.yml`
3. Call `openDatabase(dbPath)` → `initializeDatabase(db)` → creates the SQLite DB with full schema, WAL, sqlite-vec, etc.
4. If `--collections` provided, seed a minimal `{name}.yml` catalog with those collection paths
5. Append entry to `indexes.yml` via `atomicWriteFile`
6. Output: "Created index 'my-project' at ~/.cache/kindx/my-project.sqlite"

### 7.2 Delete

**CLI:** `kindx index delete <name> [--force]`

**MCP:** `index_delete` tool (admin only)

**Safeguards:**
- Rejects deletion of the default index (`indexes.yml` default field, typically `"index"`)
- Requires interactive confirmation or `--force` flag

**Process:**
1. Load registry, verify index exists, verify it's not the default
2. Confirm
3. Unlink files: `{name}.sqlite`, `{name}.sqlite-wal`, `{name}.sqlite-shm`
4. Unlink config: `{name}.yml`
5. Unlink shard directory: `shards/{name}/` (if exists)
6. Remove registry entry
7. Output: "Deleted index 'my-project' — removed DB, config, and shards"

### 7.3 List

**CLI:** `kindx index list`

**MCP:** `index_list` tool (all roles; filtered to tenant's allowed indexes)

**Output columns:** Name, Description, Collections (count), Size, Created At, Default (indicator)

### 7.4 Migrate (Collections Between Indexes)

**CLI:** `kindx index migrate <collection> --from <src_index> --to <dst_index>`

**MCP:** `index_migrate` tool (admin only)

**Pre-checks:**
- Both source and destination indexes exist in registry
- Source index contains the named collection
- Both databases have matching schema versions (`PRAGMA user_version`)

**Process:**
1. Open both databases: `srcDb`, `dstDb`
2. Use SQLite `ATTACH DATABASE` to attach source DB to destination DB session
3. Copy collection-scoped data:
   - `INSERT INTO dst.content SELECT * FROM src.content WHERE collection = ?`
   - `INSERT INTO dst.documents SELECT * FROM src.documents WHERE collection = ?`
   - `INSERT INTO dst.document_links SELECT * FROM src.document_links WHERE ...`
   - `INSERT INTO dst.content_vectors SELECT * FROM src.content_vectors WHERE hash IN (SELECT hash FROM src.content WHERE collection = ?)`
   - `INSERT INTO dst.document_ingest SELECT * FROM src.document_ingest WHERE collection = ?`
   - `INSERT INTO dst.documents_fts SELECT * FROM src.documents_fts WHERE docid IN (SELECT docid FROM src.documents WHERE collection = ?)`
4. Copy collection config entry from source YAML to destination YAML
5. Verify row counts match
6. Report: "Migrated collection 'logs' from 'alpha' to 'beta': 1,234 documents, 5,678 content chunks"

**Note:** Source data is preserved (copy, not move). To "move," the user runs delete on the source collection afterwards.

### 7.5 Catalog Awareness

`catalogs.ts` already has `setConfigIndexName()` for switching which config file is read. For named indexes, this function is called before loading a specific index's catalog. Additional helpers:

- `getConfigForIndex(indexName: string): CollectionConfig` — load a specific index's catalog
- `listCollectionsForIndex(indexName: string): NamedCollection[]` — list collections in a specific index's catalog

The existing catalog functions (`loadConfig`, `getCollection`, etc.) continue to work on the current index (set via `setConfigIndexName()`).

---

## 8. Error Handling

| Scenario | Behavior |
|---|---|
| Index not found in registry | Error: "Index 'foo' not found. Use `kindx index list` to see available indexes." |
| Unauthorized index in cross-index query | Silent skip — partial results from allowed indexes returned |
| Index DB locked/busy (cross-index) | Skip that index, log warning, continue with healthy indexes |
| Index DB corrupt (cross-index) | Skip that index, log warning, continue with healthy indexes |
| All cross-index DBs fail | Return empty results with `indexes_skipped` populated |
| Duplicate index name on create | Error: "Index 'foo' already exists." |
| Delete default index | Error: "Cannot delete the default index 'index'." |
| Migrate with schema version mismatch | Error: "Schema version mismatch: source=v1, target=v2. Cannot migrate." |
| Invalid index name on create | Error: "Index name must match [a-z][a-z0-9-]{1,63}." |
| Empty `indexes` array on query | No-op — queries default index (same as not providing param) |
| Orphaned DB file (not in registry) | Ignored by normal ops; flagged by `kindx doctor` |

---

## 9. Backward Compatibility

| Scenario | Behavior |
|---|---|
| Existing user with `~/.cache/kindx/index.sqlite` | Treated as a named index called "index". Zero migration. `indexes.yml` is lazily created on first `kindx index list` or first `--index` flag use. |
| Existing `tenants.yml` without `allowed_indexes` | Default to `allowedIndexes: ["*"]` (open access). No config change needed. |
| Existing `index.yml` catalog | Continues to work as the catalog for the "index" named index. |
| Existing CLI usage without `--index` flag | Defaults to the `default` field in `indexes.yml` (typically "index"). Unchanged behavior. |
| Existing MCP tools without `indexes` param | Continue to work against the default index. Unchanged behavior. |
| `$INDEX_PATH` env var | Still supported — overrides the DB path for the default index. `getDefaultDbPath()` checks it first. |

---

## 10. Implementation Order

Each phase is independently testable and committable:

| Phase | Files | Tests |
|---|---|---|
| **P1: Index Registry** | `indexes.yml` schema, `index-manager.ts` module with CRUD | Unit tests for registry load/save/create/list |
| **P2: Store Per Index** | `repository.ts` (`createStore()` indexName param, `createStoreForIndex()`), `kindx.ts` (`--index` flag), `paths.ts` (verify) | Integration: create two stores for two indexes, verify independent data |
| **P3: RBAC Index Scoping** | `rbac.ts` (`allowedIndexes`, `enforce()` update, tenants.yml schema) | Unit: enforce with index scoping. Integration: tenant restricted to one index |
| **P4: Cross-Index Federation** | `repository.ts` (`federatedQuery()`), `protocol.ts` (`indexes` param on query/get/multi_get tools) | Integration: seed 2 indexes, federated query, verify merge + provenance |
| **P5: CLI Commands** | `engine/commands/index-command.ts` (`list`, `create`, `delete`, `migrate`) | E2E: CLI create/list/delete, CLI migrate |
| **P6: MCP Lifecycle Tools** | `protocol.ts` (`index_list`, `index_create`, `index_delete`, `index_migrate` tools) | Integration: MCP tool calls for lifecycle |

---

## 11. Testing Strategy

| Layer | What | Where |
|---|---|---|
| **Unit: Registry** | `loadRegistry`, `saveRegistry`, name validation, concurrent writes | New `specs/index-registry.test.ts` |
| **Unit: RBAC** | `enforce()` with `allowedIndexes`, `canAccessIndex()`, `["*"]` wildcard | Expand `specs/rbac.test.ts` |
| **Integration: Store-per-index** | Two stores, independent data, verify no cross-contamination | New `specs/index-store.test.ts` |
| **Integration: Federated query** | Seed 2 indexes, query both, verify `_index` annotations and dedup | New `specs/federated-query.test.ts` |
| **Integration: Migrate** | Seed source, migrate to dest, verify row counts, verify source unchanged | New `specs/index-migrate.test.ts` |
| **E2E: CLI** | `kindx index create/list/delete`, `kindx query --indexes a,b` | New `specs/index-cli.test.ts` |
| **Regression** | All 59 existing tests pass. Benchmarks within ±5% | Existing `specs/` |

Tests use `$KINDX_CONFIG_DIR` and `$INDEX_PATH` env vars for isolation (existing convention).

---

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Existing code assumes "index" is the only DB | Phase-based rollout. P1 (registry) is additive. P2 (store per index) is the critical change — gated behind registry existence so legacy path is unchanged until registry is initialized. |
| Cross-index query performance with many indexes | Fan-out is sequential per-index for P0. Parallel fan-out (Promise.all) can be added later if needed. The `indexes` array has no hard limit but large fan-outs (>10) will be slow — document this. |
| SQLite ATTACH for migrate may have locking issues | Both DBs must be in WAL mode (they are). ATTACH is well-supported in better-sqlite3. Fallback: export/import via JSON if ATTACH proves unreliable. |
| Registry file corruption | `atomicWriteFile` prevents partial writes. Mtime-based cache invalidation ensures stale reads are caught. |

---

## 13. Open Questions

- None — all resolved during the brainstorming Q&A.
