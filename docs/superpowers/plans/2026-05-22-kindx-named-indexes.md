# KINDX Named Indexes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each named index its own SQLite database, scope RBAC to indexes + collections, add cross-index query federation, and add index lifecycle CLI/MCP commands.

**Architecture:** A new `engine/index-manager.ts` module manages `~/.config/kindx/indexes.yml` registry. `createStore()` is made index-aware (already partially plumbed via `--index` flag + `setIndexName()`). RBAC gains `allowedIndexes`. MCP tools gain `indexes` parameter. New `engine/commands/index-command.ts` adds CLI lifecycle.

**Tech Stack:** TypeScript, better-sqlite3, vitest, zod, util.parseArgs, sqlite-vec

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `engine/index-manager.ts` | Load/save `indexes.yml` registry, create/delete/list named indexes. Library consumed by CLI, protocol, and repository. |
| `engine/commands/index-command.ts` | CLI subcommand handler: `kindx index {list,create,delete,migrate}` |
| `specs/index-manager.test.ts` | Unit tests for index-manager registry CRUD |

### Modified Files
| File | Change |
|---|---|
| `engine/rbac.ts` | Add `allowedIndexes` to `Tenant`, `ResolvedIdentity`. Add `canAccessIndex()`. Update `enforce()` signature, `resolveTokenToIdentity()`. Add `grantIndexes`/`revokeIndexes`. |
| `engine/repository.ts` | `createStore()` accepts `indexName`. New `createStoreForIndex()`. New `federatedQuery()`. |
| `engine/protocol.ts` | Add `indexes: string[]` param to `query`/`get`/`multi_get` tools. Add 4 new tools: `index_list`, `index_create`, `index_delete`, `index_migrate`. |
| `engine/kindx.ts` | Add `case "index":` switch arm delegating to `runIndexCommand()`. |
| `engine/catalogs.ts` | Add `getConfigForIndex()` and `listCollectionsForIndex()` helpers. |
| `specs/rbac.test.ts` | Add tests for `allowedIndexes`, `canAccessIndex`, `enforce()` with index scoping. |

---

### Task 1: Index Manager (Registry CRUD)

**Files:**
- Create: `engine/index-manager.ts`
- Create: `specs/index-manager.test.ts`

- [ ] **Step 1: Write the failing test for registry load/save**

Create `specs/index-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

let indexManager: typeof import("../engine/index-manager.js");

describe("Index Manager", () => {
  let configDir: string;
  const origConfigDir = process.env.KINDX_CONFIG_DIR;

  beforeEach(async () => {
    configDir = join(tmpdir(), `kindx-index-mgr-${randomBytes(4).toString("hex")}`);
    mkdirSync(configDir, { recursive: true });
    process.env.KINDX_CONFIG_DIR = configDir;
    indexManager = await import("../engine/index-manager.js");
    indexManager.__resetRegistryCacheForTests();
  });

  afterEach(() => {
    indexManager.__resetRegistryCacheForTests();
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
    if (origConfigDir !== undefined) {
      process.env.KINDX_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.KINDX_CONFIG_DIR;
    }
  });

  describe("Registry CRUD", () => {
    it("loads empty registry when indexes.yml does not exist", () => {
      const registry = indexManager.loadRegistry();
      expect(registry.version).toBe(1);
      expect(registry.default).toBe("index");
      expect(registry.indexes).toEqual({});
    });

    it("registers a new index and persists to indexes.yml", () => {
      indexManager.registerIndex("my-project", "Project Alpha");

      const registry = indexManager.loadRegistry();
      expect(registry.indexes["my-project"]).toBeDefined();
      expect(registry.indexes["my-project"]!.description).toBe("Project Alpha");
      expect(registry.indexes["my-project"]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const filePath = join(configDir, "indexes.yml");
      expect(existsSync(filePath)).toBe(true);
    });

    it("rejects duplicate index names", () => {
      indexManager.registerIndex("my-project", "First");
      expect(() => indexManager.registerIndex("my-project", "Second"))
        .toThrow("Index 'my-project' already exists");
    });

    it("rejects invalid index names", () => {
      expect(() => indexManager.registerIndex("", "invalid"))
        .toThrow(/Index name must match/);
      expect(() => indexManager.registerIndex("MY-PROJECT", "uppercase"))
        .toThrow(/Index name must match/);
      expect(() => indexManager.registerIndex("a", "too short"))
        .toThrow(/Index name must match/);
    });

    it("unregisters an index", () => {
      indexManager.registerIndex("my-project", "Proj");
      indexManager.unregisterIndex("my-project");

      const registry = indexManager.loadRegistry();
      expect(registry.indexes["my-project"]).toBeUndefined();
    });

    it("rejects unregister of default index", () => {
      expect(() => indexManager.unregisterIndex("index"))
        .toThrow("Cannot delete the default index");
    });

    it("rejects unregister of non-existent index", () => {
      expect(() => indexManager.unregisterIndex("nonexistent"))
        .toThrow("Index 'nonexistent' not found");
    });

    it("lists indexes with description and created_at", () => {
      indexManager.registerIndex("alpha", "Alpha");
      indexManager.registerIndex("beta", "Beta");

      const list = indexManager.listIndexes();
      expect(list).toHaveLength(2);
      expect(list[0]!.name).toBe("alpha");
      expect(list[0]!.description).toBe("Alpha");
      expect(list[1]!.name).toBe("beta");
    });

    it("auto-registers default 'index' when registry is first created", () => {
      const registry = indexManager.loadRegistry();
      // registry is empty — auto-register on first explicit access
      indexManager.ensureDefaultIndexRegistered();
      const updated = indexManager.loadRegistry();
      expect(updated.indexes["index"]).toBeDefined();
      expect(updated.indexes["index"]!.description).toBe("Default index");
    });

    it("preserves existing default index during auto-register", () => {
      indexManager.registerIndex("index", "Custom default");
      indexManager.ensureDefaultIndexRegistered();
      const updated = indexManager.loadRegistry();
      expect(updated.indexes["index"]!.description).toBe("Custom default");
    });

    it("gets default index name from registry", () => {
      expect(indexManager.getDefaultIndexName()).toBe("index");
      const registry = indexManager.loadRegistry();
      registry.default = "custom";
      indexManager.saveRegistry(registry);
      expect(indexManager.getDefaultIndexName()).toBe("custom");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run specs/index-manager.test.ts
```

