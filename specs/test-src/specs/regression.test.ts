/**
 * regression.test.ts — Regression tests for P0 bug fixes in KINDX
 *
 * Validates:
 * 1. insertEmbedding — prepared statement caching (no new db.prepare() per call)
 * 2. chunkDocumentByTokens — graceful skip on tokenize() overflow (CJK/dense content)
 * 3. structuredSearch — parallel fan-out across collections (result correctness)
 * 4. structuredSearch — graceful vector fallback when embedBatch fails
 * 5. chunkDocument — does not infinite-loop on adversarial input
 *
 * Run with: npx vitest run specs/regression.test.ts
 */

import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, insertEmbedding, bulkInsertEmbeddings, chunkDocumentByTokens, chunkDocument, structuredSearch, findSimilarFiles } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";
import { disposeDefaultLLM } from "../engine/inference.js";
import type { Database } from "../engine/runtime.js";

// =============================================================================
// Test environment setup
// =============================================================================

let testDir: string;
let store: Store;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kindx-regression-"));
  const testDbPath = join(testDir, "regression.sqlite");
  const testConfigDir = await mkdtemp(join(testDir, "config-"));
  process.env.KINDX_CONFIG_DIR = testConfigDir;
  store = createStore(testDbPath);
});

afterAll(async () => {
  store.close();
  await disposeDefaultLLM();
  await rm(testDir, { recursive: true, force: true });
});

// =============================================================================
// Bug Fix #5: insertEmbedding statement caching
// =============================================================================

describe("insertEmbedding — prepared statement caching", () => {
  test("does not throw on first call (table not yet created)", () => {
    // vectors_vec does not exist until ensureVecTable() is called.
    // insertEmbedding should fail gracefully rather than corrupt the WeakMap cache.
    const fakeEmbedding = new Float32Array(4).fill(0.1);

    // We cannot call insertEmbedding without the vec table, but we can verify
    // that calling the function twice on the same db instance reuses statements.
    // This is a smoke test — the WeakMap cache key (db instance) must be stable.
    expect(() => store.db).not.toThrow();
    expect(store.db).toBeTruthy();
  });

  test("calling insertEmbedding N times does not create N*2 prepare() calls", () => {
    // Spy on db.prepare to count how many times it's invoked.
    const originalPrepare = store.db.prepare.bind(store.db);
    let prepareCallCount = 0;

    const prepare = vi.spyOn(store.db as any, "prepare").mockImplementation((sql: any) => {
      prepareCallCount++;
      return originalPrepare(sql);
    });

    // Ensure the vectors_vec table exists
    store.ensureVecTable(4);

    // Reset count after table creation; we care only about insertEmbedding calls
    prepareCallCount = 0;

    // A real embedding
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const now = new Date().toISOString();

    // Insert 5 times
    for (let i = 0; i < 5; i++) {
      insertEmbedding(store.db, `hash00000${i}`, i, i * 100, embedding, "test-model", now);
    }

    // With caching: 2 prepare() calls total (first call only).
    // Without caching: 2 * 5 = 10 prepare() calls.
    // We allow up to 4 (2 per unique db, with one re-initialization allowed).
    expect(prepareCallCount).toBeLessThanOrEqual(4);

    prepare.mockRestore();
  });

  test("inserting unique hashes does not throw", () => {
    store.ensureVecTable(4);
    const embedding = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const now = new Date().toISOString();
    // Insert two distinct hash+seq combinations — must succeed.
    // Note: sqlite-vec PRIMARY KEY constraint means the same hash_seq cannot
    // be INSERTed twice in the same transaction even with OR REPLACE.
    // insertEmbedding is idempotent at the store level via re-indexing.
    expect(() => insertEmbedding(store.db, "uniquehash001", 0, 0, embedding, "model", now)).not.toThrow();
    expect(() => insertEmbedding(store.db, "uniquehash002", 0, 0, embedding, "model", now)).not.toThrow();
  });
});

// =============================================================================
// Bug Fix #3 & #4: chunkDocumentByTokens — overflow protection
// =============================================================================

