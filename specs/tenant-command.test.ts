/**
 * specs/tenant-command.test.ts
 *
 * Unit tests for engine/commands/tenant-command.ts - Tenant command implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import type { CollectionConfig } from "../engine/catalogs.js";

describe("tenant-command", () => {
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-tenant-test-"));
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

  describe("runTenantCommand", () => {
    test("returns 1 for add subcommand without id", async () => {
      const { runTenantCommand } = await import("../engine/commands/tenant-command.js");
      
      const result = runTenantCommand(["add"], {}, "text");
      expect(result).toBe(1);
    });

    test("returns 1 for remove subcommand without id", async () => {
      const { runTenantCommand } = await import("../engine/commands/tenant-command.js");
      
      const result = runTenantCommand(["remove"], {}, "text");
      expect(result).toBe(1);
    });

    test("returns 0 for list subcommand", async () => {
      const { runTenantCommand } = await import("../engine/commands/tenant-command.js");
      
      const result = runTenantCommand(["list"], {}, "text");
      expect(result).toBe(0);
    });

    test("returns 1 for unknown subcommand", async () => {
      const { runTenantCommand } = await import("../engine/commands/tenant-command.js");
      
      const result = runTenantCommand(["unknown"], {}, "text");
      expect(result).toBe(1);
    });

    test("returns 1 for add with invalid role", async () => {
      const { runTenantCommand } = await import("../engine/commands/tenant-command.js");
      
      const result = runTenantCommand(["add", "test-id"], { role: "invalid" }, "text");
      expect(result).toBe(1);
    });

    test("returns 0 for add with valid role", async () => {
      const { runTenantCommand } = await import("../engine/commands/tenant-command.js");
      
      const result = runTenantCommand(["add", "test-tenant"], { role: "viewer" }, "text");
      expect(result).toBe(0);
    });

    test("returns 0 for add with admin role", async () => {
      const { runTenantCommand } = await import("../engine/commands/tenant-command.js");
      
      const result = runTenantCommand(["add", "admin-tenant"], { role: "admin" }, "text");
      expect(result).toBe(0);
    });
  });
});