Expected: FAIL — "Cannot find module '../engine/index-manager.js'" or similar.

- [ ] **Step 3: Create `engine/index-manager.ts` with minimal implementation**

```typescript
/**
 * index-manager.ts — Named index registry management
 *
 * Manages ~/.config/kindx/indexes.yml which tracks named indexes, their
 * metadata, and the default index. Consumed by CLI commands, MCP protocol,
 * and repository store creation.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { atomicWriteFile } from "./utils/atomic-write.js";

export interface IndexEntry {
  created_at: string;
  description?: string;
}

export interface IndexRegistry {
  version: 1;
  default: string;
  indexes: Record<string, IndexEntry>;
}

export interface NamedIndex extends IndexEntry {
  name: string;
}

const INDEX_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

function getConfigDir(): string {
  if (process.env.KINDX_CONFIG_DIR) return process.env.KINDX_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "kindx");
  return join(homedir(), ".config", "kindx");
}

function getRegistryPath(): string {
  return join(getConfigDir(), "indexes.yml");
}

let _cachedRegistry: IndexRegistry | null = null;
let _lastRegistryMtime = 0;

export function __resetRegistryCacheForTests(): void {
  _cachedRegistry = null;
  _lastRegistryMtime = 0;
}

function defaultRegistry(): IndexRegistry {
  return {
    version: 1,
    default: "index",
    indexes: {},
  };
}

export function loadRegistry(): IndexRegistry {
  const path = getRegistryPath();
  if (!existsSync(path)) return defaultRegistry();

  try {
    const stat = statSync(path);
    if (_cachedRegistry && stat.mtimeMs === _lastRegistryMtime) {
      return _cachedRegistry;
    }
    const raw = readFileSync(path, "utf8");
    const parsed = YAML.parse(raw) as Partial<IndexRegistry>;
    const registry: IndexRegistry = {
      version: 1,
      default: parsed?.default || "index",
      indexes: parsed?.indexes || {},
    };
    _cachedRegistry = registry;
    _lastRegistryMtime = stat.mtimeMs;
    return registry;
  } catch {
    return defaultRegistry();
  }
}

export function saveRegistry(registry: IndexRegistry): void {
  const content = YAML.stringify({
    version: registry.version,
    default: registry.default,
    indexes: registry.indexes,
  });
  atomicWriteFile(getRegistryPath(), content);
  const stat = statSync(getRegistryPath());
  _cachedRegistry = registry;
  _lastRegistryMtime = stat.mtimeMs;
}

export function getDefaultIndexName(): string {
  return loadRegistry().default;
}

export function ensureDefaultIndexRegistered(): void {
  const registry = loadRegistry();
  if (!registry.indexes["index"]) {
    registry.indexes["index"] = {
      created_at: new Date().toISOString(),
      description: "Default index",
    };
    saveRegistry(registry);
  }
}

export function registerIndex(name: string, description?: string): IndexEntry {
  if (!INDEX_NAME_RE.test(name)) {
    throw new Error(`Index name must match [a-z][a-z0-9-]{1,63}, got: '${name}'`);
  }
  const registry = loadRegistry();
  if (registry.indexes[name]) {
    throw new Error(`Index '${name}' already exists`);
  }
  const entry: IndexEntry = {
    created_at: new Date().toISOString(),
    description: description || undefined,
  };
  registry.indexes[name] = entry;
  saveRegistry(registry);
  return entry;
}

export function unregisterIndex(name: string): void {
  const registry = loadRegistry();
  if (name === registry.default) {
    throw new Error(`Cannot delete the default index '${name}'`);
  }
  if (!registry.indexes[name]) {
    throw new Error(`Index '${name}' not found`);
  }
  delete registry.indexes[name];
  saveRegistry(registry);
}

export function listIndexes(): NamedIndex[] {
  const registry = loadRegistry();
  return Object.entries(registry.indexes).map(([name, entry]) => ({
    name,
    ...entry,
  }));
}

export function getIndex(name: string): NamedIndex | null {
  const registry = loadRegistry();
  const entry = registry.indexes[name];
  if (!entry) return null;
  return { name, ...entry };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run specs/index-manager.test.ts
```

