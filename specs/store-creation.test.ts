/**
 * store-creation.test.ts - Store creation and initialization tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { openDatabase, loadSqliteVec } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import { unlink, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { disposeDefaultLLM } from "../engine/inference.js";
import {
  createStore,
  verifySqliteVecLoaded,
  type Store,
} from "../engine/repository.js";
import type { CollectionConfig } from "../engine/catalogs.js";

// =============================================================================
// Test Utilities
// =============================================================================

let testDir: string;
let testDbPath: string;
let testConfigDir: string;

async function createTestStore(): Promise<Store> {
  testDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

  // Set up test config directory
  const configPrefix = join(testDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  testConfigDir = await mkdtemp(configPrefix);

  // Set environment variable to use test config
  process.env.KINDX_CONFIG_DIR = testConfigDir;

  // Create empty YAML config
  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(
    join(testConfigDir, "index.yml"),
    YAML.stringify(emptyConfig)
  );

  return createStore(testDbPath);
}

async function cleanupTestDb(store: Store): Promise<void> {
  store.close();
  try {
    await unlink(store.dbPath);
  } catch {
    // Ignore if file doesn't exist
  }

  // Clean up test config directory
  try {
    const { readdir, unlink: unlinkFile, rmdir: rmdirAsync } = await import("node:fs/promises");
    const files = await readdir(testConfigDir);
    for (const file of files) {
      await unlinkFile(join(testConfigDir, file));
    }
    await rmdirAsync(testConfigDir);
  } catch {
    // Ignore cleanup errors
  }

  // Clear environment variable
  delete process.env.KINDX_CONFIG_DIR;
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kindx-test-creation-"));
});

afterAll(async () => {
  await disposeDefaultLLM();

  try {
    const { readdir, unlink } = await import("node:fs/promises");
    const files = await readdir(testDir);
    for (const file of files) {
      await unlink(join(testDir, file));
    }
    await rmdir(testDir);
  } catch {
    // Ignore cleanup errors
  }
});

// =============================================================================
// Store Creation Tests
// =============================================================================

describe("Store Creation", () => {
  test("createStore throws without explicit path in test mode", () => {
    // In test mode, createStore without path should throw to prevent accidental writes
    const originalIndexPath = process.env.INDEX_PATH;
    delete process.env.INDEX_PATH;

    expect(() => createStore()).toThrow("Database path not set");

    // Restore
    if (originalIndexPath) process.env.INDEX_PATH = originalIndexPath;
  });

  test("createStore creates a new store with custom path", async () => {
    const store = await createTestStore();
    expect(store.dbPath).toBe(testDbPath);
    expect(store.db).toBeDefined();
    expect(typeof store.db.exec).toBe("function");
    await cleanupTestDb(store);
  });

  test("createStore initializes database schema", async () => {
    const store = await createTestStore();

    // Check tables exist
    const tables = store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
    `).all() as { name: string }[];

    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain("documents");
    expect(tableNames).toContain("content");
    expect(tableNames).toContain("documents_fts");
    expect(tableNames).toContain("content_vectors");
    expect(tableNames).toContain("llm_cache");
    // Note: path_contexts table removed in favor of YAML-based context storage

    await cleanupTestDb(store);
  });

  test("createStore sets WAL journal mode", async () => {
    const store = await createTestStore();
    const result = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
    await cleanupTestDb(store);
  });

  test("verifySqliteVecLoaded throws when sqlite-vec is not loaded", () => {
    const db = openDatabase(":memory:");
    try {
      expect(() => verifySqliteVecLoaded(db)).toThrow("sqlite-vec extension is unavailable");
    } finally {
      db.close();
    }
  });

  test("verifySqliteVecLoaded succeeds when sqlite-vec is loaded", () => {
    const db = openDatabase(":memory:");
    try {
      loadSqliteVec(db);
      expect(() => verifySqliteVecLoaded(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("store.close closes the database connection", async () => {
    const store = await createTestStore();
    store.close();
    // Attempting to use db after close should throw
    expect(() => store.db.prepare("SELECT 1").get()).toThrow();
    try {
      await unlink(testDbPath);
    } catch { }
  });
});
