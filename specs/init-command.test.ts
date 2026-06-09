/**
 * specs/init-command.test.ts
 *
 * Unit tests for engine/commands/init-command.ts - Init command implementation.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import type { CollectionConfig } from "../engine/catalogs.js";

describe("init-command", () => {
  let testDir: string;
  let testConfigDir: string;
  let originalCI: string | undefined;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-init-test-"));
    testConfigDir = join(testDir, "config");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(testConfigDir, { recursive: true });
    
    process.env.KINDX_CONFIG_DIR = testConfigDir;
    const emptyConfig: CollectionConfig = { collections: {} };
    await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(emptyConfig));
    
    originalCI = process.env.CI;
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(async () => {
    delete process.env.KINDX_CONFIG_DIR;
    if (originalCI !== undefined) {
      process.env.CI = originalCI;
    } else {
      delete process.env.CI;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  describe("runInitCommand", () => {
    test("exits with code 2 in CI without --yes", async () => {
      const { runInitCommand } = await import("../engine/commands/init-command.js");
      
      process.env.CI = "true";
      
      const deps = {
        updateCollections: async () => {},
        vectorIndex: async () => {},
        defaultGlob: "**/*.md",
        defaultEmbedModel: "test-model",
      };

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await runInitCommand([], {}, deps);

      expect(mockExit).toHaveBeenCalledWith(2);
      mockExit.mockRestore();
      mockStderr.mockRestore();
    });

    test("exits with code 2 without TTY and without --yes", async () => {
      const { runInitCommand } = await import("../engine/commands/init-command.js");
      
      process.env.CI = "false";
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      
      const deps = {
        updateCollections: async () => {},
        vectorIndex: async () => {},
        defaultGlob: "**/*.md",
        defaultEmbedModel: "test-model",
      };

      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await runInitCommand([], {}, deps);

      expect(mockExit).toHaveBeenCalledWith(2);
      mockExit.mockRestore();
      mockStderr.mockRestore();
    });

    test("proceeds with --yes flag in CI", async () => {
      const { runInitCommand } = await import("../engine/commands/init-command.js");
      
      process.env.CI = "true";
      
      let updateCalled = false;
      let vectorCalled = false;
      const deps = {
        updateCollections: async () => { updateCalled = true; },
        vectorIndex: async () => { vectorCalled = true; },
        defaultGlob: "**/*.md",
        defaultEmbedModel: "test-model",
      };

      await runInitCommand([], { yes: true }, deps);

      expect(updateCalled).toBe(true);
      expect(vectorCalled).toBe(true);
    });
  });
});