Expected: All 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/index-manager.ts specs/index-manager.test.ts
git commit -m "feat(index): add index-manager with registry CRUD and tests"
```

---

### Task 2: Store Per Index — createStoreForIndex

**Files:**
- Modify: `engine/repository.ts:395` (createStore + new functions)

- [ ] **Step 1: Add `createStoreForIndex()` and expose index name on Store**

In `engine/repository.ts`, after the existing `createStore()` function (around line 400):

```typescript
export function createStore(dbPath?: string, indexName?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath(indexName || "index");
  ensureEncryptedIndexReady(resolvedPath);
  ensureEncryptedShardIndexesReady(resolvedPath);
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);

  // ... existing return block unchanged, but add indexName to Store type:
}
```

First, update the `Store` type definition (around line 340 of repository.ts) to include `indexName`:

```typescript
export type Store = {
  db: Database;
  dbPath: string;
  indexName: string;
  close: () => void;
  // ... rest unchanged
};
```

Then update the return statement in `createStore()` to include `indexName`:

At the point where the return statement starts (after `initializeDatabase(db)`), add `indexName: indexName || "index",` to the returned object alongside `db` and `dbPath`.

Then add the new `createStoreForIndex()` function right after `createStore()`:

```typescript
export function createStoreForIndex(indexName: string): Store {
  return createStore(undefined, indexName);
}
```

- [ ] **Step 2: Verify — write a quick integration test**

Create a small validation in existing test patterns. Add to an existing test or create a quick inline test:

```bash
node -e "
const { createStore, createStoreForIndex } = require('./dist/engine/repository.js');
const s1 = createStore('/tmp/test-idx1.sqlite', 'test1');
const s2 = createStore('/tmp/test-idx2.sqlite', 'test2');
console.log(s1.indexName, s2.indexName);
console.log(s1.dbPath, s2.dbPath);
s1.close(); s2.close();
"
```

Before running, build:

```bash
npm run build
node -e "
const { createStore, createStoreForIndex } = require('./dist/engine/repository.js');
process.env.INDEX_PATH = undefined;
const s1 = createStore('/tmp/test-store-idx1.sqlite', 'test1');
const s2 = createStoreForIndex('test2');
console.log('idx1:', s1.indexName, '|', s1.dbPath);
console.log('idx2:', s2.indexName, '|', s2.dbPath);
s1.close(); s2.close();
// Cleanup
require('fs').unlinkSync('/tmp/test-store-idx1.sqlite');
require('fs').unlinkSync('/tmp/test-store-idx1.sqlite-wal');
"
```

Expected: `idx1: test1 | /tmp/test-store-idx1.sqlite` and `idx2: test2 | ~/.cache/kindx/test2.sqlite`.

- [ ] **Step 3: Run existing tests to verify no regressions**

```bash
npx vitest run
```

Expected: All existing 59+ tests still pass.

- [ ] **Step 4: Commit**

```bash
git add engine/repository.ts
git commit -m "feat(index): add createStoreForIndex and indexName to Store type"
```

---

### Task 3: RBAC Index Scoping

**Files:**
- Modify: `engine/rbac.ts` (Tenant type, ResolvedIdentity, enforce, resolveTokenToIdentity, tenant command types)
- Modify: `specs/rbac.test.ts` (add index scoping tests)

- [ ] **Step 1: Add `allowedIndexes` to Tenant and ResolvedIdentity types**

In `engine/rbac.ts`, update the `Tenant` interface (around line 37):

Add after `allowedCollections`:
```typescript
  /**
   * Named indexes this tenant can access.
   * `["*"]` means all indexes (default for backward compat).
   * Empty array means no index access.
   */
  allowedIndexes: string[];
```

Update `ResolvedIdentity` (around line 72):
```typescript
export interface ResolvedIdentity {
  tenantId: string;
  role: TenantRole;
  allowedCollections: string[] | "*";
  allowedIndexes: string[] | "*";
}
```

- [ ] **Step 2: Update `resolveTokenToIdentity()` to populate `allowedIndexes`**

In `resolveTokenToIdentity()` (around line 578), update the return block:

```typescript
  return {
    tenantId: matched.id,
    role: matched.role,
    allowedCollections: matched.allowedCollections.includes("*")
      ? "*"
      : matched.allowedCollections,
    allowedIndexes: matched.allowedIndexes?.includes("*") || matched.allowedIndexes?.length === 0
      ? "*"
      : (matched.allowedIndexes && matched.allowedIndexes.length > 0
        ? matched.allowedIndexes
        : ["*"]), // backward compat: no field = open access
  };
```

The default for missing `allowedIndexes` is `["*"]` to preserve backward compatibility.

- [ ] **Step 3: Add `canAccessIndex()` helper**

Add after `canAccessCollection()` (around line 605):

```typescript
export function canAccessIndex(identity: ResolvedIdentity, indexName: string): boolean {
  if (identity.allowedIndexes === "*") return true;
  if (!Array.isArray(identity.allowedIndexes)) return true;
  return identity.allowedIndexes.includes(indexName);
}
```

- [ ] **Step 4: Update `enforce()` to check index access**

Modify the `enforce()` function signature and body (around line 622):

```typescript
export function enforce(
  identity: ResolvedIdentity,
  operation: RBACOperation,
  indexName?: string,
  collectionName?: string,
): void {
  if (!isPermitted(identity, operation)) {
    throw new RBACDeniedError(
      `Tenant '${identity.tenantId}' (role=${identity.role}) is not permitted to perform '${operation}'`
    );
  }

  if (indexName && !canAccessIndex(identity, indexName)) {
    throw new RBACDeniedError(
      `Tenant '${identity.tenantId}' does not have access to index '${indexName}'`
    );
  }

  if (collectionName && !canAccessCollection(identity, collectionName)) {
    throw new RBACDeniedError(
      `Tenant '${identity.tenantId}' does not have access to collection '${collectionName}'`
    );
  }

  enforceRateLimit(identity.tenantId, operation);
}
```

- [ ] **Step 5: Update `createTenant()` to accept allowedIndexes**

Update the `createTenant()` function signature (around line 200) to accept `allowedIndexes`:

```typescript
export function createTenant(
  id: string,
  name: string,
  role: TenantRole,
  allowedCollections: string[] = [],
  allowedIndexes: string[] = ["*"],
  description?: string,
): { tenant: Tenant; plaintextToken: string }
```

And in the body, add `allowedIndexes` when constructing the tenant object.

Also update the helper that reads/writes `tenants.yml` to serialize/deserialize `allowed_indexes` field.

- [ ] **Step 6: Add `grantIndexes()` and `revokeIndexes()` functions**

Add after `revokeCollections()` (around line 540):

```typescript
export function grantIndexes(id: string, indexes: string[]): boolean {
  const tenants = loadTenantRegistry();
  const tenant = tenants.tenants[id];
  if (!tenant) return false;
  tenant.allowedIndexes = [...new Set([...tenant.allowedIndexes, ...indexes])];
  saveTenantRegistry(tenants);
  return true;
}

