/**
 * specs/backup-command.test.ts
 *
 * Unit tests for engine/commands/backup-command.ts - Backup command implementation.
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

describe("backup-command", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-backup-test-"));
    dbPath = join(testDir, "test.sqlite");
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

  describe("runBackupCommand", () => {
    test("returns 1 for verify without path", async () => {
      const { runBackupCommand } = await import("../engine/commands/backup-command.js");
      
      const result = runBackupCommand(["verify"], {}, "cli", dbPath);
      expect(result).toBe(1);
    });

    test("returns 1 for restore without path", async () => {
      const { runBackupCommand } = await import("../engine/commands/backup-command.js");
      
      const result = runBackupCommand(["restore"], {}, "cli", dbPath);
      expect(result).toBe(1);
    });

    test("returns 0 for help subcommand", async () => {
      const { runBackupCommand } = await import("../engine/commands/backup-command.js");
      
      const result = runBackupCommand(["help"], {}, "cli", dbPath);
      expect(result).toBe(0);
    });

    test("returns 0 for create subcommand", async () => {
      const { runBackupCommand } = await import("../engine/commands/backup-command.js");
      
      const backupPath = join(testDir, "backup.sqlite");
      const result = runBackupCommand(["create"], { path: backupPath }, "cli", dbPath);
      expect(result).toBe(0);
    });

    test("returns 1 for unknown subcommand", async () => {
      const { runBackupCommand } = await import("../engine/commands/backup-command.js");
      
      const result = runBackupCommand(["unknown"], {}, "cli", dbPath);
      expect(result).toBe(1);
    });
  });
});
