/**
 * Regression: Chroma migration must:
 *   - throw on bad input (not call process.exit) so library consumers
 *     can catch and report
 *   - be idempotent: re-running after a partial run should skip already-
 *     migrated rows rather than aborting on UNIQUE-constraint violations
 *   - return a structured report so callers can introspect the result
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChromaMigrationError, migrateChroma, type ChromaMigrationReport } from "../engine/migrate.js";
import { createStore } from "../engine/repository.js";

let dir: string;
let chromaPath: string;
let kindxPath: string;
let configDir: string;
const origCwd = process.cwd();
const origConfigDir = process.env.KINDX_CONFIG_DIR;

function makeChromaFixture(rows: number): void {
  const db = new Database(chromaPath);
  db.exec(`
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE embeddings (rowid INTEGER PRIMARY KEY, id TEXT, collection_id TEXT, embedding_id TEXT);
    CREATE TABLE embedding_metadata (id TEXT, key TEXT, string_value TEXT, int_value INTEGER, float_value REAL);
    CREATE TABLE embedding_fulltext (rowid INTEGER PRIMARY KEY, string_value TEXT);
  `);
  db.prepare(`INSERT INTO collections (id, name) VALUES (?, ?)`).run("c1", "src");
  for (let i = 0; i < rows; i++) {
    db.prepare(`INSERT INTO embeddings (rowid, id, collection_id, embedding_id) VALUES (?, ?, ?, ?)`)
      .run(i + 1, `emb-${i}`, "c1", `doc-${i}.txt`);
    db.prepare(`INSERT INTO embedding_fulltext (rowid, string_value) VALUES (?, ?)`)
      .run(i + 1, `Body of document ${i}`);
  }
  db.close();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kindx-mig-"));
  chromaPath = join(dir, "chroma.sqlite3");
  kindxPath = join(dir, "kindx.sqlite");
  configDir = join(dir, "config");
  process.env.KINDX_CONFIG_DIR = configDir;
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origConfigDir !== undefined) process.env.KINDX_CONFIG_DIR = origConfigDir;
  else delete process.env.KINDX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("migrateChroma", () => {
  test("throws ChromaMigrationError on missing source (no process.exit)", async () => {
    await expect(
      migrateChroma("/no/such/file.sqlite", "imp", createStore(kindxPath))
    ).rejects.toBeInstanceOf(ChromaMigrationError);
  });

  test("throws ChromaMigrationError on a non-Chroma source schema", async () => {
    const wrong = join(dir, "wrong.sqlite");
    const db = new Database(wrong);
    db.exec(`CREATE TABLE only_this (id INTEGER)`);
    db.close();
    await expect(
      migrateChroma(wrong, "imp", createStore(kindxPath))
    ).rejects.toBeInstanceOf(ChromaMigrationError);
  });

  test("returns a structured report on success", async () => {
    makeChromaFixture(3);
    const store = createStore(kindxPath);
    const report: ChromaMigrationReport = await migrateChroma(chromaPath, "imp", store);
    expect(report.scanned).toBe(3);
    expect(report.migrated).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.errors).toBe(0);
    store.close?.();
  });

  test("idempotent: re-running skips already-migrated rows instead of erroring", async () => {
    makeChromaFixture(3);

    const store1 = createStore(kindxPath);
    const first = await migrateChroma(chromaPath, "imp", store1);
    expect(first.migrated).toBe(3);
    store1.close?.();

    const store2 = createStore(kindxPath);
    const second = await migrateChroma(chromaPath, "imp", store2);
    expect(second.scanned).toBe(3);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.errors).toBe(0);
    store2.close?.();
  });
});
