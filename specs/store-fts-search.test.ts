/**
 * store-fts-search.test.ts - Full-text search tests
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
  STRONG_SIGNAL_MIN_SCORE,
  STRONG_SIGNAL_MIN_GAP,
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
  testDir = await mkdtemp(join(tmpdir(), "kindx-test-fts-"));
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
// FTS Search Tests
// =============================================================================

describe("FTS Search", () => {
  test("searchFTS returns empty array for no matches", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "The quick brown fox jumps over the lazy dog",
    });

    const results = store.searchFTS("nonexistent-term-xyz", 10);
    expect(results).toHaveLength(0);

    await cleanupTestDb(store);
  });

  test("searchFTS finds documents by keyword", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      title: "Fox Document",
      body: "The quick brown fox jumps over the lazy dog",
      displayPath: "test/doc1.md",
    });

    const results = store.searchFTS("fox", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/doc1.md`);
    expect(results[0]!.filepath).toBe(`kindx://${collectionName}/test/doc1.md`);
    expect(results[0]!.source).toBe("fts");

    await cleanupTestDb(store);
  });

  test("searchFTS ranks title matches higher", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    // Document with "fox" in body only
    await insertTestDocument(store.db, collectionName, {
      name: "body-match",
      title: "Some Other Title",
      body: "The fox is here in the body",
      displayPath: "test/body.md",
    });

    // Document with "fox" in title (via name field which is indexed)
    await insertTestDocument(store.db, collectionName, {
      name: "fox",
      title: "Fox Title",
      body: "Different content without the animal fox",
      displayPath: "test/title.md",
    });

    const results = store.searchFTS("fox", 10);
    // Both documents contain "fox" in the body now, so we should get 2 results
    expect(results.length).toBe(2);
    // Title/name match should rank higher due to BM25 weights
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/title.md`);

    await cleanupTestDb(store);
  });

  test("searchFTS respects limit parameter", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    // Insert 10 documents
    for (let i = 0; i < 10; i++) {
      await insertTestDocument(store.db, collectionName, {
        name: `doc${i}`,
        body: "common keyword appears here",
        displayPath: `test/doc${i}.md`,
      });
    }

    const results = store.searchFTS("common keyword", 3);
    expect(results).toHaveLength(3);

    await cleanupTestDb(store);
  });

  test("searchFTS filters by collection name", async () => {
    const store = await createTestStore();
    const collection1 = await createTestCollection({ pwd: "/path/one", glob: "**/*.md", name: "one" });
    const collection2 = await createTestCollection({ pwd: "/path/two", glob: "**/*.md", name: "two" });

    await insertTestDocument(store.db, collection1, {
      name: "doc1",
      body: "searchable content",
      displayPath: "doc1.md",
    });

    await insertTestDocument(store.db, collection2, {
      name: "doc2",
      body: "searchable content",
      displayPath: "doc2.md",
    });

    const allResults = store.searchFTS("searchable", 10);
    expect(allResults).toHaveLength(2);

    // Filter by collection name
    const filtered = store.searchFTS("searchable", 10, collection1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.displayPath).toBe(`${collection1}/doc1.md`);

    await cleanupTestDb(store);
  });

  test("searchFTS handles special characters in query", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await insertTestDocument(store.db, collectionName, {
      name: "doc1",
      body: "Function with params: foo(bar, baz)",
      displayPath: "test/doc1.md",
    });

    // Should not throw on special characters
    const results = store.searchFTS("foo(bar)", 10);
    // Results may vary based on FTS5 handling
    expect(Array.isArray(results)).toBe(true);

    await cleanupTestDb(store);
  });

  // BM25 IDF requires corpus depth — helper adds non-matching docs so term frequency
  // differentiation produces meaningful scores (2-doc corpus has near-zero IDF).
  async function addNoiseDocuments(db: Database, collectionName: string, count = 8) {
    for (let i = 0; i < count; i++) {
      await insertTestDocument(db, collectionName, {
        name: `noise${i}`,
        title: `Unrelated Topic ${i}`,
        body: `This document discusses completely different subjects like gardening and cooking ${i}`,
        displayPath: `test/noise${i}.md`,
      });
    }
  }

  test("searchFTS scores: stronger BM25 match → higher normalized score", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await addNoiseDocuments(store.db, collectionName);

    // "alpha" appears in title (10x weight) + body → strong BM25
    await insertTestDocument(store.db, collectionName, {
      name: "strong",
      title: "Alpha Guide",
      body: "This is the definitive alpha reference with alpha details and more alpha info",
      displayPath: "test/strong.md",
    });

    // "alpha" appears once in body only → weaker BM25
    await insertTestDocument(store.db, collectionName, {
      name: "weak",
      title: "General Notes",
      body: "Some notes that mention alpha in passing among other topics and keywords",
      displayPath: "test/weak.md",
    });

    const results = store.searchFTS("alpha", 10);
    expect(results.length).toBe(2);

    // Verify score direction: stronger match (title + body) should score HIGHER
    const strongResult = results.find(r => r.displayPath.includes("strong"))!;
    const weakResult = results.find(r => r.displayPath.includes("weak"))!;
    expect(strongResult.score).toBeGreaterThan(weakResult.score);

    // Verify scores are in valid (0, 1) range
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }

    await cleanupTestDb(store);
  });

  test("searchFTS scores: minScore filter keeps strong matches, drops weak", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();
    await addNoiseDocuments(store.db, collectionName);

    // Strong match: keyword in title (10x weight) + repeated in body
    await insertTestDocument(store.db, collectionName, {
      name: "strong",
      title: "Kubernetes Deployment",
      body: "Kubernetes deployment strategies for kubernetes clusters using kubernetes operators",
      displayPath: "test/strong.md",
    });

    // Weak match: keyword appears once in body only
    await insertTestDocument(store.db, collectionName, {
      name: "weak",
      title: "Random Notes",
      body: "Various topics including a brief kubernetes mention among many other unrelated things",
      displayPath: "test/weak.md",
    });

    const allResults = store.searchFTS("kubernetes", 10);
    expect(allResults.length).toBe(2);

    // With a minScore threshold, strong match should survive, weak should be filterable
    const strongScore = allResults.find(r => r.displayPath.includes("strong"))!.score;
    const weakScore = allResults.find(r => r.displayPath.includes("weak"))!.score;

    // Find a threshold between them
    const threshold = (strongScore + weakScore) / 2;
    const filtered = allResults.filter(r => r.score >= threshold);

    // Strong match survives the filter, weak does not
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.displayPath).toContain("strong");

    await cleanupTestDb(store);
  });

  test("searchFTS ignores inactive documents", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    await insertTestDocument(store.db, collectionName, {
      name: "active",
      body: "findme content",
      displayPath: "test/active.md",
      active: 1,
    });

    await insertTestDocument(store.db, collectionName, {
      name: "inactive",
      body: "findme content",
      displayPath: "test/inactive.md",
      active: 0,
    });

    const results = store.searchFTS("findme", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.displayPath).toBe(`${collectionName}/test/active.md`);
    expect(results[0]!.filepath).toBe(`kindx://${collectionName}/test/active.md`);

    await cleanupTestDb(store);
  });

  test("searchFTS scores: strong signal detection works with correct normalization", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection();

    // BM25 IDF needs meaningful corpus depth for strong signal to fire.
    // 50 noise docs give IDF ≈ log(50/2) ≈ 3.2 — enough for scores above 0.85.
    await addNoiseDocuments(store.db, collectionName, 50);

    // Dominant: keyword in filepath (10x BM25 weight column) + title + body
    await insertTestDocument(store.db, collectionName, {
      name: "dominant",
      title: "Zephyr Configuration Guide",
      body: "Complete zephyr configuration guide. Zephyr setup instructions for zephyr deployment.",
      displayPath: "zephyr/zephyr-guide.md",
    });

    // Weak: keyword once in body only, longer doc dilutes TF
    await insertTestDocument(store.db, collectionName, {
      name: "weak",
      title: "General Notes",
      body: "Various topics covering many areas of technology and design. " +
        "One of them might relate to zephyr but mostly about other things entirely. " +
        "Additional content about databases, networking, security, performance, " +
        "monitoring, deployment, testing, and documentation practices.",
      displayPath: "notes/misc.md",
    });

    const results = store.searchFTS("zephyr", 10);
    expect(results.length).toBe(2);

    const topScore = results[0]!.score;
    const secondScore = results[1]!.score;

    // With correct normalization: strong match should be well above threshold
    expect(topScore).toBeGreaterThanOrEqual(STRONG_SIGNAL_MIN_SCORE);

    // Gap should exceed threshold when there's a dominant match
    const gap = topScore - secondScore;
    expect(gap).toBeGreaterThanOrEqual(STRONG_SIGNAL_MIN_GAP);

    // Full strong signal check should pass (this was dead code before the fix)
    const hasStrongSignal = topScore >= STRONG_SIGNAL_MIN_SCORE && gap >= STRONG_SIGNAL_MIN_GAP;
    expect(hasStrongSignal).toBe(true);

    await cleanupTestDb(store);
  });
});
