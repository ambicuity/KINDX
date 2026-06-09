/**
 * specs/hybrid.test.ts
 *
 * Unit tests for engine/repository/retrieval/hybrid.ts - Hybrid search orchestrator.
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
import {
  detectContentType,
  extractSchemaFromBody,
} from "../engine/repository/retrieval/hybrid.js";

describe("hybrid", () => {
  let store: Store;
  let testDir: string;
  let testConfigDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-hybrid-test-"));
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

  describe("detectContentType", () => {
    test("detects text content", () => {
      expect(detectContentType("Hello world", "file.txt")).toBe("text");
      expect(detectContentType("# Markdown", "README.md")).toBe("text");
    });

    test("detects image content by extension", () => {
      expect(detectContentType("", "image.png")).toBe("image");
      expect(detectContentType("", "photo.jpg")).toBe("image");
      expect(detectContentType("", "picture.jpeg")).toBe("image");
      expect(detectContentType("", "animation.gif")).toBe("image");
      expect(detectContentType("", "image.webp")).toBe("image");
    });

    test("detects CSV content by extension", () => {
      expect(detectContentType("", "data.csv")).toBe("csv");
    });

    test("detects JSON content by extension", () => {
      expect(detectContentType("", "config.json")).toBe("json");
    });

    test("detects CSV content by body pattern", () => {
      const body = "Schema: name,age\nRows 100\nJohn,30";
      expect(detectContentType(body, "data.txt")).toBe("csv");
    });

    test("detects JSON content by body pattern", () => {
      const body = 'Schema: name:string,age:number\nItems 100\n{"name":"John"}';
      expect(detectContentType(body, "data.txt")).toBe("json");
    });

    test("defaults to text for unknown extensions", () => {
      expect(detectContentType("content", "file.xyz")).toBe("text");
    });
  });

  describe("extractSchemaFromBody", () => {
    test("extracts schema from body", () => {
      const body = "Schema: name:string,age:number\nSome data here";
      const schema = extractSchemaFromBody(body);
      expect(schema).toEqual({ name: "string", age: "number" });
    });

    test("returns undefined when no schema", () => {
      const body = "Just some text without schema";
      expect(extractSchemaFromBody(body)).toBeUndefined();
    });

    test("handles empty schema", () => {
      const body = "Schema: \nSome data";
      expect(extractSchemaFromBody(body)).toBeUndefined();
    });

    test("handles malformed schema", () => {
      const body = "Schema: invalid-format\nSome data";
      expect(extractSchemaFromBody(body)).toBeUndefined();
    });
  });

  describe("hybridQuery", () => {
    test("returns empty results when no documents indexed", async () => {
      const { hybridQuery } = await import("../engine/repository/retrieval/hybrid.js");
      
      const results = await hybridQuery(store, "test query");
      expect(results).toEqual([]);
    });

    test("accepts options parameter", async () => {
      const { hybridQuery } = await import("../engine/repository/retrieval/hybrid.js");
      
      const results = await hybridQuery(store, "test query", {
        limit: 5,
        minScore: 0.5,
        collection: "test",
      });
      expect(results).toEqual([]);
    });

    test("accepts hooks parameter", async () => {
      const { hybridQuery } = await import("../engine/repository/retrieval/hybrid.js");
      
      let expandStartCalled = false;
      let expandDoneCalled = false;
      const results = await hybridQuery(store, "test query", {
        hooks: {
          onExpandStart: () => { expandStartCalled = true; },
          onExpand: () => { expandDoneCalled = true; },
        },
      });
      expect(results).toEqual([]);
      expect(expandStartCalled).toBe(true);
      expect(expandDoneCalled).toBe(true);
    });

    test("accepts explain parameter", async () => {
      const { hybridQuery } = await import("../engine/repository/retrieval/hybrid.js");
      
      const results = await hybridQuery(store, "test query", {
        explain: true,
      });
      expect(results).toEqual([]);
    });

    test("returns results when documents are indexed", async () => {
      const { hybridQuery } = await import("../engine/repository/retrieval/hybrid.js");
      
      const now = new Date().toISOString();
      const hash = "test-hash-1";
      store.db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, "# Test Document\n\nThis is a test document about authentication.", now);
      store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run("test", "test/doc.md", "Test Document", hash, now, now);

      const results = await hybridQuery(store, "authentication", {
        limit: 5,
        minScore: 0,
      });
      expect(results.length).toBeGreaterThan(0);
    });

    test("respects limit parameter", async () => {
      const { hybridQuery } = await import("../engine/repository/retrieval/hybrid.js");
      
      const now = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        const hash = `test-hash-${i}`;
        store.db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, `# Document ${i}\n\nContent about topic ${i}.`, now);
        store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run("test", `test/doc${i}.md`, `Document ${i}`, hash, now, now);
      }

      const results = await hybridQuery(store, "topic", {
        limit: 2,
        minScore: 0,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });
});
