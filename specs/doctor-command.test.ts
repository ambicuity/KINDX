/**
 * specs/doctor-command.test.ts
 *
 * Unit tests for engine/commands/doctor-command.ts - Doctor command implementation.
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

describe("doctor-command", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-doctor-test-"));
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

  describe("runDoctorCommand", () => {
    test("runs without error for empty database", async () => {
      const { runDoctorCommand } = await import("../engine/commands/doctor-command.js");
      
      const deps = {
        getDb: () => store.db,
        getDbPath: () => join(testDir, "test.sqlite"),
        closeDb: () => {},
      };

      const result = runDoctorCommand(deps, "cli");
      expect(typeof result).toBe("number");
    });

    test("returns exit code for database", async () => {
      const { runDoctorCommand } = await import("../engine/commands/doctor-command.js");
      
      const deps = {
        getDb: () => store.db,
        getDbPath: () => join(testDir, "test.sqlite"),
        closeDb: () => {},
      };

      const result = runDoctorCommand(deps, "cli");
      expect(typeof result).toBe("number");
    });

    test("runs without error with JSON output", async () => {
      const { runDoctorCommand } = await import("../engine/commands/doctor-command.js");
      
      const deps = {
        getDb: () => store.db,
        getDbPath: () => join(testDir, "test.sqlite"),
        closeDb: () => {},
      };

      const result = runDoctorCommand(deps, "json");
      expect(typeof result).toBe("number");
    });

    test("runs without error with custom sample size", async () => {
      const { runDoctorCommand } = await import("../engine/commands/doctor-command.js");
      
      const deps = {
        getDb: () => store.db,
        getDbPath: () => join(testDir, "test.sqlite"),
        closeDb: () => {},
      };

      const result = runDoctorCommand(deps, "cli", 32);
      expect(typeof result).toBe("number");
    });
  });
});
