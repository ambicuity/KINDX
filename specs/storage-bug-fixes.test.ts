/**
 * storage-bug-fixes.test.ts
 *
 * Regression tests pinning the storage-layer audit fixes. Each test names the
 * bug it covers (see docs / commit history for the full punch list).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  createStore,
  hashContent,
  getCacheKey,
  findDocumentByDocid,
  findSimilarFiles,
  removeCollection,
  renameCollection,
  listCollections,
  evictRerankController,
  getRerankControllerCount,
  acquireRerankSlot,
  pruneIdleRerankControllers,
  upsertDocumentIngestion,
  upsertDocumentLinks,
  type Store,
} from "../engine/repository.js";
import type { CollectionConfig } from "../engine/catalogs.js";
import {
  initializeMemorySchema,
  initializeMemoryFeedbackSchema,
  initializeMemoryScopeConfigSchema,
  upsertMemory,
  deleteMemory,
  setScopeMemoryLimit,
  evictIfNeeded,
} from "../engine/memory.js";
import { openDatabase } from "../engine/runtime.js";

let testDir: string;
let testConfigDir: string;

async function createTestStore(): Promise<Store> {
  const dbPath = join(testDir, `bugfix-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  testConfigDir = await mkdtemp(join(testDir, "config-"));
  process.env.KINDX_CONFIG_DIR = testConfigDir;
  const empty: CollectionConfig = { collections: {} };
  await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(empty));
  return createStore(dbPath);
}

async function registerTestCollection(name: string, opts: { path?: string; pattern?: string } = {}): Promise<void> {
  const cfgPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(cfgPath, "utf-8");
  const cfg = YAML.parse(raw) as CollectionConfig;
  cfg.collections[name] = {
    path: opts.path ?? `/tmp/${name}`,
    pattern: opts.pattern ?? "**/*.md",
  };
  await writeFile(cfgPath, YAML.stringify(cfg));
}

async function destroyTestStore(store: Store): Promise<void> {
  store.close();
  try { await unlink(store.dbPath); } catch { /* */ }
  delete process.env.KINDX_CONFIG_DIR;
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kindx-bugfix-"));
});

afterAll(async () => {
  try { await rmdir(testDir, { recursive: true } as { recursive: boolean }); } catch { /* */ }
});