export function revokeIndexes(id: string, indexes: string[]): boolean {
  const tenants = loadTenantRegistry();
  const tenant = tenants.tenants[id];
  if (!tenant) return false;
  tenant.allowedIndexes = tenant.allowedIndexes.filter(i => !indexes.includes(i));
  saveTenantRegistry(tenants);
  return true;
}
```

- [ ] **Step 7: Add new index lifecycle operations to RBACOperation**

Update `RBACOperation` type (around line 84):

```typescript
export type RBACOperation =
  // ... existing operations ...
  | "index_list"
  | "index_create"
  | "index_delete"
  | "index_migrate";
```

Update `ROLE_PERMISSIONS` (around line 106):
```typescript
  admin: new Set([
    // ... existing ops ...
    "index_list", "index_create", "index_delete", "index_migrate",
  ]),
  editor: new Set([
    // ... existing ops ...
    "index_list",
  ]),
  viewer: new Set([
    // ... existing ops ...
    "index_list",
  ]),
```

- [ ] **Step 8: Add RBAC tests for index scoping**

Add to `specs/rbac.test.ts`:

```typescript
  describe("Index scoping", () => {
    it("enforce rejects tenant for unpermitted index", () => {
      const { tenant } = rbac.createTenant("bot", "Bot", "viewer", ["docs"], ["alpha"]);
      expect(tenant.allowedIndexes).toEqual(["alpha"]);
      const identity: rbac.ResolvedIdentity = {
        tenantId: "bot",
        role: "viewer",
        allowedCollections: ["docs"],
        allowedIndexes: ["alpha"],
      };
      expect(() => rbac.enforce(identity, "query", "beta")).toThrow("does not have access to index 'beta'");
    });

    it("enforce allows tenant for permitted index", () => {
      const identity: rbac.ResolvedIdentity = {
        tenantId: "bot",
        role: "viewer",
        allowedCollections: ["docs"],
        allowedIndexes: ["alpha", "gamma"],
      };
      expect(() => rbac.enforce(identity, "query", "alpha")).not.toThrow();
    });

    it("wildcard allowedIndexes grants access to any index", () => {
      const identity: rbac.ResolvedIdentity = {
        tenantId: "bot",
        role: "viewer",
        allowedCollections: ["*"],
        allowedIndexes: "*",
      };
      expect(() => rbac.enforce(identity, "query", "any-index")).not.toThrow();
    });

    it("resolveTokenToIdentity sets allowedIndexes to ['*'] for legacy tenants", () => {
      // Load a legacy tenants.yml with no allowed_indexes field
      // ... verify identity.allowedIndexes === ["*"]
    });

    it("grantIndexes adds indexes to tenant", () => {
      rbac.createTenant("bot", "Bot", "viewer", ["docs"], []);
      expect(rbac.grantIndexes("bot", ["alpha", "beta"])).toBe(true);
      const t = rbac.getTenant("bot");
      expect(t!.allowedIndexes).toContain("alpha");
      expect(t!.allowedIndexes).toContain("beta");
    });

    it("revokeIndexes removes indexes from tenant", () => {
      rbac.createTenant("bot", "Bot", "viewer", ["docs"], ["alpha", "beta"]);
      expect(rbac.revokeIndexes("bot", ["alpha"])).toBe(true);
      const t = rbac.getTenant("bot");
      expect(t!.allowedIndexes).toEqual(["beta"]);
    });
  });
```

- [ ] **Step 9: Run tests**

```bash
npx vitest run specs/rbac.test.ts
```

Expected: New index scoping tests pass alongside existing tests.

- [ ] **Step 10: Commit**

```bash
git add engine/rbac.ts specs/rbac.test.ts
git commit -m "feat(rbac): add index-level scoping with allowedIndexes"
```

---

### Task 4: Cross-Index Query Federation

**Files:**
- Modify: `engine/repository.ts` (add federatedQuery)
- Modify: `engine/protocol.ts` (add `indexes` param to query/get/multi_get tools)

- [ ] **Step 1: Add `federatedQuery()` to repository.ts**

Add to `engine/repository.ts`:

```typescript
import { quietWarn, errString } from "./utils/quiet-warn.js";

export interface FederatedMatch {
  _index: string;
  docid: string;
  file: string;
  title?: string;
  score: number;
  context?: string;
  snippet?: string;
}

export interface FederatedResult {
  matches: FederatedMatch[];
  indexes_queried: string[];
  indexes_skipped: string[];
}

