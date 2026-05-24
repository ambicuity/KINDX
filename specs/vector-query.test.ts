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
  });
});