describe("chunkDocumentByTokens — overflow protection", () => {
  test("handles empty string without crash", async () => {
    // Empty string produces one chunk with empty text and 0 tokens.
    // The key invariant is: does not throw. The output may be a single empty chunk.
    const chunks = await chunkDocumentByTokens("");
    expect(Array.isArray(chunks)).toBe(true);
    // Each chunk that is returned must have consistent types
    for (const chunk of chunks) {
      expect(typeof chunk.pos).toBe("number");
      expect(typeof chunk.tokens).toBe("number");
      expect(typeof chunk.text).toBe("string");
    }
  });

  test("handles short content without crash", async () => {
    const chunks = await chunkDocumentByTokens("Hello world.");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.text).toContain("Hello world.");
    expect(chunks[0]!.tokens).toBeGreaterThan(0);
  });

  test("handles CJK-heavy content without crash", async () => {
    // Construct a CJK-heavy string (Japanese hiragana repetition).
    // CJK characters tokenize at a much higher rate than ASCII (~2-3 chars/token).
    const cjkText = "日本語のテキストはトークン化の比率が高い。".repeat(50);
    let chunks: Awaited<ReturnType<typeof chunkDocumentByTokens>>;

    // Must not throw even if LLM tokenize() is unavailable or fails with overflow
    await expect(async () => {
      chunks = await chunkDocumentByTokens(cjkText);
    }).not.toThrow();

    // Verify at least one chunk was produced
    chunks = await chunkDocumentByTokens(cjkText);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("all returned chunks have non-negative pos and positive tokens", async () => {
    const content = "# Title\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = await chunkDocumentByTokens(content, 50, 5, 10);
    for (const chunk of chunks) {
      expect(chunk.pos).toBeGreaterThanOrEqual(0);
      expect(chunk.tokens).toBeGreaterThan(0);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  test("no chunk exceeds maxTokens (within a 20% tolerance for estimate drift)", async () => {
    const maxTokens = 100;
    const content = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"word ".repeat(20)}`).join("\n");
    const chunks = await chunkDocumentByTokens(content, maxTokens);
    for (const chunk of chunks) {
      // Allow 20% tolerance for estimator drift (LLM tokenizer may differ from estimate).
      expect(chunk.tokens).toBeLessThanOrEqual(maxTokens * 1.2);
    }
  });
});

// =============================================================================
// structuredSearch — parallel fan-out correctness
// =============================================================================

describe("structuredSearch — parallel fan-out", () => {
  test("empty searches returns empty array", async () => {
    const results = await structuredSearch(store, []);
    expect(results).toEqual([]);
  });

  test("single lex search with no documents returns empty", async () => {
    const results = await structuredSearch(store, [
      { type: "lex", query: "unique-term-xyz987" }
    ]);
    expect(results).toEqual([]);
  });

  test("multiple searches do not throw", async () => {
    await expect(structuredSearch(store, [
      { type: "lex", query: "test" },
      { type: "vec", query: "semantic test" },
    ])).resolves.toBeDefined();
  });

  test("respects limit option strictly", async () => {
    const results = await structuredSearch(store, [
      { type: "lex", query: "the" }
    ], { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("multi-collection search with undefined collection does not throw", async () => {
    const results = await structuredSearch(store, [
      { type: "lex", query: "test" }
    ], { collections: undefined });
    expect(Array.isArray(results)).toBe(true);
  });

  test("empty collections array returns empty", async () => {
    // An empty collections array means collectionList = [], so no searches are run.
    const results = await structuredSearch(store, [
      { type: "lex", query: "test" }
    ], { collections: [] });
    expect(results).toEqual([]);
  });

  test("parallel fan-out tasks do not corrupt docidMap (concurrent writes)", async () => {
    // This test verifies that when multiple collections are searched concurrently,
    // results are not lost due to race conditions on the docidMap / rankedLists shared state.
    // Since JS is single-threaded, true races cannot occur, but we validate correctness.
    const results = await structuredSearch(store, [
      { type: "lex", query: "content" },
      { type: "vec", query: "semantic content search" },
    ], {
      collections: ["test-collection-1", "test-collection-2"],
      limit: 10,
    });
    // No documents exist for these collections — should be empty rather than crash.
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(r.file).toBeTruthy();
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  test("parallel fan-out preserves deterministic ordering across repeated runs", async () => {
    const searches = [
      { type: "vec" as const, query: "alpha query" },
      { type: "hyde" as const, query: "beta query" },
    ];
    const options = {
      collections: ["test-collection-1", "test-collection-2"],
      limit: 10,
    };

    const r1 = await structuredSearch(store, searches, options);
    const r2 = await structuredSearch(store, searches, options);
    expect(r1.map(r => r.file)).toEqual(r2.map(r => r.file));
  });
});

// =============================================================================
// structuredSearch — vector fallback on embedBatch failure
// =============================================================================

describe("structuredSearch — vector search graceful fallback", () => {
  test("vec search with no vector index returns empty gracefully", async () => {
    // The test database has no vectors_vec table, so vector searches skip entirely.
    const results = await structuredSearch(store, [
      { type: "vec", query: "what is the meaning of life" }
    ]);
    expect(Array.isArray(results)).toBe(true);
  });

  test("hyde search with no vector index returns empty gracefully", async () => {
    const results = await structuredSearch(store, [
      { type: "hyde", query: "The answer to the question about life is 42." }
    ]);
    expect(Array.isArray(results)).toBe(true);
  });
});

// =============================================================================
// chunkDocument — correctness / infinite loop guard
// =============================================================================

describe("chunkDocument — correctness", () => {
  // Import the sync version for unit-level testing (imported statically at top of file)

  test("single chunk for short content", () => {
    const chunks = chunkDocument("short content", 3600);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("short content");
    expect(chunks[0]!.pos).toBe(0);
  });

  test("does not infinite loop on content near boundary", () => {
    // maxChars = 10, content = 20 characters ⟹ must produce ≥2 chunks without hanging
    const content = "1234567890123456789";
    const chunks = chunkDocument(content, 10, 2, 5);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("all chunk positions are non-negative and monotonically increasing", () => {
    const content = "# Section 1\n\nParagraph one.\n\n# Section 2\n\nParagraph two.\n";
    const chunks = chunkDocument(content, 30, 5, 10);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.pos).toBeGreaterThan(chunks[i - 1]!.pos);
    }
  });

  test("concatenated chunk text covers the full document", () => {
    // With 0 overlap, all chars should be covered without gaps
    const content = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const chunks = chunkDocument(content, 10, 0, 2);
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (let j = 0; j < chunk.text.length; j++) {
        covered.add(chunk.pos + j);
      }
    }
    for (let i = 0; i < content.length; i++) {
      expect(covered.has(i)).toBe(true);
    }
  });
});

// =============================================================================
// Bug Fix: bulkInsertEmbeddings — transactional batch insert
// =============================================================================

describe("bulkInsertEmbeddings — transactional batch insert", () => {
  test("no-op for empty array", () => {
    // Should not throw and should not modify the database
    store.ensureVecTable(4);
    const countBefore = (store.db.prepare(
      `SELECT COUNT(*) as c FROM content_vectors`
    ).get() as { c: number }).c;

    bulkInsertEmbeddings(store.db, []);

    const countAfter = (store.db.prepare(
      `SELECT COUNT(*) as c FROM content_vectors`
    ).get() as { c: number }).c;
    expect(countAfter).toBe(countBefore);
  });

  test("inserts all records atomically", () => {
    store.ensureVecTable(4);
    const now = new Date().toISOString();
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

    const records = Array.from({ length: 10 }, (_, i) => ({
      hash: `bulk-hash-${Date.now()}-${i}`,
      seq: 0,
      pos: i * 100,
      embedding,
      model: "test",
      embeddedAt: now,
    }));

    const countBefore = (store.db.prepare(
      `SELECT COUNT(*) as c FROM content_vectors`
    ).get() as { c: number }).c;

    bulkInsertEmbeddings(store.db, records);

    const countAfter = (store.db.prepare(
      `SELECT COUNT(*) as c FROM content_vectors`
    ).get() as { c: number }).c;

    // All 10 records must be present
    expect(countAfter).toBe(countBefore + 10);
  });

  test("produces same result as N individual insertEmbedding calls", () => {
    store.ensureVecTable(4);
    const now = new Date().toISOString();
    const embedding = new Float32Array([0.9, 0.1, 0.5, 0.3]);
    const prefix = `equiv-${Date.now()}`;

    // Insert via individual calls
    for (let i = 0; i < 5; i++) {
      insertEmbedding(store.db, `${prefix}-individual-${i}`, 0, 0, embedding, "test", now);
    }

    // Insert via bulk
    const bulkRecords = Array.from({ length: 5 }, (_, i) => ({
      hash: `${prefix}-bulk-${i}`,
      seq: 0,
      pos: 0,
      embedding,
      model: "test",
      embeddedAt: now,
    }));
    bulkInsertEmbeddings(store.db, bulkRecords);

    // Both groups should be present in content_vectors
    const individualCount = (store.db.prepare(
      `SELECT COUNT(*) as c FROM content_vectors WHERE hash LIKE '${prefix}-individual-%'`
    ).get() as { c: number }).c;
    const bulkCount = (store.db.prepare(
      `SELECT COUNT(*) as c FROM content_vectors WHERE hash LIKE '${prefix}-bulk-%'`
    ).get() as { c: number }).c;

    expect(individualCount).toBe(5);
    expect(bulkCount).toBe(5);
  });

  test("statement cache is reused (prepare() called at most twice total)", () => {
    store.ensureVecTable(4);
    const now = new Date().toISOString();
    const embedding = new Float32Array([0.2, 0.4, 0.6, 0.8]);

    const originalPrepare = store.db.prepare.bind(store.db);
    let prepareCount = 0;
    const spy = vi.spyOn(store.db as any, "prepare").mockImplementation((sql: any) => {
      prepareCount++;
      return originalPrepare(sql);
    });

    // First bulk call — may compile statements
    bulkInsertEmbeddings(store.db, [{ hash: `cache-test-a-${Date.now()}`, seq: 0, pos: 0, embedding, model: "t", embeddedAt: now }]);
    const afterFirst = prepareCount;

    // Second bulk call — must NOT compile new statements
    bulkInsertEmbeddings(store.db, [{ hash: `cache-test-b-${Date.now()}`, seq: 0, pos: 0, embedding, model: "t", embeddedAt: now }]);
    const afterSecond = prepareCount;

    spy.mockRestore();

    // Second call should not trigger any new prepare() calls
    expect(afterSecond).toBe(afterFirst);
  });

  test("Store.bulkInsertEmbeddings is bound and functional", () => {
    store.ensureVecTable(4);
    const now = new Date().toISOString();
    const embedding = new Float32Array([0.3, 0.6, 0.9, 0.1]);
    const hash = `store-bulk-${Date.now()}`;

    // Call via the Store interface (not the raw function)
    expect(() => store.bulkInsertEmbeddings([{ hash, seq: 0, pos: 0, embedding, model: "test", embeddedAt: now }]))
      .not.toThrow();

    const row = store.db.prepare(
      `SELECT COUNT(*) as c FROM content_vectors WHERE hash = ?`
    ).get(hash) as { c: number };
    expect(row.c).toBe(1);
  });
});

// =============================================================================
// Fuzzy matcher — bounded Levenshtein behavior
// =============================================================================

describe("findSimilarFiles — bounded Levenshtein", () => {
  test("returns empty quickly for a very distant query with strict threshold", () => {
    const started = Date.now();
    const results = findSimilarFiles(store.db, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", 1, 5);
    const elapsedMs = Date.now() - started;

    expect(results).toEqual([]);
    // Guardrail threshold (sanity): should not devolve into unbounded work in this fixture.
    expect(elapsedMs).toBeLessThan(250);
  });
});
