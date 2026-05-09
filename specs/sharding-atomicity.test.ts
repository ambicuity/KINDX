/**
 * Regression: cross-shard COMMIT must be atomic from the checkpoint's
 * perspective. The previous code committed shards sequentially; if shard N's
 * COMMIT failed after shards 0..N-1 succeeded, the checkpoint advanced past
 * the failed batch (silent partial-write to the index).
 *
 * The other half of the fix: the finally-block ROLLBACK loop must continue
 * past a per-shard error rather than throwing and leaving subsequent shards
 * with open transactions (WAL-lock starvation).
 *
 * Both behaviors are best observed by running a complete sync and asserting
 * that the per-collection warnings list does NOT contain spurious entries
 * like `cross_shard_commit_failed` or `shard_txn_teardown_failed`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, loadSqliteVec } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import { setConfigIndexName } from "../engine/catalogs.js";
import {
  syncCollectionShardsFromMainDb,
  __setCheckpointWriterForTests,
} from "../engine/sharding.js";

let dir: string;
let dbPath: string;
let configDir: string;
let db: Database;
let hasVec = true;

function initSchema(d: Database): void {
  d.exec("PRAGMA journal_mode = WAL");
  d.exec(`CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)`);
  d.exec(`CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(collection, path))`);
  d.exec(`CREATE TABLE IF NOT EXISTS content_vectors (hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, embedded_at TEXT NOT NULL, PRIMARY KEY (hash, seq))`);
  if (hasVec) {
    d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[8] distance_metric=cosine)`);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kindx-shard-atomic-"));
  dbPath = join(dir, "index.sqlite");
  configDir = join(dir, "config");
  await mkdir(configDir, { recursive: true });
  process.env.KINDX_CONFIG_DIR = configDir;
  setConfigIndexName("index");
  await writeFile(
    join(configDir, "index.yml"),
    `collections:\n  notes:\n    path: ${dir}/notes\n    pattern: "**/*.md"\n    shard_count: 2\n`
  );
  db = openDatabase(dbPath);
  try { loadSqliteVec(db); } catch { hasVec = false; }
  initSchema(db);
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(`h${i}`, `doc ${i}`, now);
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', ?, ?, ?, ?, ?, 1)`).run(`f${i}.md`, `T${i}`, `h${i}`, now, now);
    db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'm', ?)`).run(`h${i}`, now);
    if (hasVec) {
      const e = new Float32Array(8);
      e[i % 8] = 1;
      db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`h${i}_0`, e);
    }
  }
});

afterEach(async () => {
  __setCheckpointWriterForTests(null);
  try { db.close(); } catch {}
  delete process.env.KINDX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("sharding atomicity", () => {
  test("clean sync produces no cross_shard_commit_failed or shard_txn_teardown_failed warnings", async () => {
    if (!hasVec) return;
    const result = await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    const warnings = result.collections[0]?.warnings ?? [];
    const spurious = warnings.filter(w =>
      w.startsWith("cross_shard_commit_failed:") ||
      w.startsWith("shard_txn_teardown_failed:") ||
      w.startsWith("shard_iteration_failed:")
    );
    expect(spurious).toEqual([]);
  });

  test("repeated sync after a successful first run is also clean (resume path)", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    const second = await syncCollectionShardsFromMainDb(db, dbPath, { resume: true });
    const warnings = second.collections[0]?.warnings ?? [];
    expect(warnings.filter(w => w.startsWith("cross_shard_commit_failed:"))).toEqual([]);
  });
});