describe("storage bug fixes", () => {
  test("#1 cleanupOrphanedContent preserves content referenced by inactive docs", async () => {
    const store = await createTestStore();
    const now = new Date().toISOString();
    const body = "# History matters";
    const hash = await hashContent(body);

    store.insertContent(hash, body, now);
    store.insertDocument("c", "docs/a.md", "a", hash, now, now);
    // Deactivate — row stays with active=0.
    store.deactivateDocument("c", "docs/a.md");

    const removed = store.cleanupOrphanedContent();
    expect(removed).toBe(0);

    const contentRow = store.db
      .prepare(`SELECT doc FROM content WHERE hash = ?`)
      .get(hash) as { doc: string } | undefined;
    expect(contentRow?.doc).toBe(body);

    const docRow = store.db
      .prepare(`SELECT active FROM documents WHERE collection = ? AND path = ?`)
      .get("c", "docs/a.md") as { active: number } | undefined;
    expect(docRow?.active).toBe(0);

    await destroyTestStore(store);
  });

  test("#11 getCacheKey is canonical wrt object key order", () => {
    const a = getCacheKey("https://example.test/foo", { model: "x", input: "y" });
    const b = getCacheKey("https://example.test/foo", { input: "y", model: "x" });
    expect(a).toBe(b);

    const nested1 = getCacheKey("u", { meta: { a: 1, b: 2 }, q: "x" });
    const nested2 = getCacheKey("u", { q: "x", meta: { b: 2, a: 1 } });
    expect(nested1).toBe(nested2);
  });

  test("#12 insertDocument refuses to write without backing content row", async () => {
    const store = await createTestStore();
    const now = new Date().toISOString();
    const fakeHash = "deadbeef".repeat(8);
    expect(() => store.insertDocument("c", "x.md", "x", fakeHash, now, now)).toThrow(
      /content row for hash .* is missing/i
    );
    await destroyTestStore(store);
  });

  test("#14 schema-version registry refuses to stamp beyond known migrations", async () => {
    const store = await createTestStore();
    const v = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(1);
    await destroyTestStore(store);
  });

  test("#7 deleteMemory stitches supersession chain A->B->C into A->C", async () => {
    const dbPath = join(testDir, `mem-${Date.now()}.sqlite`);
    const db = openDatabase(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    initializeMemorySchema(db);
    initializeMemoryFeedbackSchema(db);
    initializeMemoryScopeConfigSchema(db);

    const scope = "test";
    const aRow = await upsertMemory(db, { scope, key: "prefer:vehicle", value: "bike", disableSemanticDedup: true });
    const bRow = await upsertMemory(db, { scope, key: "prefer:vehicle", value: "car", disableSemanticDedup: true });
    db.prepare(`UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?`)
      .run(bRow.id, new Date().toISOString(), aRow.id);
    const cRow = await upsertMemory(db, { scope, key: "prefer:vehicle", value: "train", disableSemanticDedup: true });
    db.prepare(`UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?`)
      .run(cRow.id, new Date().toISOString(), bRow.id);

    deleteMemory(db, scope, bRow.id);

    const aAfter = db.prepare(`SELECT superseded_by FROM memories WHERE id = ?`).get(aRow.id) as { superseded_by: number | null };
    expect(aAfter.superseded_by).toBe(cRow.id);

    db.close();
    await unlink(dbPath);
    try { await unlink(`${dbPath}-wal`); } catch { /* */ }
    try { await unlink(`${dbPath}-shm`); } catch { /* */ }
  });

  // --- round 2 ---

  test("A removeCollection preserves shared content referenced by inactive docs in other collections", async () => {
    const store = await createTestStore();
    await registerTestCollection("a");
    await registerTestCollection("b");
    const now = new Date().toISOString();
    const body = "# shared";
    const hash = await hashContent(body);
    store.insertContent(hash, body, now);
    // doc in collection A (active)
    store.insertDocument("a", "shared.md", "shared", hash, now, now);
    // doc in collection B with the same hash, then deactivate it
    store.insertDocument("b", "shared.md", "shared", hash, now, now);
    store.deactivateDocument("b", "shared.md");

    // Removing A should NOT take the content row with it (B's inactive
    // row still references hash; the old buggy SQL would have orphan-cleaned
    // it and FK CASCADE would have killed B's row).
    removeCollection(store.db, "a");

    const contentRow = store.db.prepare(`SELECT 1 AS x FROM content WHERE hash = ?`).get(hash);
    expect(contentRow).toBeTruthy();
    const bRow = store.db.prepare(
      `SELECT active FROM documents WHERE collection = ? AND path = ?`
    ).get("b", "shared.md") as { active: number } | undefined;
    expect(bRow?.active).toBe(0);

    await destroyTestStore(store);
  });

  test("B renameCollection updates every table that carries a collection column", async () => {
    const store = await createTestStore();
    await registerTestCollection("old");
    const now = new Date().toISOString();
    const body = "# rename test";
    const hash = await hashContent(body);
    store.insertContent(hash, body, now);
    store.insertDocument("old", "a.md", "a", hash, now, now);
    upsertDocumentIngestion(store.db, "old", "a.md", {
      format: "md", extractor: "native-text", warnings: [],
      contentHash: hash, extractedAt: now,
    });
    upsertDocumentLinks(store.db, "old", "a.md", ["b.md"]);

    renameCollection(store.db, "old", "new");

    const docRow = store.db.prepare(`SELECT collection FROM documents WHERE path = ?`).get("a.md") as { collection: string };
    expect(docRow.collection).toBe("new");
    const linkRow = store.db.prepare(
      `SELECT collection FROM document_links WHERE source_path = ?`
    ).get("a.md") as { collection: string };
    expect(linkRow.collection).toBe("new");
    const ingestRow = store.db.prepare(
      `SELECT collection FROM document_ingest WHERE path = ?`
    ).get("a.md") as { collection: string };
    expect(ingestRow.collection).toBe("new");

    // No remaining rows still keyed by the old name.
    const leftover = store.db.prepare(
      `SELECT COUNT(*) AS c FROM documents WHERE collection = ?`
    ).get("old") as { c: number };
    expect(leftover.c).toBe(0);

    await destroyTestStore(store);
  });

  test("D findDocumentByDocid rejects sub-6-char and non-hex inputs", async () => {
    const store = await createTestStore();
    expect(findDocumentByDocid(store.db, "a")).toBeNull();
    expect(findDocumentByDocid(store.db, "abc")).toBeNull();
    expect(findDocumentByDocid(store.db, "_eadbeef")).toBeNull();
    expect(findDocumentByDocid(store.db, "deadbZ")).toBeNull(); // not hex
    await destroyTestStore(store);
  });

  test("I listCollections returns one stats row per declared collection", async () => {
    const store = await createTestStore();
    await registerTestCollection("alpha");
    await registerTestCollection("beta");
    const now = new Date().toISOString();
    const body = "# x";
    const hash = await hashContent(body);
    store.insertContent(hash, body, now);
    store.insertDocument("alpha", "a.md", "a", hash, now, now);
    store.insertDocument("beta", "b.md", "b", hash, now, now);

    const rows = listCollections(store.db);
    const byName = new Map(rows.map(r => [r.name, r]));
    expect(byName.get("alpha")?.active_count).toBe(1);
    expect(byName.get("beta")?.active_count).toBe(1);

    await destroyTestStore(store);
  });

  test("J findSimilarFiles SQL-side length filter restricts candidates", async () => {
    const store = await createTestStore();
    await registerTestCollection("c");
    const now = new Date().toISOString();
    for (const p of ["very-long-document-path-name-001.md", "x.md", "y.md", "near.md"]) {
      const body = `# ${p}`;
      const hash = await hashContent(body);
      store.insertContent(hash, body, now);
      store.insertDocument("c", p, p, hash, now, now);
    }
    // query "year.md" is len 7; candidates within ±3 cover "x.md","y.md","near.md".
    const matches = findSimilarFiles(store.db, "year.md", 3, 5);
    expect(matches).toContain("near.md");
    await destroyTestStore(store);
  });

  test("K rerank controller can be evicted and pruned", () => {
    const before = getRerankControllerCount();
    // acquire and release immediately so the controller is idle
    const slot = acquireRerankSlot({ key: "test-evict", concurrency: 1, queueLimit: null, dropPolicy: "wait" });
    // synchronously resolve happy-path: slot is a Promise but with concurrency=1 and no contention it resolves immediately
    return slot.then(s => {
      s.release?.();
      expect(getRerankControllerCount()).toBeGreaterThanOrEqual(before + 1);
      expect(evictRerankController("test-evict")).toBe(true);
      expect(evictRerankController("test-evict")).toBe(false);
      // pruneIdle is a no-op since we just evicted, but verify it doesn't throw
      pruneIdleRerankControllers();
    });
  });

  test("L documents_au trigger skips FTS rewrite when only modified_at changes", async () => {
    const store = await createTestStore();
    await registerTestCollection("c");
    const now = new Date().toISOString();
    const body = "# only modified_at touch";
    const hash = await hashContent(body);
    store.insertContent(hash, body, now);
    store.insertDocument("c", "t.md", "t", hash, now, now);

    const ftsBefore = store.db.prepare(
      `SELECT rowid, body FROM documents_fts WHERE filepath = ?`
    ).get("c/t.md") as { rowid: number; body: string };
    expect(ftsBefore.body).toContain("only modified_at touch");

    // Bump only modified_at — the gated trigger must NOT fire.
    const later = new Date(Date.now() + 1000).toISOString();
    store.db.prepare(
      `UPDATE documents SET modified_at = ? WHERE collection = ? AND path = ?`
    ).run(later, "c", "t.md");

    const ftsAfter = store.db.prepare(
      `SELECT rowid, body FROM documents_fts WHERE filepath = ?`
    ).get("c/t.md") as { rowid: number; body: string };
    expect(ftsAfter.rowid).toBe(ftsBefore.rowid);
    expect(ftsAfter.body).toBe(ftsBefore.body);

    await destroyTestStore(store);
  });

  test("#9 evictIfNeeded is reentrant inside an outer txn (no nested-BEGIN error)", async () => {
    const dbPath = join(testDir, `mem-evict-${Date.now()}.sqlite`);
    const db = openDatabase(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    initializeMemorySchema(db);
    initializeMemoryFeedbackSchema(db);
    initializeMemoryScopeConfigSchema(db);

    const scope = "evict-test";
    setScopeMemoryLimit(db, scope, 2);
    for (let i = 0; i < 3; i++) {
      await upsertMemory(db, { scope, key: `k${i}`, value: `v${i}`, disableSemanticDedup: true });
    }

    // External call (no outer txn).
    const evicted = evictIfNeeded(db, scope, 2);
    expect(evicted).toBeGreaterThanOrEqual(0);

    // Reentry: call from within an already-open transaction must NOT throw.
    db.exec("BEGIN IMMEDIATE");
    expect(() => evictIfNeeded(db, scope, 2)).not.toThrow();
    db.exec("COMMIT");

    db.close();
    await unlink(dbPath);
    try { await unlink(`${dbPath}-wal`); } catch { /* */ }
    try { await unlink(`${dbPath}-shm`); } catch { /* */ }
  });
});
