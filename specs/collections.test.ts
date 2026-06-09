/**
 * specs/collections.test.ts
 *
 * Unit tests for engine/repository/collections.ts - Collection registry helpers.
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

describe("collections", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-collections-test-"));
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

  describe("getCollectionByName", () => {
    test("returns null for non-existent collection", async () => {
      const { getCollectionByName } = await import("../engine/repository/collections.js");
      
      const result = getCollectionByName(store.db, "nonexistent");
      expect(result).toBeNull();
    });

    test("returns collection info for existing collection", async () => {
      const { getCollectionByName } = await import("../engine/repository/collections.js");
      
      const config: CollectionConfig = {
        collections: {
          test: { path: "/test", pattern: "**/*.md" },
        },
      };
      await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(config));
      
      const result = getCollectionByName(store.db, "test");
      expect(result).toBeDefined();
      expect(result?.name).toBe("test");
    });
  });

  describe("listCollections", () => {
    test("returns empty array when no collections configured", async () => {
      const { listCollections } = await import("../engine/repository/collections.js");
      
      const result = listCollections(store.db);
      expect(result).toEqual([]);
    });

    test("returns collections with doc counts", async () => {
      const { listCollections } = await import("../engine/repository/collections.js");
      
      const config: CollectionConfig = {
        collections: {
          test: { path: "/test", pattern: "**/*.md" },
        },
      };
      await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(config));
      
      const result = listCollections(store.db);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test");
    });
  });

  describe("removeCollection", () => {
    test("returns 0 deleted docs for non-existent collection", async () => {
      const { removeCollection } = await import("../engine/repository/collections.js");
      
      const result = removeCollection(store.db, "nonexistent");
      expect(result.deletedDocs).toBe(0);
    });
  });
});
