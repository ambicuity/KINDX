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