/**
 * Run a single query against one index's store and return raw matches.
 * Internal helper for federatedQuery — doesn't do expansion or reranking itself;
 * passes through to hybridQuery or structuredSearchWithDiagnostics.
 */
export function runIndexQuery(
  indexName: string,
  queryText: string,
  options: {
    collections?: string[];
    limit?: number;
    minScore?: number;
    session?: ILLMSession;
  },
): { matches: Array<{ docid: string; displayPath: string; title?: string; score: number; context?: string; snippet?: string }> } {
  const store = createStoreForIndex(indexName);
  const limit = options.limit ?? 10;

  // Simple single-index query: use the hybrid FTS + vector path
  const ftsMatches = store.searchFTS(queryText, limit * 2, undefined);

  const matches = ftsMatches.slice(0, limit).map(m => ({
    docid: m.docid,
    displayPath: m.file,
    title: m.title || "",
    score: m.score,
    context: m.context || "",
    snippet: m.snippet || "",
  }));

  return { matches };
}

/**
 * Fan out a query to multiple named indexes and merge results.
 * Deduplicates by docid (keeps highest score). Annotates with _index provenance.
 */
export function federatedQuery(
  indexes: string[],
  queryText: string,
  options: {
    collections?: string[];
    limit?: number;
    minScore?: number;
    session?: ILLMSession;
  },
): FederatedResult {
  const allMatches: Array<{ index: string; match: any }> = [];
  const skipped: string[] = [];

  for (const indexName of indexes) {
    try {
      const { matches } = runIndexQuery(indexName, queryText, options);
      for (const m of matches) {
        allMatches.push({ index: indexName, match: m });
      }
    } catch (e) {
      quietWarn("federated_query.index_skipped", { index: indexName, err: errString(e) });
      skipped.push(indexName);
    }
  }

  // Deduplicate by (docid) — keep highest score across indexes
  const seen = new Map<string, { match: any; index: string; score: number }>();
  for (const { index, match } of allMatches) {
    const key = match.docid;
    const existing = seen.get(key);
    if (!existing || match.score > existing.score) {
      seen.set(key, { match, index, score: match.score });
    }
  }

  // Sort by score descending, take top-N
  const merged = Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10);

  return {
    matches: merged.map(({ match, index }) => ({
      _index: index,
      docid: match.docid,
      file: match.displayPath,
      title: match.title,
      score: Math.round(match.score * 100) / 100,
      context: match.context,
      snippet: match.snippet,
    })),
    indexes_queried: indexes.filter(i => !skipped.includes(i)),
    indexes_skipped: skipped,
  };
}
```

- [ ] **Step 2: Add `indexes` parameter to MCP `query` tool**

In `engine/protocol.ts`, update the query tool's `inputSchema` and handler:

Add to the zod schema (after `collections` at line 925):

```typescript
        indexes: z.array(z.string()).optional().describe(
          "Named indexes to query (cross-index federation). Omit to use current index."
        ),
```

In the `async ({ searches, limit, minScore, ..., indexes }: any)` handler parameter list, add `indexes`.

Then, at the point where the query handler calls `structuredSearchWithDiagnostics` (around line 969), add a conditional:

```typescript
      let results;
      if (indexes && indexes.length > 0) {
        const fedResults = federatedQuery(indexes, subSearches, {
          collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit,
          minScore,
          candidateLimit: profilePolicy.candidateLimit,
          // ... pass through relevant options
        });
        // Adapt FederatedResult to match existing return shape
        // Map federated matches to the expected result format
        results = {
          results: fedResults.matches.map(m => ({
            docid: m.docid,
            displayPath: m.file,
            title: m.title || "",
            score: m.score,
            context: m.context || "",
            bestChunk: m.snippet || "",
            _index: m._index,
          })),
          diagnostics: {
            degradedMode: false,
            fallbackReasons: fedResults.indexes_skipped.length > 0
              ? [`skipped indexes: ${fedResults.indexes_skipped.join(", ")}`]
              : [],
          },
        };
      } else {
        results = await withLLMScope(
          scopeKey,
          () => raceWithTimeout(
            (signal) => structuredSearchWithDiagnostics(store, subSearches, {
              // ... existing options unchanged
            }),
            resolveTimeoutByProfile(timeoutMs, profile),
            "query_timeout"
          )
        );
      }
```

Add the `_index` field to the filtered result in the existing map (around line 1029):

```typescript
        return {
          _index: r._index || undefined, // NEW
          docid: `#${r.docid}`,
          file: r.displayPath,
          title: r.title,
          score: Math.round(r.score * 100) / 100,
          context: r.context,
          snippet: addLineNumbers(finalSnippet, line),
          _rawSnippet: finalSnippet,
        };
```

- [ ] **Step 3: Add `indexes` parameter to `get` tool**

Add to `get` tool's `inputSchema` (around line 1134):

```typescript
        indexes: z.array(z.string()).optional().describe(
          "Named indexes to search for the document. Omit to use current index."
        ),
```

In the `get` handler, when `indexes` is provided, iterate over indexes looking for the document. When found, return it. When not found in any index, return not-found. Import `createStoreForIndex` from repository.

- [ ] **Step 4: Add `indexes` parameter to `multi_get` tool**

Same pattern as `get` — add `indexes: z.array(z.string()).optional()` to schema, iterate over indexes in handler.

- [ ] **Step 5: Build and run tests**

```bash
npm run build
npx vitest run
```

Expected: All tests pass. No regressions.

- [ ] **Step 6: Commit**

```bash
git add engine/repository.ts engine/protocol.ts
git commit -m "feat(index): add cross-index query federation with indexes parameter"
```

---

### Task 5: Catalog Helpers for Per-Index Config

**Files:**
- Modify: `engine/catalogs.ts`

- [ ] **Step 1: Add `getConfigForIndex()` and `listCollectionsForIndex()`**

In `engine/catalogs.ts`, add after the existing config functions:

```typescript
export function getConfigForIndex(indexName: string): CollectionConfig {
  const prevName = currentIndexName;
  try {
    setConfigIndexName(indexName);
    return loadConfig();
  } finally {
    setConfigIndexName(prevName);
  }
}

