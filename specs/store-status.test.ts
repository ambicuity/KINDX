/**
 * store-status.test.ts - Index status, fuzzy matching, and vector table tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import type { Database } from "../engine/runtime.js";
import { unlink, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { disposeDefaultLLM } from "../engine/inference.js";
import {
  createStore,
  hashContent,
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

  const configPrefix = join(testDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  testConfigDir = await mkdtemp(configPrefix);

  process.env.KINDX_CONFIG_DIR = testConfigDir;

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

  delete process.env.KINDX_CONFIG_DIR;
}

async function insertTestDocument(
  db: Database,
  collectionName: string,
  opts: {
    name?: string;
    title?: string;
    hash?: string;
    displayPath?: string;
    filepath?: string;
    body?: string;
    active?: number;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const name = opts.name || "test-doc";
  const title = opts.title || "Test Document";

  let path: string;
  if (opts.displayPath) {
    path = opts.displayPath;
  } else if (opts.filepath) {
    path = opts.filepath.startsWith('/') ? opts.filepath : opts.filepath;
  } else {
    path = `test/${name}.md`;
  }

  const body = opts.body || "# Test Document\n\nThis is test content.";
  const active = opts.active ?? 1;

  const hash = opts.hash || await hashContent(body);

  db.prepare(`
    INSERT OR IGNORE INTO content (hash, doc, created_at)
    VALUES (?, ?, ?)
  `).run(hash, body, now);

  const result = db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(collectionName, path, title, hash, now, now, active);

  return Number(result.lastInsertRowid);
}

async function createTestCollection(
  options: { pwd?: string; glob?: string; name?: string } = {}
): Promise<string> {
  const pwd = options.pwd || "/test/collection";
  const glob = options.glob || "**/*.md";
  const name = options.name || pwd.split('/').filter(Boolean).pop() || 'test';

  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  config.collections[name] = {
    path: pwd,
    pattern: glob,
  };

  await writeFile(configPath, YAML.stringify(config));
  return name;
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kindx-test-status-"));
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
// Index Status Tests
// =============================================================================

describe("Index Status", () => {
  test("getStatus returns correct structure", async () => {
    const store = await createTestStore();
    const status = store.getStatus();
    expect(status).toHaveProperty("totalDocuments");
    expect(status).toHaveProperty("needsEmbedding");
    expect(status).toHaveProperty("hasVectorIndex");
    expect(status).toHaveProperty("collections");
    expect(Array.isArray(status.collections)).toBe(true);

    await cleanupTestDb(store);
  });

  test("getStatus counts documents correctly", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, { name: "doc1", active: 1 });
    await insertTestDocument(store.db, collectionName, { name: "doc2", active: 1 });
    await insertTestDocument(store.db, collectionName, { name: "doc3", active: 0 }); // inactive

    const status = store.getStatus();
    expect(status.totalDocuments).toBe(2); // Only active docs

    await cleanupTestDb(store);
  });

  test("getStatus reports collection info", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/path", glob: "**/*.md" });
    await insertTestDocument(store.db, collectionName, { name: "doc1" });

    const status = store.getStatus();
    expect(status.collections.length).toBeGreaterThanOrEqual(1);
    const col = status.collections.find(c => c.name === collectionName);
    expect(col).toBeDefined();
    expect(col?.path).toBe("/test/path");
    expect(col?.pattern).toBe("**/*.md");
    expect(col?.documents).toBe(1);

    await cleanupTestDb(store);
  });

  test("getHashesNeedingEmbedding counts correctly", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    // Add documents with different hashes
    await insertTestDocument(store.db, collectionName, { name: "doc1", hash: "hash1" });
    await insertTestDocument(store.db, collectionName, { name: "doc2", hash: "hash2" });
    await insertTestDocument(store.db, collectionName, { name: "doc3", hash: "hash1" }); // same hash as doc1

    const needsEmbedding = store.getHashesNeedingEmbedding();
    expect(needsEmbedding).toBe(2); // hash1 and hash2

    await cleanupTestDb(store);
  });

  test("getIndexHealth returns health info", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, { name: "doc1" });

    const health = store.getIndexHealth();
    expect(health).toHaveProperty("needsEmbedding");
    expect(health).toHaveProperty("totalDocs");
    expect(health).toHaveProperty("daysStale");
    expect(health.totalDocs).toBe(1);

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Fuzzy Matching Tests
// =============================================================================

describe("Fuzzy Matching", () => {
  test("findSimilarFiles finds similar paths", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, {
      name: "readme",
      displayPath: "docs/readme.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "readmi",
      displayPath: "docs/readmi.md", // typo
    });

    const similar = store.findSimilarFiles("docs/readme.md", 3, 5);
    expect(similar).toContain("docs/readme.md");

    await cleanupTestDb(store);
  });

  test("findSimilarFiles respects maxDistance", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, {
      name: "abc",
      displayPath: "abc.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "xyz",
      displayPath: "xyz.md", // very different
    });

    const similar = store.findSimilarFiles("abc.md", 1, 5); // max distance 1
    expect(similar).toContain("abc.md");
    expect(similar).not.toContain("xyz.md");

    await cleanupTestDb(store);
  });

  test("matchFilesByGlob matches patterns", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/journals/2024-01.md",
      displayPath: "journals/2024-01.md",
    });
    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/journals/2024-02.md",
      displayPath: "journals/2024-02.md",
    });
    await insertTestDocument(store.db, collectionName, {
      filepath: "/p/docs/readme.md",
      displayPath: "docs/readme.md",
    });

    const matches = store.matchFilesByGlob("journals/*.md");
    expect(matches).toHaveLength(2);
    expect(matches.every(m => m.displayPath.startsWith("journals/"))).toBe(true);

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Vector Table Tests
// =============================================================================

describe("Vector Table", () => {
  test("ensureVecTable creates vector table", async () => {
    const store = await createTestStore();

    // Initially no vector table
    let exists = store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get();
    expect(exists).toBeFalsy(); // null or undefined

    // Create vector table
    store.ensureVecTable(768);

    exists = store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get();
    expect(exists).toBeTruthy();

    await cleanupTestDb(store);
  });

  test("ensureVecTable recreates table if dimensions change", async () => {
    const store = await createTestStore();

    // Create with 768 dimensions
    store.ensureVecTable(768);

    // Check dimensions
    let tableInfo = store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get() as { sql: string };
    expect(tableInfo.sql).toContain("float[768]");

    // Recreate with different dimensions
    store.ensureVecTable(1024);

    tableInfo = store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'
    `).get() as { sql: string };
    expect(tableInfo.sql).toContain("float[1024]");

    await cleanupTestDb(store);
  });
});
