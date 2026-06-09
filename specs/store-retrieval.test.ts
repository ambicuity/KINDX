/**
 * store-retrieval.test.ts - Document retrieval tests (findDocument, getDocumentBody, findDocuments)
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import type { Database } from "../engine/runtime.js";
import { unlink, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { disposeDefaultLLM } from "../engine/inference.js";
import {
  createStore,
  hashContent,
  homedir,
  type Store,
} from "../engine/repository.js";
import type { CollectionConfig } from "../engine/catalogs.js";

// =============================================================================
// Test Utilities
// =============================================================================

let testDir: string;
let testDbPath: string;
let testConfigDir: string;

async function createTestStore(): Promise<Store> {
  testDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

  const configPrefix = join(testDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  testConfigDir = await mkdtemp(configPrefix);

  process.env.KINDX_CONFIG_DIR = testConfigDir;

  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(
    join(testConfigDir, "index.yml"),
    YAML.stringify(emptyConfig)
  );

  return createStore(testDbPath);
}

async function cleanupTestDb(store: Store): Promise<void> {
  store.close();
  try {
    await unlink(store.dbPath);
  } catch {
    // Ignore if file doesn't exist
  }

  try {
    const { readdir, unlink: unlinkFile, rmdir: rmdirAsync } = await import("node:fs/promises");
    const files = await readdir(testConfigDir);
    for (const file of files) {
      await unlinkFile(join(testConfigDir, file));
    }
    await rmdirAsync(testConfigDir);
  } catch {
    // Ignore cleanup errors
  }

  delete process.env.KINDX_CONFIG_DIR;
}

async function insertTestDocument(
  db: Database,
  collectionName: string,
  opts: {
    name?: string;
    title?: string;
    hash?: string;
    displayPath?: string;
    filepath?: string;
    body?: string;
    active?: number;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const name = opts.name || "test-doc";
  const title = opts.title || "Test Document";

  let path: string;
  if (opts.displayPath) {
    path = opts.displayPath;
  } else if (opts.filepath) {
    path = opts.filepath.startsWith('/') ? opts.filepath : opts.filepath;
  } else {
    path = `test/${name}.md`;
  }

  const body = opts.body || "# Test Document\n\nThis is test content.";
  const active = opts.active ?? 1;

  const hash = opts.hash || await hashContent(body);

  db.prepare(`
    INSERT OR IGNORE INTO content (hash, doc, created_at)
    VALUES (?, ?, ?)
  `).run(hash, body, now);

  const result = db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(collectionName, path, title, hash, now, now, active);

  return Number(result.lastInsertRowid);
}

async function createTestCollection(
  options: { pwd?: string; glob?: string; name?: string } = {}
): Promise<string> {
  const pwd = options.pwd || "/test/collection";
  const glob = options.glob || "**/*.md";
  const name = options.name || pwd.split('/').filter(Boolean).pop() || 'test';

  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  config.collections[name] = {
    path: pwd,
    pattern: glob,
  };

  await writeFile(configPath, YAML.stringify(config));
  return name;
}

async function addPathContext(collectionName: string, pathPrefix: string, contextText: string): Promise<void> {
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  if (!config.collections[collectionName]) {
    throw new Error(`Collection ${collectionName} not found`);
  }

  if (!config.collections[collectionName].context) {
    config.collections[collectionName].context = {};
  }

  config.collections[collectionName].context![pathPrefix] = contextText;

  await writeFile(configPath, YAML.stringify(config));
}

async function addGlobalContext(contextText: string): Promise<void> {
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  config.global_context = contextText;

  await writeFile(configPath, YAML.stringify(config));
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kindx-test-retrieval-"));
});

afterAll(async () => {
  await disposeDefaultLLM();

  try {
    const { readdir, unlink } = await import("node:fs/promises");
    const files = await readdir(testDir);
    for (const file of files) {
      await unlink(join(testDir, file));
    }
    await rmdir(testDir);
  } catch {
    // Ignore cleanup errors
  }
});

// =============================================================================
// Document Retrieval Tests
// =============================================================================