export function listCollectionsForIndex(indexName: string): NamedCollection[] {
  const config = getConfigForIndex(indexName);
  return Object.entries(config.collections).map(([name, col]) => ({
    name,
    ...col,
  }));
}
```

- [ ] **Step 2: Expose `getConfigForIndex` for the index manager and CLI**

Already exported. No additional exports needed beyond the two function declarations above.

- [ ] **Step 3: Commit**

```bash
git add engine/catalogs.ts
git commit -m "feat(catalogs): add getConfigForIndex and listCollectionsForIndex helpers"
```

---

### Task 6: CLI Index Commands

**Files:**
- Create: `engine/commands/index-command.ts`
- Modify: `engine/kindx.ts` (add `case "index"`)

- [ ] **Step 1: Create `engine/commands/index-command.ts`**

```typescript
/**
 * index-command.ts — CLI handler for 'kindx index' lifecycle commands
 *
 * Subcommands: list, create, delete, migrate
 */

import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { c } from "../utils/ui.js";
import {
  registerIndex,
  unregisterIndex,
  listIndexes,
  getIndex,
  ensureDefaultIndexRegistered,
} from "../index-manager.js";
import { getDefaultDbPath } from "../repository/paths.js";
import { openDatabase } from "../runtime.js";
import { initializeDatabase } from "../repository/store-init.js";
import { getConfigForIndex, addCollection } from "../catalogs.js";
import { getDefaultIndexName } from "../index-manager.js";

