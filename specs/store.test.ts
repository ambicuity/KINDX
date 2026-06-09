/**
 * store.test.ts - Caching, Path Context, and Collection tests
 *
 * Run with: bun test store.test.ts
 *
 * Other store tests have been split into focused files:
 * - store-path-utils.test.ts
 * - store-handelize.test.ts
 * - store-creation.test.ts
 * - store-document-helpers.test.ts
 * - store-chunking.test.ts
 * - store-chunking-boundaries.test.ts
 * - store-fts-search.test.ts
 * - store-retrieval.test.ts
 * - store-snippets.test.ts
 * - store-rrf.test.ts
 * - store-status.test.ts
 * - store-integration.test.ts
 * - store-virtual-paths.test.ts
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
  getCacheKey,
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

  // Set up test config directory
  const configPrefix = join(testDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  testConfigDir = await mkdtemp(configPrefix);

  // Set environment variable to use test config
  process.env.KINDX_CONFIG_DIR = testConfigDir;

  // Create empty YAML config
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

  // Clean up test config directory
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

  // Clear environment variable
  delete process.env.KINDX_CONFIG_DIR;
}

// Helper to insert a test document directly into the database
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

  // Use displayPath if provided, otherwise filepath's basename, otherwise default
  let path: string;
  if (opts.displayPath) {
    path = opts.displayPath;
  } else if (opts.filepath) {
    // Extract relative path from filepath by removing collection path
    // For tests, assume filepath is either relative or we want the whole path as the document path
    path = opts.filepath.startsWith('/') ? opts.filepath : opts.filepath;
  } else {
    path = `test/${name}.md`;
  }

  const body = opts.body || "# Test Document\n\nThis is test content.";
  const active = opts.active ?? 1;

  // Generate hash from body if not provided
  const hash = opts.hash || await hashContent(body);

  // Insert content (with OR IGNORE for deduplication)
  db.prepare(`
    INSERT OR IGNORE INTO content (hash, doc, created_at)
    VALUES (?, ?, ?)
  `).run(hash, body, now);

  // Insert document
  const result = db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(collectionName, path, title, hash, now, now, active);

  return Number(result.lastInsertRowid);
}

// Helper to create a test collection in YAML config
async function createTestCollection(
  options: { pwd?: string; glob?: string; name?: string } = {}
): Promise<string> {
  const pwd = options.pwd || "/test/collection";
  const glob = options.glob || "**/*.md";
  const name = options.name || pwd.split('/').filter(Boolean).pop() || 'test';

  // Read current config
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  // Add collection
  config.collections[name] = {
    path: pwd,
    pattern: glob,
  };

  // Write back
  await writeFile(configPath, YAML.stringify(config));
  return name;
}

// Helper to add path context in YAML config
async function addPathContext(collectionName: string, pathPrefix: string, contextText: string): Promise<void> {
  // Read current config
  const configPath = join(testConfigDir, "index.yml");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  // Add context to collection
  if (!config.collections[collectionName]) {
    throw new Error(`Collection ${collectionName} not found`);
  }

  if (!config.collections[collectionName].context) {
    config.collections[collectionName].context = {};
  }

  config.collections[collectionName].context![pathPrefix] = contextText;

  // Write back
  await writeFile(configPath, YAML.stringify(config));
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "kindx-test-"));
});

afterAll(async () => {
  // Ensure native resources are released to avoid ggml-metal asserts on process exit.
  await disposeDefaultLLM();

  try {
    // Clean up test directory
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
// Caching Tests
// =============================================================================

describe("Caching", () => {
  test("getCacheKey generates consistent keys", () => {
    const key1 = getCacheKey("http://example.com", { query: "test" });
    const key2 = getCacheKey("http://example.com", { query: "test" });
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("getCacheKey generates different keys for different inputs", () => {
    const key1 = getCacheKey("http://example.com", { query: "test1" });
    const key2 = getCacheKey("http://example.com", { query: "test2" });
    expect(key1).not.toBe(key2);
  });

  test("store cache operations work correctly", async () => {
    const store = await createTestStore();

    const key = "test-cache-key";
    const value = "cached result";

    // Initially empty
    expect(store.getCachedResult(key)).toBeNull();

    // Set cache
    store.setCachedResult(key, value);

    // Retrieve cache
    expect(store.getCachedResult(key)).toBe(value);

    // Clear cache
    store.clearCache();
    expect(store.getCachedResult(key)).toBeNull();

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Context Tests
// =============================================================================

describe("Path Context", () => {
  test("getContextForFile returns null when no context set", async () => {
    const store = await createTestStore();
    const context = store.getContextForFile("/some/random/path.md");
    expect(context).toBeNull();
    await cleanupTestDb(store);
  });

  test("getContextForFile returns matching context", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/collection", glob: "**/*.md" });
    await addPathContext(collectionName, "/docs", "Documentation files");

    // Insert a document so getContextForFile can find it
    await insertTestDocument(store.db, collectionName, {
      name: "readme",
      displayPath: "docs/readme.md",
    });

    const context = store.getContextForFile("/test/collection/docs/readme.md");
    expect(context).toBe("Documentation files");

    await cleanupTestDb(store);
  });

  test("getContextForFile returns all matching contexts", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/test/collection", glob: "**/*.md" });
    await addPathContext(collectionName, "/", "General test files");
    await addPathContext(collectionName, "/docs", "Documentation files");
    await addPathContext(collectionName, "/docs/api", "API documentation");

    // Insert documents so getContextForFile can find them
    await insertTestDocument(store.db, collectionName, {
      name: "readme",
      displayPath: "readme.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "guide",
      displayPath: "docs/guide.md",
    });
    await insertTestDocument(store.db, collectionName, {
      name: "reference",
      displayPath: "docs/api/reference.md",
    });

    // Context now returns ALL matching contexts joined with \n\n
    expect(store.getContextForFile("/test/collection/readme.md")).toBe("General test files");
    expect(store.getContextForFile("/test/collection/docs/guide.md")).toBe("General test files\n\nDocumentation files");
    expect(store.getContextForFile("/test/collection/docs/api/reference.md")).toBe("General test files\n\nDocumentation files\n\nAPI documentation");

    await cleanupTestDb(store);
  });
});

// =============================================================================
// Collection Tests
// =============================================================================

describe("Collections", () => {
  test("collections are managed via YAML config", async () => {
    const store = await createTestStore();
    const collectionName = await createTestCollection({ pwd: "/home/user/projects/myapp", glob: "**/*.md" });

    // Collections are now in YAML, not in the database
    expect(collectionName).toBe("myapp");

    await cleanupTestDb(store);
  });
});
