/**
 * specs/context-annotations.test.ts
 *
 * Unit tests for engine/repository/context-annotations.ts - Context annotation helpers.
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

describe("context-annotations", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-context-test-"));
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

  describe("getContextForPath", () => {
    test("returns null for non-existent collection", async () => {
      const { getContextForPath } = await import("../engine/repository/context-annotations.js");
      
      const result = getContextForPath(store.db, "nonexistent", "test/path");
      expect(result).toBeNull();
    });

    test("returns null when no context configured", async () => {
      const { getContextForPath } = await import("../engine/repository/context-annotations.js");
      
      const config: CollectionConfig = {
        collections: {
          test: { path: "/test", pattern: "**/*.md" },
        },
      };
      await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(config));
      
      const result = getContextForPath(store.db, "test", "test/path");
      expect(result).toBeNull();
    });
  });

  describe("deleteContext", () => {
    test("returns 0 for non-existent collection", async () => {
      const { deleteContext } = await import("../engine/repository/context-annotations.js");
      
      const result = deleteContext(store.db, "nonexistent", "test/path");
      expect(result).toBe(0);
    });
  });

  describe("deleteGlobalContexts", () => {
    test("returns count of deleted contexts", async () => {
      const { deleteGlobalContexts } = await import("../engine/repository/context-annotations.js");
      
      const result = deleteGlobalContexts(store.db);
      expect(typeof result).toBe("number");
    });
  });

  describe("insertContext", () => {
    test("throws for non-existent collection", async () => {
      const { insertContext } = await import("../engine/repository/context-annotations.js");
      
      expect(() => insertContext(store.db, 999, "/path", "context")).toThrow();
    });
  });
});
