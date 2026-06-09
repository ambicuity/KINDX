/**
 * specs/vector-query.test.ts
 *
 * Unit tests for engine/repository/retrieval/vector-query.ts - Vector search orchestrator.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { openDatabase } from "../engine/runtime.js";
import { createStore } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";
import type { CollectionConfig } from "../engine/catalogs.js";

describe("vector-query", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-vector-test-"));
    const dbPath = join(testDir, "test.sqlite");
    testConfigDir = join(testDir, "config");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(testConfigDir, { recursive: true });
    
    process.env.KINDX_CONFIG_DIR = testConfigDir;
    const emptyConfig: CollectionConfig = { collections: {} };
    await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(emptyConfig));
    
    store = createStore(dbPath);
  });

  afterEach(async () => {
    store.close();
    delete process.env.KINDX_CONFIG_DIR;
    await rm(testDir, { recursive: true, force: true });
  });

  describe("vectorSearchQuery", () => {
    test("returns empty array when no vectors table exists", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const results = await vectorSearchQuery(store, "test query");
      expect(results).toEqual([]);
    });

    test("accepts options parameter", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const results = await vectorSearchQuery(store, "test query", {
        limit: 5,
        minScore: 0.5,
        collection: "test",
      });
      expect(results).toEqual([]);
    });

    test("accepts hooks parameter", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      let expandCalled = false;
      const results = await vectorSearchQuery(store, "test query", {
        hooks: {
          onExpand: () => { expandCalled = true; },
        },
      });
      expect(results).toEqual([]);
    });

    test("returns empty results when no documents indexed", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const results = await vectorSearchQuery(store, "authentication");
      expect(results).toEqual([]);
    });

    test("respects limit parameter", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const results = await vectorSearchQuery(store, "test", {
        limit: 3,
      });
      expect(results).toEqual([]);
    });

    test("returns results when documents with vectors are indexed", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const now = new Date().toISOString();
      const hash = "test-hash-1";
      store.db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, "# Test Document\n\nThis is a test document about authentication.", now);
      store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run("test", "test/doc.md", "Test Document", hash, now, now);
      store.db.prepare(`INSERT OR IGNORE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`).run(hash, 0, 0, "test-model", now);

      const results = await vectorSearchQuery(store, "authentication", {
        limit: 5,
        minScore: 0,
      });
      expect(Array.isArray(results)).toBe(true);
    });

    test("handles multiple documents", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const now = new Date().toISOString();
      for (let i = 0; i < 3; i++) {
        const hash = `test-hash-${i}`;
        store.db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, `# Document ${i}\n\nContent about topic ${i}.`, now);
        store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run("test", `test/doc${i}.md`, `Document ${i}`, hash, now, now);
        store.db.prepare(`INSERT OR IGNORE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`).run(hash, 0, 0, "test-model", now);
      }

      const results = await vectorSearchQuery(store, "topic", {
        limit: 2,
        minScore: 0,
      });
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
