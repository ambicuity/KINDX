/**
 * store-integration.test.ts - Integration tests, edge cases, LlamaCpp integration, and content-addressable storage
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import type { Database } from "../engine/runtime.js";
import { unlink, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import * as llmModule from "../engine/inference.js";
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

async function addPathContext(collectionName: string, pathPrefix: string, contextText: string): Promise<void> {
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  if (!config.collections[collectionName]) {
    throw new Error(`Collection ${collectionName} not found`);
  }

  if (!config.collections[collectionName].context) {
    config.collections[collectionName].context = {};
  }

  config.collections[collectionName].context![pathPrefix] = contextText;

  await writeFile(configPath, YAML.stringify(config));
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kindx-test-integration-"));
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
// Integration Tests
// =============================================================================

describe("Integration", () => {
  test("full document lifecycle: create, search, retrieve", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/notes", glob: "**/*.md" });

    // Add context - use "/" for collection root
    await addPathContext(collectionName, "/", "Personal notes");

    // Insert documents
    await insertTestDocument(store.db, collectionName, {
      name: "meeting",
      title: "Team Meeting Notes",
      filepath: "/test/notes/meeting.md",
      displayPath: "notes/meeting.md",
      body: "# Team Meeting Notes\n\nDiscussed project timeline and deliverables.",
    });

    await insertTestDocument(store.db, collectionName, {
      name: "ideas",
      title: "Project Ideas",
      filepath: "/test/notes/ideas.md",
      displayPath: "notes/ideas.md",
      body: "# Project Ideas\n\nBrainstorming new features for the product.",
    });

    // Search
    const searchResults = store.searchFTS("project", 10);
    expect(searchResults.length).toBe(2);

    // Retrieve single document
    const doc = store.findDocument("notes/meeting.md", { includeBody: true });
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toBe("Team Meeting Notes");
      expect(doc.context).toBe("Personal notes");
      expect(doc.body).toContain("Team Meeting");
    }

    // Multi-get
    const { docs, errors } = store.findDocuments("notes/*.md", { includeBody: true });
    expect(errors).toHaveLength(0);
    expect(docs).toHaveLength(2);

    await cleanupTestDb(store);
  });

  test("multiple stores can operate independently", async () => {
    const store1 = await createTestStore();
    const store2 = await createTestStore();

    const col1 = await createTestCollection({ pwd: "/store1", glob: "**/*.md", name: "store1" });
    const col2 = await createTestCollection({ pwd: "/store2", glob: "**/*.md", name: "store2" });

    await insertTestDocument(store1.db, col1, {
      name: "doc1",
      body: "unique content for store1",
      displayPath: "doc.md",
    });

    await insertTestDocument(store2.db, col2, {
      name: "doc2",
      body: "different content for store2",
      displayPath: "doc.md",
    });

    // Each store should only see its own documents
    const results1 = store1.searchFTS("unique", 10);
    const results2 = store2.searchFTS("different", 10);

    expect(results1).toHaveLength(1);
    expect(results1[0]!.displayPath).toBe("store1/doc.md");
    expect(results1[0]!.filepath).toBe("kindx://store1/doc.md");

    expect(results2).toHaveLength(1);
    expect(results2[0]!.displayPath).toBe("store2/doc.md");
    expect(results2[0]!.filepath).toBe("kindx://store2/doc.md");

    // Cross-check: store1 shouldn't find store2's content
    const cross1 = store1.searchFTS("different", 10);
    const cross2 = store2.searchFTS("unique", 10);

    expect(cross1).toHaveLength(0);
    expect(cross2).toHaveLength(0);

    await cleanupTestDb(store1);
    await cleanupTestDb(store2);
  });
});

// =============================================================================
// LlamaCpp Integration Tests (using real local models)
// =============================================================================

