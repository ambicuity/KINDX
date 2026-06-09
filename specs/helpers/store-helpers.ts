/**
 * specs/helpers/store-helpers.ts
 *
 * Shared store test utilities extracted from specs/store.test.ts.
 */

import { mkdtemp, rmdir, unlink, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createStore, hashContent } from "../../engine/repository.js";
import type { Store } from "../../engine/repository.js";
import type { Database } from "../../engine/runtime.js";
import type { CollectionConfig } from "../../engine/catalogs.js";

export interface TestStoreContext {
  testDir: string;
  testDbPath: string;
  testConfigDir: string;
}

export async function createTestStoreContext(): Promise<TestStoreContext> {
  const testDir = await mkdtemp(join(tmpdir(), "kindx-test-"));
  const testDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const configPrefix = join(testDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const testConfigDir = await mkdtemp(configPrefix);

  process.env.KINDX_CONFIG_DIR = testConfigDir;

  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(emptyConfig));

  return { testDir, testDbPath, testConfigDir };
}

export async function createTestStore(ctx: TestStoreContext): Promise<Store> {
  return createStore(ctx.testDbPath);
}

export async function cleanupTestDb(store: Store, ctx: TestStoreContext): Promise<void> {
  store.close();
  try {
    await unlink(store.dbPath);
  } catch {
    // Ignore if file doesn't exist
  }

  // Clean up test config directory
  try {
    const files = await readdir(ctx.testConfigDir);
    for (const file of files) {
      await unlink(join(ctx.testConfigDir, file));
    }
    await rmdir(ctx.testConfigDir);
  } catch {
    // Ignore cleanup errors
  }

  // Clear environment variable
  delete process.env.KINDX_CONFIG_DIR;
}

export async function cleanupTestContext(ctx: TestStoreContext): Promise<void> {
  try {
    const files = await readdir(ctx.testDir);
    for (const file of files) {
      await unlink(join(ctx.testDir, file));
    }
    await rmdir(ctx.testDir);
  } catch {
    // Ignore cleanup errors
  }
}

export async function insertTestDocument(
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

export async function createTestCollection(
  ctx: TestStoreContext,
  options: { pwd?: string; glob?: string; name?: string } = {}
): Promise<string> {
  const pwd = options.pwd || "/test/collection";
  const glob = options.glob || "**/*.md";
  const name = options.name || pwd.split('/').filter(Boolean).pop() || 'test';

  const configPath = join(ctx.testConfigDir, "index.yml");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  config.collections[name] = {
    path: pwd,
    pattern: glob,
  };

  await writeFile(configPath, YAML.stringify(config));
  return name;
}

export async function addPathContext(
  ctx: TestStoreContext,
  collectionName: string,
  pathPrefix: string,
  contextText: string
): Promise<void> {
  const configPath = join(ctx.testConfigDir, "index.yml");
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

export async function addGlobalContext(
  ctx: TestStoreContext,
  contextText: string
): Promise<void> {
  const configPath = join(ctx.testConfigDir, "index.yml");
  const content = await readFile(configPath, "utf-8");
  const config = YAML.parse(content) as CollectionConfig;

  config.global_context = contextText;
  await writeFile(configPath, YAML.stringify(config));
}
