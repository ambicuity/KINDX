/**
 * specs/protocol.test.ts
 *
 * Unit tests for engine/protocol.ts - MCP protocol implementation.
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

describe("protocol", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-protocol-test-"));
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

  describe("listRegisteredToolsForTest", () => {
    test("returns array of tools", async () => {
      const { listRegisteredToolsForTest } = await import("../engine/protocol.js");
      
      const tools = listRegisteredToolsForTest();
      expect(Array.isArray(tools)).toBe(true);
    });

    test("tools have required properties", async () => {
      const { listRegisteredToolsForTest } = await import("../engine/protocol.js");
      
      const tools = listRegisteredToolsForTest();
      for (const tool of tools) {
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
      }
    });

    test("includes query tool", async () => {
      const { listRegisteredToolsForTest } = await import("../engine/protocol.js");
      
      const tools = listRegisteredToolsForTest();
      const queryTool = tools.find(t => t.name === "query");
      expect(queryTool).toBeDefined();
    });

    test("includes get tool", async () => {
      const { listRegisteredToolsForTest } = await import("../engine/protocol.js");
      
      const tools = listRegisteredToolsForTest();
      const getTool = tools.find(t => t.name === "get");
      expect(getTool).toBeDefined();
    });

    test("includes multi_get tool", async () => {
      const { listRegisteredToolsForTest } = await import("../engine/protocol.js");
      
      const tools = listRegisteredToolsForTest();
      const multiGetTool = tools.find(t => t.name === "multi_get");
      expect(multiGetTool).toBeDefined();
    });
  });
});