describe.skipIf(!!process.env.CI)("LlamaCpp Integration", () => {
  test("searchVec returns empty when no vector index", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "Some content",
    });

    // No vectors_vec table exists, should return empty
    const results = await store.searchVec("query", "embeddinggemma", 10);
    expect(results).toHaveLength(0);

    await cleanupTestDb(store);
  });

  test("searchVec returns results when vector index exists", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    const hash = "testhash123";
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      hash,
      body: "Some content about testing",
      filepath: "/test/doc1.md",
      displayPath: "doc1.md",
    });

    // Create vector table and insert a vector
    store.ensureVecTable(768);
    const embedding = Array(768).fill(0).map(() => Math.random());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash, new Date().toISOString());
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(embedding));

    const results = await store.searchVec("test query", "embeddinggemma", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.displayPath).toBe(`${collectionName}/doc1.md`);
    expect(results[0]!.filepath).toBe(`kindx://${collectionName}/doc1.md`);
    expect(results[0]!.source).toBe("vec");

    await cleanupTestDb(store);
  });

  test("searchVec filters by collection name", async () => {
    const store = await createTestStore();
    const collection1 = await createTestCollection({ name: "coll1", pwd: "/test/coll1" });
    const collection2 = await createTestCollection({ name: "coll2", pwd: "/test/coll2" });

    const hash1 = "hash1abc";
    const hash2 = "hash2xyz";

    await insertTestDocument(store.db, collection1, {
      name: "doc1",
      hash: hash1,
      body: "Content in collection one",
    });

    await insertTestDocument(store.db, collection2, {
      name: "doc2",
      hash: hash2,
      body: "Content in collection two",
    });

    // Create vectors_vec table with correct dimensions (768 for embeddinggemma)
    store.ensureVecTable(768);
    const embedding1 = Array(768).fill(0).map(() => Math.random());
    const embedding2 = Array(768).fill(0).map(() => Math.random());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash1, new Date().toISOString());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash2, new Date().toISOString());
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash1}_0`, new Float32Array(embedding1));
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash2}_0`, new Float32Array(embedding2));

    // Search without filter - should return both
    const allResults = await store.searchVec("content", "embeddinggemma", 10);
    expect(allResults).toHaveLength(2);

    // Search with collection filter - should return only from collection1
    const filtered = await store.searchVec("content", "embeddinggemma", 10, collection1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.collectionName).toBe(collection1);

    await cleanupTestDb(store);
  });

  // Regression test for https://github.com/ambicuity/KINDX/pull/23
  // sqlite-vec virtual tables hang when combined with JOINs in the same query.
  // The fix uses a two-step approach: vector query first, then separate JOINs.
  test("searchVec uses two-step query to avoid sqlite-vec JOIN hang", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    const hash = "regression_test_hash";
    await insertTestDocument(store.db, collectionName, {
      name: "regression-doc",
      hash,
      body: "Test content for vector search regression",
      filepath: "/test/regression.md",
      displayPath: "regression.md",
    });

    // Create vector table and insert a test vector
    store.ensureVecTable(768);
    const embedding = Array(768).fill(0).map(() => Math.random());
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'test', ?)`).run(hash, new Date().toISOString());
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(embedding));

    // This should complete quickly (not hang) due to the two-step fix
    // The old code with JOINs in the sqlite-vec query would hang indefinitely
    const startTime = Date.now();
    const results = await store.searchVec("test content", "embeddinggemma", 5);
    const elapsed = Date.now() - startTime;

    // If the query took more than 5 seconds, something is wrong
    // (the hang bug would cause it to never return at all)
    expect(elapsed).toBeLessThan(5000);
    expect(results.length).toBeGreaterThan(0);

    await cleanupTestDb(store);
  });

  test("expandQuery returns typed expansions (no original query)", async () => {
    const store = await createTestStore();

    const expanded = await store.expandQuery("this is a test query for expansion");
    // Returns ExpandedQuery[] — typed results from LLM, excluding original
    expect(expanded.length).toBeGreaterThanOrEqual(1);
    for (const q of expanded) {
      expect(['lex', 'vec', 'hyde']).toContain(q.type);
      expect(q.text.length).toBeGreaterThan(0);
      expect(q.text).not.toBe("this is a test query for expansion"); // original excluded
    }

    await cleanupTestDb(store);
  }, 30000);

  test("expandQuery caches results as JSON with types", async () => {
    const store = await createTestStore();

    // First call — hits LLM
    const queries1 = await store.expandQuery("this is a cached query test");
    // Second call — hits cache
    const queries2 = await store.expandQuery("this is a cached query test");

    // Cache should preserve full typed structure
    expect(queries1).toEqual(queries2);
    expect(queries2[0]?.type).toBeDefined();

    await cleanupTestDb(store);
  }, 30000);

  test("rerank scores documents", async () => {
    const store = await createTestStore();

    const docs = [
      { file: "doc1.md", text: "Relevant content about the topic" },
      { file: "doc2.md", text: "Other content" },
    ];

    const results = await store.rerank("topic", docs);
    expect(results).toHaveLength(2);
    // LlamaCpp reranker returns relevance scores
    expect(results[0]!.score).toBeGreaterThan(0);

    await cleanupTestDb(store);
  });

  test("rerank caches results", async () => {
    const store = await createTestStore();

    const docs = [{ file: "doc1.md", text: "Content for caching test" }];

    // First call
    await store.rerank("cache test query", docs);
    // Second call - should hit cache
    const results = await store.rerank("cache test query", docs);

    expect(results).toHaveLength(1);

    await cleanupTestDb(store);
  });

  test("rerank deduplicates identical chunks across files", async () => {
    const store = await createTestStore();
    const rerankSpy = vi.fn(async (_query: string, docs: { file: string; text: string }[]) => ({
      results: docs.map((doc, index) => ({
        file: doc.file,
        score: 1 - index * 0.1,
        index,
      })),
      model: "mock-reranker",
    }));

    const llmSpy = vi.spyOn(llmModule, "getDefaultLLM").mockReturnValue({
      rerank: rerankSpy,
    } as any);

    try {
      const docs = [
        { file: "doc1.md", text: "Shared chunk text" },
        { file: "doc2.md", text: "Shared chunk text" },
      ];

      const first = await store.rerank("shared", docs);
      const second = await store.rerank("shared", docs);

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(rerankSpy).toHaveBeenCalledTimes(1);
      expect(rerankSpy.mock.calls[0]?.[1]).toEqual([{ file: "doc2.md", text: "Shared chunk text" }]);
    } finally {
      llmSpy.mockRestore();
      await cleanupTestDb(store);
    }
  });
});

// =============================================================================
// Edge Cases & Error Handling
// =============================================================================

describe("Edge Cases", () => {
  test("handles empty database gracefully", async () => {
    const store = await createTestStore();

    const searchResults = store.searchFTS("anything", 10);
    expect(searchResults).toHaveLength(0);

    const doc = store.findDocument("nonexistent.md");
    expect("error" in doc).toBe(true);

    await cleanupTestDb(store);
  });

  test.todo("getStatus returns zero counts for empty store (blocked by collections table bug)");

  test("handles very long document bodies", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    const longBody = "word ".repeat(100000); // ~600KB
    await insertTestDocument(store.db, collectionName, {
      name: "long",
      body: longBody,
      displayPath: "long.md",
    });

    const results = store.searchFTS("word", 10);
    expect(results).toHaveLength(1);

    await cleanupTestDb(store);
  });

  test("handles unicode content correctly", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, {
      name: "unicode",
      title: "日本語タイトル",
      body: "# 日本語\n\n内容は日本語で書かれています。\n\nEmoji: 🎉🚀✨",
      displayPath: "unicode.md",
    });

    // Should be searchable
    const results = store.searchFTS("日本語", 10);
    expect(results.length).toBeGreaterThan(0);

    // Should retrieve correctly
    const doc = store.findDocument("unicode.md", { includeBody: true });
    expect("error" in doc).toBe(false);
    if (!("error" in doc)) {
      expect(doc.title).toBe("日本語タイトル");
      expect(doc.body).toContain("🎉");
    }

    await cleanupTestDb(store);
  });

  test("handles documents with special characters in paths", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, {
      name: "special",
      filepath: "/path/file with spaces.md",
      displayPath: "file with spaces.md",
      body: "Content",
    });

    const doc = store.findDocument("file with spaces.md");
    expect("error" in doc).toBe(false);

    await cleanupTestDb(store);
  });

  test("handles concurrent operations", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    // Insert multiple documents concurrently
    const inserts = Array.from({ length: 10 }, (_, i) =>
      insertTestDocument(store.db, collectionName, {
        name: `concurrent${i}`,
        body: `Content ${i} searchterm`,
        displayPath: `concurrent${i}.md`,
      })
    );

    await Promise.all(inserts);

    // All should be searchable
    const results = store.searchFTS("searchterm", 20);
    expect(results).toHaveLength(10);

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Content-Addressable Storage Tests
// =============================================================================

describe("Content-Addressable Storage", () => {
  test("same content gets same hash from multiple collections", async () => {
    const store = await createTestStore();

    // Create two collections
    const collection1 = await createTestCollection({ pwd: "/path/collection1", name: "collection1" });
    const collection2 = await createTestCollection({ pwd: "/path/collection2", name: "collection2" });

    // Add same content to both collections
    const content = "# Same Content\n\nThis is the same content in two places.";
    const hash1 = await hashContent(content);

    const doc1 = await insertTestDocument(store.db, collection1, {
      name: "doc1",
      body: content,
      displayPath: "doc1.md",
    });

    const doc2 = await insertTestDocument(store.db, collection2, {
      name: "doc2",
      body: content,
      displayPath: "doc2.md",
    });

    // Both should have the same hash
    const hash1Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc1) as { hash: string };
    const hash2Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc2) as { hash: string };

    expect(hash1Db.hash).toBe(hash2Db.hash);
    expect(hash1Db.hash).toBe(hash1);

    // There should only be one entry in the content table
    const contentCount = store.db.prepare(`SELECT COUNT(*) as count FROM content WHERE hash = ?`).get(hash1) as { count: number };
    expect(contentCount.count).toBe(1);

    await cleanupTestDb(store);
  });

  test("removing one collection preserves content used by another", async () => {
    const store = await createTestStore();

    // Create two collections
    const collection1 = await createTestCollection({ pwd: "/path/collection1", name: "collection1" });
    const collection2 = await createTestCollection({ pwd: "/path/collection2", name: "collection2" });

    // Add same content to both collections
    const sharedContent = "# Shared Content\n\nThis is shared.";
    const sharedHash = await hashContent(sharedContent);

    await insertTestDocument(store.db, collection1, {
      name: "shared1",
      body: sharedContent,
      displayPath: "shared1.md",
    });

    await insertTestDocument(store.db, collection2, {
      name: "shared2",
      body: sharedContent,
      displayPath: "shared2.md",
    });

    // Add unique content to collection1
    const uniqueContent = "# Unique Content\n\nThis is unique to collection1.";
    const uniqueHash = await hashContent(uniqueContent);

    await insertTestDocument(store.db, collection1, {
      name: "unique",
      body: uniqueContent,
      displayPath: "unique.md",
    });

    // Verify both hashes exist in content table
    const sharedExists1 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(sharedHash);
    const uniqueExists1 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(uniqueHash);
    expect(sharedExists1).toBeTruthy();
    expect(uniqueExists1).toBeTruthy();

    // Remove collection1 documents (collections are in YAML now)
    store.db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collection1);

    // Clean up orphaned content (mimics what the CLI does)
    store.db.prepare(`
      DELETE FROM content
      WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
    `).run();

    // Shared content should still exist (used by collection2)
    const sharedExists2 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(sharedHash);
    expect(sharedExists2).toBeTruthy();

    // Unique content should be removed (only used by collection1)
    const uniqueExists2 = store.db.prepare(`SELECT hash FROM content WHERE hash = ?`).get(uniqueHash);
    expect(uniqueExists2).toBeFalsy();

    await cleanupTestDb(store);
  });

  test("deduplicates content across many collections", async () => {
    const store = await createTestStore();

    const sharedContent = "# Common Header\n\nThis appears everywhere.";
    const sharedHash = await hashContent(sharedContent);

    // Create 5 collections with the same content
    const collectionNames = [];
    for (let i = 0; i < 5; i++) {
      const collName = await createTestCollection({ pwd: `/path/collection${i}`, name: `collection${i}` });
      collectionNames.push(collName);

      await insertTestDocument(store.db, collName, {
        name: `doc${i}`,
        body: sharedContent,
        displayPath: `doc${i}.md`,
      });
    }

    // Should have 5 documents
    const docCount = store.db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
    expect(docCount.count).toBe(5);

    // But only 1 content entry
    const contentCount = store.db.prepare(`SELECT COUNT(*) as count FROM content WHERE hash = ?`).get(sharedHash) as { count: number };
    expect(contentCount.count).toBe(1);

    // All documents should point to the same hash
    const hashes = store.db.prepare(`SELECT DISTINCT hash FROM documents WHERE active = 1`).all() as { hash: string }[];
    expect(hashes).toHaveLength(1);
    expect(hashes[0]!.hash).toBe(sharedHash);

    await cleanupTestDb(store);
  });

  test("different content gets different hashes", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    const content1 = "# Content One";
    const content2 = "# Content Two";
    const hash1 = await hashContent(content1);
    const hash2 = await hashContent(content2);

    // Hashes should be different
    expect(hash1).not.toBe(hash2);

    const doc1 = await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: content1,
      displayPath: "doc1.md",
    });

    const doc2 = await insertTestDocument(store.db, collectionName, {
      name: "doc2",
      body: content2,
      displayPath: "doc2.md",
    });

    // Both hashes should exist in content table
    const hash1Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc1) as { hash: string };
    const hash2Db = store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(doc2) as { hash: string };

    expect(hash1Db.hash).toBe(hash1);
    expect(hash2Db.hash).toBe(hash2);
    expect(hash1Db.hash).not.toBe(hash2Db.hash);

    // Should have 2 entries in content table
    const contentCount = store.db.prepare(`SELECT COUNT(*) as count FROM content`).get() as { count: number };
    expect(contentCount.count).toBe(2);

    await cleanupTestDb(store);
  });

  test("re-indexing a previously deactivated path reactivates instead of violating UNIQUE", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    const now = new Date().toISOString();

    const oldContent = "# First Version";
    const oldHash = await hashContent(oldContent);
    store.insertContent(oldHash, oldContent, now);
    store.insertDocument(collectionName, "docs/foo.md", "foo", oldHash, now, now);

    // Simulate file removal during update pass.
    store.deactivateDocument(collectionName, "docs/foo.md");
    expect(store.findActiveDocument(collectionName, "docs/foo.md")).toBeNull();

    // Simulate file coming back in a later update pass.
    const newContent = "# Second Version";
    const newHash = await hashContent(newContent);
    store.insertContent(newHash, newContent, now);

    expect(() => {
      store.insertDocument(collectionName, "docs/foo.md", "foo", newHash, now, now);
    }).not.toThrow();

    const rows = store.db.prepare(`
      SELECT id, hash, active FROM documents
      WHERE collection = ? AND path = ?
    `).all(collectionName, "docs/foo.md") as { id: number; hash: string; active: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(1);
    expect(rows[0]!.hash).toBe(newHash);

    await cleanupTestDb(store);
  });
});
