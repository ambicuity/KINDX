/**
 * specs/status-command.test.ts
 *
 * Unit tests for engine/commands/status-command.ts - Status command implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { openDatabase } from "../engine/runtime.js";
import { createStore } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";
import type { Database } from "../engine/runtime.js";
import type { CollectionConfig } from "../engine/catalogs.js";

describe("status-command", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-status-test-"));
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

  describe("runStatusCommand", () => {
    test("runs without error for empty database", async () => {
      const { runStatusCommand } = await import("../engine/commands/status-command.js");
      
      const deps = {
        getDb: () => store.db,
        getDbPath: () => join(testDir, "test.sqlite"),
        closeDb: () => {},
        getKindxCacheDir: () => testConfigDir,
      };

      await expect(runStatusCommand(deps)).resolves.toBeUndefined();
    });

    test("runs without error with JSON format", async () => {
      const { runStatusCommand } = await import("../engine/commands/status-command.js");
      
      const deps = {
        getDb: () => store.db,
        getDbPath: () => join(testDir, "test.sqlite"),
        closeDb: () => {},
        getKindxCacheDir: () => testConfigDir,
      };

      await expect(runStatusCommand(deps, { format: "json" })).resolves.toBeUndefined();
    });

    test("runs without error with documents indexed", async () => {
      const { runStatusCommand } = await import("../engine/commands/status-command.js");
      
      const now = new Date().toISOString();
      const hash = "test-hash-1";
      store.db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, "# Test Document\n\nThis is a test document.", now);
      store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run("test", "test/doc.md", "Test Document", hash, now, now);

      const deps = {
        getDb: () => store.db,
        getDbPath: () => join(testDir, "test.sqlite"),
        closeDb: () => {},
        getKindxCacheDir: () => testConfigDir,
      };

      await expect(runStatusCommand(deps)).resolves.toBeUndefined();
    });
  });
});
