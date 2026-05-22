import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

let indexManager: typeof import("../engine/index-manager.js");

describe("Index Manager", () => {
  let configDir: string;
  const origConfigDir = process.env.KINDX_CONFIG_DIR;

  beforeEach(async () => {
    configDir = join(tmpdir(), `kindx-index-mgr-${randomBytes(4).toString("hex")}`);
    mkdirSync(configDir, { recursive: true });
    process.env.KINDX_CONFIG_DIR = configDir;
    indexManager = await import("../engine/index-manager.js");
    indexManager.__resetRegistryCacheForTests();
  });

  afterEach(() => {
    indexManager.__resetRegistryCacheForTests();
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
    if (origConfigDir !== undefined) {
      process.env.KINDX_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.KINDX_CONFIG_DIR;
    }
  });

  describe("Registry CRUD", () => {
    it("loads empty registry when indexes.yml does not exist", () => {
      const registry = indexManager.loadRegistry();
      expect(registry.version).toBe(1);
      expect(registry.default).toBe("index");
      expect(registry.indexes).toEqual({});
    });

    it("registers a new index and persists to indexes.yml", () => {
      indexManager.registerIndex("my-project", "Project Alpha");

      const registry = indexManager.loadRegistry();
      expect(registry.indexes["my-project"]).toBeDefined();
      expect(registry.indexes["my-project"]!.description).toBe("Project Alpha");
      expect(registry.indexes["my-project"]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const filePath = join(configDir, "indexes.yml");
      expect(existsSync(filePath)).toBe(true);
    });

    it("rejects duplicate index names", () => {
      indexManager.registerIndex("my-project", "First");
      expect(() => indexManager.registerIndex("my-project", "Second"))
        .toThrow("Index 'my-project' already exists");
    });

    it("rejects invalid index names", () => {
      expect(() => indexManager.registerIndex("", "invalid"))
        .toThrow(/Index name must match/);
      expect(() => indexManager.registerIndex("MY-PROJECT", "uppercase"))
        .toThrow(/Index name must match/);
      expect(() => indexManager.registerIndex("a", "too short"))
        .toThrow(/Index name must match/);
    });

    it("unregisters an index", () => {
      indexManager.registerIndex("my-project", "Proj");
      indexManager.unregisterIndex("my-project");

      const registry = indexManager.loadRegistry();
      expect(registry.indexes["my-project"]).toBeUndefined();
    });

    it("rejects unregister of default index", () => {
      expect(() => indexManager.unregisterIndex("index"))
        .toThrow("Cannot delete the default index");
    });

    it("rejects unregister of non-existent index", () => {
      expect(() => indexManager.unregisterIndex("nonexistent"))
        .toThrow("Index 'nonexistent' not found");
    });

    it("lists indexes with description and created_at", () => {
      indexManager.registerIndex("alpha", "Alpha");
      indexManager.registerIndex("beta", "Beta");

      const list = indexManager.listIndexes();
      expect(list).toHaveLength(2);
      expect(list[0]!.name).toBe("alpha");
      expect(list[0]!.description).toBe("Alpha");
      expect(list[1]!.name).toBe("beta");
    });

    it("auto-registers default 'index' when ensureDefaultIndexRegistered is called", () => {
      const registry = indexManager.loadRegistry();
      indexManager.ensureDefaultIndexRegistered();
      const updated = indexManager.loadRegistry();
      expect(updated.indexes["index"]).toBeDefined();
      expect(updated.indexes["index"]!.description).toBe("Default index");
    });

    it("preserves existing default index during auto-register", () => {
      indexManager.registerIndex("index", "Custom default");
      indexManager.ensureDefaultIndexRegistered();
      const updated = indexManager.loadRegistry();
      expect(updated.indexes["index"]!.description).toBe("Custom default");
    });

    it("gets default index name from registry", () => {
      expect(indexManager.getDefaultIndexName()).toBe("index");
      const registry = indexManager.loadRegistry();
      registry.default = "custom";
      indexManager.saveRegistry(registry);
      expect(indexManager.getDefaultIndexName()).toBe("custom");
    });
  });
});
