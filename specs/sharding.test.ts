import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, loadSqliteVec } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import { setConfigIndexName } from "../engine/catalogs.js";
import {
  __setCheckpointWriterForTests,
  getSchedulerCheckpointState,
  getShardCheckpointPath,
  getShardHealthSummary,
  syncCollectionShardsFromMainDb,
  searchShardedVectors,
  searchShardedVectorsWithDiagnostics,
  getSchedulerQueueState,
  getShardRuntimeStatus,
  getAnnRuntimeStatus,
} from "../engine/sharding.js";

let dir: string;
let dbPath: string;
let configDir: string;
let db: Database;
let hasVec = true;

function initSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(collection, path)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);
  if (hasVec) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[8] distance_metric=cosine)`);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kindx-shards-"));
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
  try {
    loadSqliteVec(db);
  } catch {
    hasVec = false;
  }
  initSchema(db);

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run("h1", "doc one", now);
  db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run("h2", "doc two", now);
  db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', 'a.md', 'A', 'h1', ?, ?, 1)`).run(now, now);
  db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', 'b.md', 'B', 'h2', ?, ?, 1)`).run(now, now);
  db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES ('h1', 0, 0, 'embeddinggemma', ?)`).run(now);
  db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES ('h2', 0, 0, 'embeddinggemma', ?)`).run(now);

  if (hasVec) {
    const e1 = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const e2 = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]);
    db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run("h1_0", e1);
    db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run("h2_0", e2);
  }
});