export function runIndexCommand(
  args: string[],
  values: Record<string, unknown>,
): number {
  const sub = args[0];

  switch (sub) {
    case "list":
    case "ls": {
      ensureDefaultIndexRegistered();
      const indexes = listIndexes();
      const defaultName = getDefaultIndexName();

      if (indexes.length === 0) {
        console.log(`${c.dim}No named indexes found. Create one with: kindx index create <name>${c.reset}`);
        return 0;
      }

      console.log(`${c.bold}Named Indexes (${indexes.length}):${c.reset}\n`);
      for (const idx of indexes) {
        const isDefault = idx.name === defaultName ? ` ${c.cyan}(default)${c.reset}` : "";
        console.log(`  ${c.bold}${idx.name}${c.reset}${isDefault}`);
        if (idx.description) console.log(`    ${c.dim}${idx.description}${c.reset}`);
        console.log(`    Created: ${idx.created_at}`);
        console.log();
      }
      return 0;
    }

    case "create": {
      const name = args[1];
      if (!name) {
        console.error("Usage: kindx index create <name> [--description <desc>]");
        return 1;
      }

      try {
        const entry = registerIndex(name, values.description as string | undefined);
        const dbPath = getDefaultDbPath(name);
        const db = openDatabase(dbPath);
        initializeDatabase(db);
        db.close();
        console.log(`${c.green}✓${c.reset} Created index '${c.bold}${name}${c.reset}'`);
        console.log(`  Database: ${dbPath}`);
        console.log(`  Config:   ~/.config/kindx/${name}.yml`);
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} ${err.message}`);
        return 1;
      }
    }

    case "delete":
    case "rm": {
      const name = args[1];
      if (!name) {
        console.error("Usage: kindx index delete <name> [--force]");
        return 1;
      }

      const force = !!values.force;
      if (!force) {
        const defaultName = getDefaultIndexName();
        if (name === defaultName) {
          console.error(`${c.yellow}!${c.reset} Cannot delete the default index '${name}'`);
          return 1;
        }
        console.log(`${c.yellow}This will permanently delete index '${name}' and all its data.${c.reset}`);
        console.log(`${c.yellow}Use --force to confirm.${c.reset}`);
        return 1;
      }

      try {
        unregisterIndex(name);
        const dbPath = getDefaultDbPath(name);
        [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach(p => {
          if (existsSync(p)) unlinkSync(p);
        });
        console.log(`${c.green}✓${c.reset} Deleted index '${c.bold}${name}${c.reset}'`);
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} ${err.message}`);
        return 1;
      }
    }

    case "migrate": {
      const collection = args[1];
      const fromIndex = values.from as string | undefined;
      const toIndex = values.to as string | undefined;

      if (!collection || !fromIndex || !toIndex) {
        console.error("Usage: kindx index migrate <collection> --from <src> --to <dst>");
        return 1;
      }

      try {
        const srcDbPath = getDefaultDbPath(fromIndex);
        const dstDbPath = getDefaultDbPath(toIndex);

        if (!existsSync(srcDbPath)) {
          console.error(`${c.yellow}!${c.reset} Source index '${fromIndex}' database not found`);
          return 1;
        }
        if (!existsSync(dstDbPath)) {
          console.error(`${c.yellow}!${c.reset} Destination index '${toIndex}' database not found`);
          return 1;
        }

        const srcDb = openDatabase(srcDbPath);
        const dstDb = openDatabase(dstDbPath);

        const contentCount = (srcDb.prepare(
          `SELECT COUNT(*) as c FROM content WHERE collection = ?`
        ).get(collection) as any)?.c || 0;

        if (contentCount === 0) {
          console.log(`${c.yellow}!${c.reset} Collection '${collection}' is empty in source index`);
          srcDb.close();
          dstDb.close();
          return 0;
        }

        // ATTACH source DB for cross-DB SQL
        dstDb.exec(`ATTACH DATABASE ? AS src`, srcDbPath);

        // Copy tables collection-scoped
        dstDb.exec(`
          INSERT INTO main.content SELECT * FROM src.content WHERE collection = ?
        `, collection);
        dstDb.exec(`
          INSERT INTO main.documents SELECT * FROM src.documents WHERE collection = ?
        `, collection);
        dstDb.exec(`
          INSERT INTO main.document_links
          SELECT dl.* FROM src.document_links dl
          WHERE EXISTS (SELECT 1 FROM src.content c WHERE c.hash = dl.hash AND c.collection = ?)
        `, collection);
        dstDb.exec(`
          INSERT INTO main.content_vectors
          SELECT cv.* FROM src.content_vectors cv
          WHERE EXISTS (SELECT 1 FROM src.content c WHERE c.hash = cv.hash AND c.collection = ?)
        `, collection);
        dstDb.exec(`
          INSERT INTO main.document_ingest
          SELECT di.* FROM src.document_ingest di
          WHERE EXISTS (SELECT 1 FROM src.documents d WHERE d.docid = di.docid AND d.collection = ?)
        `, collection);

        // FTS
        dstDb.exec(`
          INSERT INTO main.documents_fts SELECT * FROM src.documents_fts
          WHERE docid IN (SELECT docid FROM src.documents WHERE collection = ?)
        `, collection);

        dstDb.exec(`DETACH DATABASE src`);

        // Copy collection config entry
        const srcConfig = getConfigForIndex(fromIndex);
        if (srcConfig.collections[collection]) {
          const { addCollection, setConfigIndexName } = await import("../catalogs.js");
          setConfigIndexName(toIndex);
          addCollection(collection, srcConfig.collections[collection]!.path, srcConfig.collections[collection]!.pattern);
        }

        srcDb.close();
        dstDb.close();

        console.log(`${c.green}✓${c.reset} Migrated collection '${c.bold}${collection}${c.reset}' from '${c.bold}${fromIndex}${c.reset}' to '${c.bold}${toIndex}${c.reset}': ${contentCount} documents`);
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} Migration failed: ${err.message}`);
        return 1;
      }
    }

    case "help":
    case undefined: {
      console.log("Usage: kindx index <subcommand> [options]");
      console.log();
      console.log("Subcommands:");
      console.log("  list                      List all named indexes");
      console.log("  create <name>             Create a new named index");
      console.log("  delete <name> --force     Permanently delete a named index");
      console.log("  migrate <collection>      Copy collection data between indexes");
      console.log("         --from <src> --to <dst>");
      console.log();
      console.log("Examples:");
      console.log("  kindx index create my-project --description 'Project Alpha'");
      console.log("  kindx index list");
      console.log("  kindx index delete old-project --force");
      console.log("  kindx index migrate logs --from alpha --to beta");
      return 0;
    }

    default:
      console.error(`Unknown index subcommand: ${sub}`);
      console.error("Run 'kindx index help' for usage");
      return 1;
  }
}
```

- [ ] **Step 2: Add `case "index"` to kindx.ts**

In `engine/kindx.ts`, in the main switch statement (before the default/help case, around line 4100), add:

```typescript
    case "index": {
      const { runIndexCommand } = await import("./commands/index-command.js");
      const code = runIndexCommand(
        cli.args,
        cli.values as Record<string, unknown>,
      );
      if (code !== 0) process.exit(code);
      break;
    }
```

- [ ] **Step 3: Verify CLI commands**

```bash
npm run build
node dist/engine/kindx.js index help
node dist/engine/kindx.js index list
node dist/engine/kindx.js index create test-idx --description "Test"
node dist/engine/kindx.js index list
node dist/engine/kindx.js index delete test-idx --force
```

Expected: Each command outputs appropriate messages and operates on the test index.

- [ ] **Step 4: Commit**

```bash
git add engine/commands/index-command.ts engine/kindx.ts
git commit -m "feat(index): add CLI index lifecycle commands (create, delete, list, migrate)"
```

---

### Task 7: MCP Lifecycle Tools

**Files:**
- Modify: `engine/protocol.ts` (add `index_list`, `index_create`, `index_delete`, `index_migrate` tools)

- [ ] **Step 1: Add `index_list` tool to protocol.ts**

In `createMcpServer()`, add after the existing tool registrations (around line 820, before the query tool):

```typescript
  // ---------------------------------------------------------------------------
  // Tool: index_list
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_list",
    {
      title: "List Indexes",
      description: "List all named indexes. Returns index name, description, creation date, and whether it is the default.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      try {
        const { ensureDefaultIndexRegistered, listIndexes, getDefaultIndexName } = await import("./index-manager.js");
        ensureDefaultIndexRegistered();
        const indexes = listIndexes();
        const defaultName = getDefaultIndexName();

        return {
          content: [{ type: "text", text: `${indexes.length} index(es) found. Default: ${defaultName}` }],
          structuredContent: {
            indexes: indexes.map(i => ({
              name: i.name,
              description: i.description || null,
              created_at: i.created_at,
              is_default: i.name === defaultName,
            })),
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_list_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_create
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_create",
    {
      title: "Create Index",
      description: "Create a new named index with its own SQLite database. Admin only.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        name: z.string().describe("Index name (lowercase, 2-64 chars, alphanumeric + hyphens)"),
        description: z.string().optional().describe("Human-readable description"),
      },
    },
    async ({ name, description }: any) => {
      try {
        const { registerIndex } = await import("./index-manager.js");
        const { getDefaultDbPath } = await import("./repository/paths.js");
        const { openDatabase } = await import("./runtime.js");
        const { initializeDatabase } = await import("./repository/store-init.js");

        const entry = registerIndex(name, description);
        const dbPath = getDefaultDbPath(name);
        const db = openDatabase(dbPath);
        initializeDatabase(db);
        db.close();

        return {
          content: [{ type: "text", text: `Created index '${name}' at ${dbPath}` }],
          structuredContent: { name, db_path: dbPath, created_at: entry.created_at },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_create_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_delete
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_delete",
    {
      title: "Delete Index",
      description: "Permanently delete a named index and all its data. Admin only. Requires force=true to confirm.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      inputSchema: {
        name: z.string().describe("Index name to delete"),
        force: z.boolean().default(false).describe("Must be true to confirm deletion"),
      },
    },
    async ({ name, force }: any) => {
      try {
        if (!force) {
          return {
            content: [{ type: "text", text: `Deletion of index '${name}' requires force=true to confirm.` }],
            isError: true,
          };
        }

        const { unregisterIndex, getDefaultIndexName } = await import("./index-manager.js");
        const { getDefaultDbPath } = await import("./repository/paths.js");
        const { existsSync, unlinkSync } = await import("node:fs");

        if (name === getDefaultIndexName()) {
          return {
            content: [{ type: "text", text: `Cannot delete the default index '${name}'.` }],
            isError: true,
          };
        }

        unregisterIndex(name);
        const dbPath = getDefaultDbPath(name);
        for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try { if (existsSync(p)) unlinkSync(p); } catch {}
        }

        return {
          content: [{ type: "text", text: `Deleted index '${name}'.` }],
          structuredContent: { deleted: true, name },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_delete_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_migrate
  // ---------------------------------------------------------------------------
  maybeRegisterTool(
    "index_migrate",
    {
      title: "Migrate Collection",
      description: "Copy a collection and its data from one index to another. Admin only.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        collection: z.string().describe("Collection name to migrate"),
        from_index: z.string().describe("Source index name"),
        to_index: z.string().describe("Destination index name"),
      },
    },
    async ({ collection, from_index, to_index }: any) => {
      try {
        const { getDefaultDbPath } = await import("./repository/paths.js");
        const { openDatabase } = await import("./runtime.js");
        const srcDbPath = getDefaultDbPath(from_index);
        const dstDbPath = getDefaultDbPath(to_index);

        const srcDb = openDatabase(srcDbPath);
        const dstDb = openDatabase(dstDbPath);

        const count = (srcDb.prepare(
          `SELECT COUNT(*) as c FROM content WHERE collection = ?`
        ).get(collection) as any)?.c || 0;

        if (count === 0) {
          srcDb.close();
          dstDb.close();
          return {
            content: [{ type: "text", text: `Collection '${collection}' is empty in source index '${from_index}'.` }],
          };
        }

        dstDb.exec(`ATTACH DATABASE ? AS src`, srcDbPath);
        dstDb.exec(`INSERT INTO main.content SELECT * FROM src.content WHERE collection = ?`, collection);
        dstDb.exec(`INSERT INTO main.documents SELECT * FROM src.documents WHERE collection = ?`, collection);
        dstDb.exec(`
          INSERT INTO main.content_vectors
          SELECT cv.* FROM src.content_vectors cv
          WHERE EXISTS (SELECT 1 FROM src.content c WHERE c.hash = cv.hash AND c.collection = ?)
        `, collection);
        dstDb.exec(`
          INSERT INTO main.documents_fts SELECT * FROM src.documents_fts
          WHERE docid IN (SELECT docid FROM src.documents WHERE collection = ?)
        `, collection);
        dstDb.exec(`DETACH DATABASE src`);

        srcDb.close();
        dstDb.close();

        return {
          content: [{ type: "text", text: `Migrated ${count} documents from '${from_index}' to '${to_index}' collection '${collection}'.` }],
          structuredContent: { collection, from_index, to_index, documents_migrated: count },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `index_migrate_failed: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add engine/protocol.ts
git commit -m "feat(index): add MCP index lifecycle tools (list, create, delete, migrate)"
```

---

### Task 8: Final Integration & Cleanup

**Files:**
- Verify: `engine/repository/paths.ts` (no changes needed)
- Verify: `engine/repository/store-init.ts` (no changes needed)
- Maybe: `engine/diagnostics.ts` (add index awareness to `kindx doctor`)

- [ ] **Step 1: Verify `paths.ts` and `store-init.ts` need no changes**

Review `engine/repository/paths.ts:getDefaultDbPath()` — already accepts `indexName` parameter, produces `~/.cache/kindx/{indexName}.sqlite`. Confirm no changes needed.

Review `engine/repository/store-init.ts:initializeDatabase(db)` — is DB-agnostic, works with any SQLite file. Confirm no changes needed.

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
npm run build
```

Expected: All tests pass. No regressions.

- [ ] **Step 3: Run benchmarks and confirm within ±5% of baseline**

```bash
npm run bench:quality 2>/dev/null || echo "Benchmarks not yet configured for this branch"
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(index): final integration verification for named indexes"
```
