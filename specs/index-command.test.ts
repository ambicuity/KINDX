/**
 * specs/index-command.test.ts
 *
 * Unit tests for engine/commands/index-command.ts - Index command implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import type { CollectionConfig } from "../engine/catalogs.js";

describe("index-command", () => {
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-index-test-"));
    testConfigDir = join(testDir, "config");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(testConfigDir, { recursive: true });
    
    process.env.KINDX_CONFIG_DIR = testConfigDir;
    const emptyConfig: CollectionConfig = { collections: {} };
    await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(emptyConfig));
  });

  afterEach(async () => {
    delete process.env.KINDX_CONFIG_DIR;
    await rm(testDir, { recursive: true, force: true });
  });

  describe("runIndexCommand", () => {
    test("returns 0 for list subcommand with no indexes", async () => {
      const { runIndexCommand } = await import("../engine/commands/index-command.js");
      
      const result = await runIndexCommand(["list"], {});
      expect(result).toBe(0);
    });

    test("returns 1 for create subcommand without name", async () => {
      const { runIndexCommand } = await import("../engine/commands/index-command.js");
      
      const result = await runIndexCommand(["create"], {});
      expect(result).toBe(1);
    });

    test("returns 1 for delete subcommand without name", async () => {
      const { runIndexCommand } = await import("../engine/commands/index-command.js");
      
      const result = await runIndexCommand(["delete"], {});
      expect(result).toBe(1);
    });

    test("returns 1 for unknown subcommand", async () => {
      const { runIndexCommand } = await import("../engine/commands/index-command.js");
      
      const result = await runIndexCommand(["unknown"], {});
      expect(result).toBe(1);
    });
  });
});