afterEach(async () => {
  __setCheckpointWriterForTests(null);
  try { db.close(); } catch {}
  delete process.env.KINDX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("sharding sync", () => {
  test("syncs vectors into collection shards and exposes runtime status", async () => {
    if (!hasVec) return;
    const result = await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    expect(result.collections.length).toBe(1);
    expect(result.collections[0]?.collection).toBe("notes");
    expect(result.collections[0]?.processed).toBeGreaterThan(0);

    const status = getShardRuntimeStatus(dbPath);
    expect(status.enabledCollections.length).toBe(1);
    expect(status.enabledCollections[0]?.shardCount).toBe(2);
    expect(existsSync(status.checkpointPath)).toBe(true);
  });

  test("searchShardedVectors returns nearest hash_seq results", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    const q = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const hits = searchShardedVectors(dbPath, "notes", 2, q, 4);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.hash_seq).toBe("h1_0");
  });

  test("sync builds ANN artifacts and ANN search path remains deterministic", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    const q = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]);
    const diagnostic = searchShardedVectorsWithDiagnostics(dbPath, "notes", 2, q, 4);
    expect(diagnostic.matches.length).toBeGreaterThan(0);
    expect(diagnostic.matches.map((m) => m.hash_seq)).toContain("h2_0");
    expect(diagnostic.warnings.some((w) => w.startsWith("ann_missing:"))).toBe(false);
  });

  test("ANN runtime degrades safely when ANN artifacts are missing and exact fallback still returns matches", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    for (let i = 0; i < 2; i++) {
      const shard = openDatabase(join(dir, "shards", "notes", `shard-${i}.sqlite`));
      try {
        loadSqliteVec(shard);
        shard.exec("DROP TABLE IF EXISTS ann_centroids_vec");
        shard.exec("DELETE FROM ann_state");
      } finally {
        shard.close();
      }
    }

    const runtime = getAnnRuntimeStatus(dbPath);
    expect(runtime.mode).toBe("exact");
    expect(runtime.state).toBe("missing");
    expect(runtime.details.some((d) => d.reason === "ann_artifacts_missing")).toBe(true);

    const q = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const diagnostic = searchShardedVectorsWithDiagnostics(dbPath, "notes", 2, q, 4);
    expect(diagnostic.matches.length).toBeGreaterThan(0);
    expect(diagnostic.matches.map((m) => m.hash_seq)).toContain("h1_0");
    expect(diagnostic.warnings.some((w) => w.startsWith("ann_missing:notes:"))).toBe(true);
  });

  test("topology drift resets resume checkpoint with explicit warning", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    await writeFile(
      join(configDir, "index.yml"),
      `collections:\n  notes:\n    path: ${dir}/notes\n    pattern: "**/*.md"\n    shard_count: 3\n`
    );
    const result = await syncCollectionShardsFromMainDb(db, dbPath, { resume: true });
    expect(result.warnings.some((w) => w.includes("topology_drift:notes:2->3"))).toBe(true);
    expect(result.collections[0]?.shardCount).toBe(3);
  });

  test("invalid checkpoint is recovered with deterministic warning metadata", async () => {
    const checkpointPath = getShardCheckpointPath(dbPath);
    await mkdir(join(dir, "shards"), { recursive: true });
    writeFileSync(checkpointPath, "{invalid json", "utf-8");
    const scheduler = getSchedulerCheckpointState(dbPath);
    expect(scheduler.checkpointExists).toBe(true);
    expect(scheduler.valid).toBe(false);
    expect(scheduler.warnings).toContain("checkpoint_parse_error");
  });

  test("unknown checkpoint version is recovered with compatibility warning", async () => {
    const checkpointPath = getShardCheckpointPath(dbPath);
    await mkdir(join(dir, "shards"), { recursive: true });
    writeFileSync(
      checkpointPath,
      JSON.stringify({ version: 99, collections: {}, updatedAt: new Date().toISOString() }),
      "utf-8"
    );
    const scheduler = getSchedulerCheckpointState(dbPath);
    expect(scheduler.checkpointExists).toBe(true);
    expect(scheduler.valid).toBe(false);
    expect(scheduler.warnings).toContain("checkpoint_version_mismatch");
    expect(scheduler.warnings.some((w) => w.startsWith("checkpoint_version_newer:"))).toBe(true);
    expect(scheduler.warnings).toContain("checkpoint_reset_applied");
  });

  test("shard search diagnostics report missing shard paths", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    const q = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const diagnostic = searchShardedVectorsWithDiagnostics(dbPath, "notes", 4, q, 2);
    expect(diagnostic.warnings.some((w) => w.startsWith("shard_read_missing:notes:"))).toBe(true);
    expect(Array.isArray(diagnostic.matches)).toBe(true);
  });

  test("scheduler queue state exposes deterministic typed fields", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    const queue = getSchedulerQueueState(db, dbPath);
    expect(queue.length).toBe(1);
    const item = queue[0]!;
    expect(typeof item.collection).toBe("string");
    expect(typeof item.total).toBe("number");
    expect(typeof item.processed).toBe("number");
    expect(typeof item.pending).toBe("number");
    expect(typeof item.active).toBe("number");
    expect(typeof item.workers).toBe("number");
    expect(typeof item.batchSize).toBe("number");
  });

  test("shard health summary classifies families deterministically", async () => {
    if (!hasVec) return;
    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    const summary = getShardHealthSummary(db, dbPath, 4);
    expect(summary).toHaveProperty("status");
    expect(summary).toHaveProperty("families");
    expect(summary.families).toHaveProperty("topology");
    expect(summary.families).toHaveProperty("checkpoint");
    expect(summary.families).toHaveProperty("read");
    expect(summary.families).toHaveProperty("write");
    expect(summary.families).toHaveProperty("parity");
    expect(Array.isArray(summary.warnings)).toBe(true);
  });

  test("torn write playback recovers sequence", async () => {
    if (!hasVec) return;

    // Insert a batch of documents so we transcend the immediate modulo bounds
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run("h3", "doc three", now);
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', 'c.md', 'C', 'h3', ?, ?, 1)`).run(now, now);
    db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES ('h3', 0, 0, 'embeddinggemma', ?)`).run(now);

    // Override batch size to force frequent checkpoint writes and fail exactly once.
    await writeFile(
      join(configDir, "index.yml"),
      `collections:\n  notes:\n    path: ${dir}/notes\n    pattern: "**/*.md"\n    shard_count: 2\n    embedding_batch_size: 1\n`
    );
    let failedOnce = false;
    __setCheckpointWriterForTests((path, data, encoding) => {
      if (!failedOnce && path.includes("scheduler-checkpoint")) {
        failedOnce = true;
        throw new Error("Simulated hard crash exit during checkpoint flush");
      }
      writeFileSync(path, data, encoding);
    });

    await syncCollectionShardsFromMainDb(db, dbPath, { resume: false });
    expect(failedOnce).toBe(true);

    __setCheckpointWriterForTests(null);

    // Resume should reconstruct checkpoint + shard parity without torn state.
    const resumed = await syncCollectionShardsFromMainDb(db, dbPath, { resume: true });
    const checkpoint = getSchedulerCheckpointState(dbPath);
    expect(checkpoint.warnings).not.toContain("checkpoint_parse_error");
    expect(Array.isArray(resumed.warnings)).toBe(true);
    const health = getShardHealthSummary(db, dbPath, 3);
    expect(health.families.parity.count).toBeGreaterThan(0);
  });
});