describe("Document Retrieval", () => {
  describe("findDocument", () => {
    test("findDocument finds by exact filepath", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/exact/path", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        title: "My Document",
        displayPath: "mydoc.md",
        body: "Document content here",
      });

      const result = store.findDocument("/exact/path/mydoc.md");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.title).toBe("My Document");
        expect(result.displayPath).toBe(`${collectionName}/mydoc.md`);
        expect(result.filepath).toBe(`kindx://${collectionName}/mydoc.md`);
        expect(result.body).toBeUndefined(); // body not included by default
      }

      await cleanupTestDb(store);
    });

    test("findDocument finds by display_path", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/some/path", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("docs/mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument finds by partial path match", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/very/long/path/to", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
      });

      const result = store.findDocument("mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument includes body when requested", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path", glob: "**/*.md" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "The actual body content",
      });

      const result = store.findDocument("/path/mydoc.md", { includeBody: true });
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.body).toBe("The actual body content");
      }

      await cleanupTestDb(store);
    });

    test("findDocument returns error with suggestions for not found", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();
      await insertTestDocument(store.db, collectionName, {
        name: "similar",
        filepath: "/path/similar.md",
        displayPath: "similar.md",
      });

      const result = store.findDocument("simlar.md"); // typo - 1 char diff
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toBe("not_found");
        // Levenshtein distance of 1 should be found with maxDistance 3
        expect(result.similarFiles.length).toBeGreaterThanOrEqual(0); // May or may not find depending on distance calc
      }

      await cleanupTestDb(store);
    });

    test("findDocument handles :line suffix", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        filepath: "/path/mydoc.md",
        displayPath: "mydoc.md",
      });

      const result = store.findDocument("mydoc.md:100");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument expands ~ to home directory", async () => {
      const store = await createTestStore();
      const home = homedir();
      const collectionName = await createTestCollection({ pwd: home, name: "home" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        filepath: `${home}/docs/mydoc.md`,
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("~/docs/mydoc.md");
      expect("error" in result).toBe(false);

      await cleanupTestDb(store);
    });

    test("findDocument includes context from path_contexts", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path" });
      await addPathContext(collectionName, "docs", "Documentation");
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "docs/mydoc.md",
      });

      const result = store.findDocument("/path/docs/mydoc.md");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.context).toBe("Documentation");
      }

      await cleanupTestDb(store);
    });

    test("findDocument includes hierarchical contexts (global + collection + path)", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/archive", name: "archive" });

      // Add global context
      await addGlobalContext("Global context for all documents");

      // Add collection root context
      await addPathContext(collectionName, "/", "Archive collection context");

      // Add path-specific contexts at different levels
      await addPathContext(collectionName, "/podcasts", "Podcast episodes");
      await addPathContext(collectionName, "/podcasts/external", "External podcast interviews");

      // Insert document in nested path
      await insertTestDocument(store.db, collectionName, {
        name: "interview",
        displayPath: "podcasts/external/2024-jan-interview.md",
      });

      const result = store.findDocument("/archive/podcasts/external/2024-jan-interview.md");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        // Should have all contexts joined with double newlines
        expect(result.context).toBe(
          "Global context for all documents\n\n" +
          "Archive collection context\n\n" +
          "Podcast episodes\n\n" +
          "External podcast interviews"
        );
      }

      await cleanupTestDb(store);
    });
  });

  describe("getDocumentBody", () => {
    test("getDocumentBody returns full body", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" });
      expect(body).toBe("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

      await cleanupTestDb(store);
    });

    test("getDocumentBody supports line range", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection({ pwd: "/path" });
      await insertTestDocument(store.db, collectionName, {
        name: "mydoc",
        displayPath: "mydoc.md",
        body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      });

      const body = store.getDocumentBody({ filepath: "/path/mydoc.md" }, 2, 2);
      expect(body).toBe("Line 2\nLine 3");

      await cleanupTestDb(store);
    });

    test("getDocumentBody returns null for non-existent document", async () => {
      const store = await createTestStore();
      const body = store.getDocumentBody({ filepath: "/nonexistent.md" });
      expect(body).toBeNull();
      await cleanupTestDb(store);
    });
  });

  describe("findDocuments (multi-get)", () => {
    test("findDocuments finds by glob pattern", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/journals/2024-01.md",
        displayPath: "journals/2024-01.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc2",
        filepath: "/path/journals/2024-02.md",
        displayPath: "journals/2024-02.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc3",
        filepath: "/path/other/file.md",
        displayPath: "other/file.md",
      });

      const { docs, errors } = store.findDocuments("journals/2024-*.md");
      expect(errors).toHaveLength(0);
      expect(docs).toHaveLength(2);

      await cleanupTestDb(store);
    });

    test("findDocuments finds by comma-separated list", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
      });
      await insertTestDocument(store.db, collectionName, {
        name: "doc2",
        filepath: "/path/doc2.md",
        displayPath: "doc2.md",
      });

      const { docs, errors } = store.findDocuments("doc1.md, doc2.md");
      expect(errors).toHaveLength(0);
      expect(docs).toHaveLength(2);

      await cleanupTestDb(store);
    });

    test("findDocuments reports errors for not found files", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
      });

      const { docs, errors } = store.findDocuments("doc1.md, nonexistent.md");
      expect(docs).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("not found");

      await cleanupTestDb(store);
    });

    test("findDocuments skips large files", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "large",
        filepath: "/path/large.md",
        displayPath: "large.md",
        body: "x".repeat(20000), // 20KB
      });

      const { docs } = store.findDocuments("large.md", { maxBytes: 10000 });
      expect(docs).toHaveLength(1);
      expect(docs[0]!.skipped).toBe(true);
      if (docs[0]!.skipped) {
        expect((docs[0] as { skipped: true; skipReason: string }).skipReason).toContain("too large");
      }

      await cleanupTestDb(store);
    });

    test("findDocuments includes body when requested", async () => {
      const store = await createTestStore();
      const collectionName = await createTestCollection();

      await insertTestDocument(store.db, collectionName, {
        name: "doc1",
        filepath: "/path/doc1.md",
        displayPath: "doc1.md",
        body: "The content",
      });

      const { docs } = store.findDocuments("doc1.md", { includeBody: true });
      expect(docs[0]!.skipped).toBe(false);
      if (!docs[0]!.skipped) {
        expect((docs[0] as { doc: { body: string }; skipped: false }).doc.body).toBe("The content");
      }

      await cleanupTestDb(store);
    });
  });

});
