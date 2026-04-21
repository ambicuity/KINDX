import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as MainDatabase } from "./runtime.js";
import { openDatabase, loadSqliteVec, type Database } from "./runtime.js";
import { getCollection, listCollections } from "./catalogs.js";

export type CollectionShardConfig = {
  collection: string;
  shardCount: number;
  embeddingBatchSize?: number;
  embeddingWorkers?: number;
  embedQueueLimit?: number;
};

export type ShardSyncOptions = {
  resume?: boolean;
  onProgress?: (progress: { collection: string; processed: number; total: number }) => void;
};

export type ShardSyncResult = {
  collections: Array<{
    collection: string;
    shardCount: number;
    processed: number;
    total: number;
    resumed: boolean;
    warnings: string[];
    queue: {
      total: number;
      processed: number;
      pending: number;
      capped: boolean;
      queueLimit: number | null;
      workers: number;
      batchSize: number;
    };
  }>;
  checkpointPath: string;
  warnings: string[];
};

export type AnnShardState = "ready" | "stale" | "missing" | "degraded";

export type AnnRuntimeStatus = {
  enabled: boolean;
  mode: "ann" | "exact";
  state: AnnShardState;
  probeCount: number;
  shortlistLimit: number;
  details: Array<{
    collection: string;
    shard: number;
    state: AnnShardState;
    reason: string;
  }>;
};

type ShardCheckpoint = {
  version: 1;
  collections: Record<string, { shardCount: number; completed: boolean; lastHashSeq: string | null; processed: number }>;
  updatedAt: string;
};

type CheckpointReadResult = {
  checkpoint: ShardCheckpoint;
  warnings: string[];
};

function getShardRoot(dbPath: string): string {
  return join(dirname(dbPath), "shards");
}

export function getShardCheckpointPath(dbPath: string): string {
  return join(getShardRoot(dbPath), "scheduler-checkpoint.json");
}

function normalizeCollectionDir(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function shardDbPath(dbPath: string, collection: string, shardIndex: number): string {
  return join(getShardRoot(dbPath), normalizeCollectionDir(collection), `shard-${shardIndex}.sqlite`);
}

function hashToShard(hash: string, shardCount: number): number {
  const digest = createHash("sha256").update(hash).digest();
  const value = digest.readUInt32BE(0);
  return value % shardCount;
}

function defaultCheckpoint(): ShardCheckpoint {
  return {
    version: 1,
    collections: {},
    updatedAt: new Date().toISOString(),
  };
}

function isValidCheckpointCollectionState(value: unknown): value is {
  shardCount: number;
  completed: boolean;
  lastHashSeq: string | null;
  processed: number;
} {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  if (!Number.isFinite(Number(state.shardCount)) || Number(state.shardCount) < 1) return false;
  if (typeof state.completed !== "boolean") return false;
  if (!(typeof state.lastHashSeq === "string" || state.lastHashSeq === null)) return false;
  if (!Number.isFinite(Number(state.processed)) || Number(state.processed) < 0) return false;
  return true;
}

function readCheckpoint(path: string): CheckpointReadResult {
  if (!existsSync(path)) {
    return { checkpoint: defaultCheckpoint(), warnings: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return { checkpoint: defaultCheckpoint(), warnings: ["checkpoint_invalid_root"] };
    }
    const version = Number(parsed.version);
    if (!Number.isFinite(version)) {
      return { checkpoint: defaultCheckpoint(), warnings: ["checkpoint_version_invalid", "checkpoint_reset_applied"] };
    }
    if (version !== 1) {
      if (version > 1) {
        return {
          checkpoint: defaultCheckpoint(),
          warnings: [
            "checkpoint_version_mismatch",
            `checkpoint_version_newer:${version}`,
            "checkpoint_reset_applied",
          ],
        };
      }
      return {
        checkpoint: defaultCheckpoint(),
        warnings: [
          "checkpoint_version_mismatch",
          `checkpoint_version_unsupported:${version}`,
          "checkpoint_reset_applied",
        ],
      };
    }
    const rawCollections = parsed.collections;
    if (!rawCollections || typeof rawCollections !== "object") {
      return { checkpoint: defaultCheckpoint(), warnings: ["checkpoint_invalid_collections"] };
    }

    const normalized: ShardCheckpoint["collections"] = {};
    const warnings: string[] = [];
    for (const [name, rawState] of Object.entries(rawCollections)) {
      if (!isValidCheckpointCollectionState(rawState)) {
        warnings.push(`checkpoint_invalid_collection_state:${name}`);
        continue;
      }
      const state = rawState as {
        shardCount: number;
        completed: boolean;
        lastHashSeq: string | null;
        processed: number;
      };
      normalized[name] = {
        shardCount: Math.max(1, Math.floor(state.shardCount)),
        completed: state.completed,
        lastHashSeq: state.lastHashSeq,
        processed: Math.max(0, Math.floor(state.processed)),
      };
    }

    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString();
    return {
      checkpoint: {
        version: 1,
        collections: normalized,
        updatedAt,
      },
      warnings,
    };
  } catch {
    return { checkpoint: defaultCheckpoint(), warnings: ["checkpoint_parse_error"] };
  }
}

let checkpointWriteFile: (path: string, data: string, encoding: BufferEncoding) => void = writeFileSync;

export function __setCheckpointWriterForTests(
  writer: ((path: string, data: string, encoding: BufferEncoding) => void) | null
): void {
  checkpointWriteFile = writer ?? writeFileSync;
}

function writeCheckpoint(path: string, checkpoint: ShardCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  checkpoint.updatedAt = new Date().toISOString();
  const tmpPath = `${path}.tmp`;
  const data = JSON.stringify(checkpoint, null, 2);

  // If a test writer is injected, use it directly (preserves fault-injection test seam)
  if (checkpointWriteFile !== writeFileSync) {
    checkpointWriteFile(tmpPath, data, "utf-8");
    renameSync(tmpPath, path);
    return;
  }

  // F-INT-3: Atomic checkpoint write with fsync for crash durability
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w", 0o644);
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
  renameSync(tmpPath, path);
}

function parseVectorDimensions(mainDb: MainDatabase): number {
  const row = mainDb.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql?: string } | undefined;
  const sql = row?.sql || "";
  const m = sql.match(/float\[(\d+)\]/);
  const dims = m ? Number(m[1]) : 768;
  return Number.isFinite(dims) && dims > 0 ? dims : 768;
}

function dot(a: Float32Array, b: Float32Array): number {
  let acc = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    acc += (a[i] || 0) * (b[i] || 0);
  }
  return acc;
}

function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a)) || 1e-9;
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  const sim = dot(a, b) / (norm(a) * norm(b));
  return Math.max(0, Math.min(2, 1 - sim));
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function annCentroidCount(totalVectors: number): number {
  const requested = parsePositiveInt(process.env.KINDX_ANN_CENTROIDS, 64);
  return Math.max(1, Math.min(requested, Math.max(1, totalVectors)));
}

function annProbeCount(): number {
  return parsePositiveInt(process.env.KINDX_ANN_PROBE_COUNT, 4);
}

function annShortlistLimit(perShardK: number): number {
  const requested = parsePositiveInt(process.env.KINDX_ANN_SHORTLIST, perShardK * 20);
  return Math.max(perShardK, requested);
}

function isAnnEnabled(): boolean {
  const raw = String(process.env.KINDX_ANN_ENABLE ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

function parseVecDimensions(db: Database, tableName: string): number | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as { sql?: string } | undefined;
  const sql = row?.sql || "";
  const match = sql.match(/float\[(\d+)\]/);
  const dims = match ? Number(match[1]) : null;
  return Number.isFinite(dims) && (dims || 0) > 0 ? Number(dims) : null;
}

function rebuildShardAnnIndex(db: Database, dimensions: number): { centroidCount: number; vectorCount: number } {
  const vectors = (db.prepare(`
    SELECT hash_seq, embedding
    FROM vectors_vec
    ORDER BY hash_seq
  `).all() as Array<{ hash_seq: string; embedding: Buffer }>).map((v) => ({
    hash_seq: v.hash_seq,
    embedding: new Float32Array(v.embedding.buffer, v.embedding.byteOffset, v.embedding.byteLength / 4)
  }));
  const vectorCount = vectors.length;
  if (vectorCount === 0) {
    db.exec(`DELETE FROM ann_assignments`);
    db.exec(`DELETE FROM ann_centroids`);
    db.exec(`DELETE FROM ann_centroids_vec`);
    db.prepare(`INSERT OR REPLACE INTO ann_state (id, version, dimensions, vector_count, centroid_count, built_at) VALUES (1, 1, ?, 0, 0, ?)`)
      .run(dimensions, new Date().toISOString());
    return { centroidCount: 0, vectorCount: 0 };
  }

  const centroidCount = annCentroidCount(vectorCount);
  const centroids: Float32Array[] = [];
  for (let i = 0; i < centroidCount; i++) {
    const srcIdx = Math.floor((i * vectorCount) / centroidCount);
    const src = vectors[srcIdx]?.embedding;
    centroids.push(src ? new Float32Array(src) : new Float32Array(dimensions));
  }

  // Two lightweight refinement passes are enough for routing quality without
  // turning embed sync into a full offline clustering job.
  const assignments = new Array<number>(vectorCount).fill(0);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < vectorCount; i++) {
      const v = vectors[i]?.embedding;
      if (!v) continue;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c++) {
        const d = cosineDistance(v, centroids[c] || new Float32Array());
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      assignments[i] = best;
    }
    const sums = Array.from({ length: centroids.length }, () => new Float32Array(dimensions));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < vectorCount; i++) {
      const v = vectors[i]?.embedding;
      const a = assignments[i] || 0;
      if (!v || !sums[a]) continue;
      counts[a] += 1;
      const s = sums[a]!;
      for (let d = 0; d < dimensions; d++) s[d] = (s[d] || 0) + (v[d] || 0);
    }
    for (let c = 0; c < centroids.length; c++) {
      const count = counts[c] || 0;
      if (count === 0 || !sums[c]) continue;
      const next = sums[c]!;
      for (let d = 0; d < dimensions; d++) next[d] = next[d]! / count;
      centroids[c] = next;
    }
  }

  db.exec(`DELETE FROM ann_assignments`);
  db.exec(`DELETE FROM ann_centroids`);
  db.exec(`DELETE FROM ann_centroids_vec`);
  const upsertAssign = db.prepare(`INSERT OR REPLACE INTO ann_assignments (hash_seq, centroid_id) VALUES (?, ?)`);
  const upsertCentroid = db.prepare(`INSERT OR REPLACE INTO ann_centroids (centroid_id, count, built_at) VALUES (?, ?, ?)`);
  const upsertCentroidVec = db.prepare(`INSERT OR REPLACE INTO ann_centroids_vec (centroid_id, embedding) VALUES (?, ?)`);
  const builtAt = new Date().toISOString();
  const counts = new Array<number>(centroidCount).fill(0);
  for (let i = 0; i < vectorCount; i++) {
    const hashSeq = vectors[i]?.hash_seq;
    const centroidId = assignments[i] || 0;
    if (!hashSeq) continue;
    upsertAssign.run(hashSeq, centroidId);
    counts[centroidId] = (counts[centroidId] || 0) + 1;
  }
  for (let c = 0; c < centroidCount; c++) {
    const centroid = centroids[c] || new Float32Array(dimensions);
    upsertCentroid.run(c, counts[c] || 0, builtAt);
    upsertCentroidVec.run(String(c), centroid as any);
  }
  db.prepare(`
    INSERT OR REPLACE INTO ann_state (id, version, dimensions, vector_count, centroid_count, built_at)
    VALUES (1, 1, ?, ?, ?, ?)
  `).run(dimensions, vectorCount, centroidCount, builtAt);
  return { centroidCount, vectorCount };
}

function ensureShardSchema(db: Database, dimensions: number): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL"); // F-INT-1: Match main DB durability — prevent vector data loss on OS crash
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS shard_vectors (
      hash_seq TEXT NOT NULL,
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL,
      pos INTEGER NOT NULL,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      embedding_blob BLOB,
      PRIMARY KEY (hash, seq)
    )
  `);
  const shardColumns = db.prepare(`PRAGMA table_info(shard_vectors)`).all() as Array<{ name: string }>;
  const shardColSet = new Set(shardColumns.map((c) => c.name));
  if (!shardColSet.has("hash_seq")) db.exec(`ALTER TABLE shard_vectors ADD COLUMN hash_seq TEXT`);
  if (!shardColSet.has("embedding_blob")) db.exec(`ALTER TABLE shard_vectors ADD COLUMN embedding_blob BLOB`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shard_vectors_hash_seq ON shard_vectors(hash_seq)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shard_docs (
      collection TEXT NOT NULL,
      hash TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      PRIMARY KEY (collection, hash, path)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ann_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_count INTEGER NOT NULL,
      centroid_count INTEGER NOT NULL,
      built_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ann_assignments (
      hash_seq TEXT PRIMARY KEY,
      centroid_id INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ann_centroids (
      centroid_id INTEGER PRIMARY KEY,
      count INTEGER NOT NULL,
      built_at TEXT NOT NULL
    )
  `);

  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql?: string } | undefined;
  if (tableInfo?.sql) {
    const m = tableInfo.sql.match(/float\[(\d+)\]/);
    const existingDims = m?.[1] ? Number(m[1]) : null;
    if (existingDims !== dimensions) {
      db.exec(`DROP TABLE IF EXISTS vectors_vec`);
    }
  }
  const hasVec = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { name?: string } | undefined;
  if (!hasVec?.name) {
    db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
  }
  const annTableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ann_centroids_vec'`).get() as { sql?: string } | undefined;
  if (annTableInfo?.sql) {
    const m = annTableInfo.sql.match(/float\[(\d+)\]/);
    const existingDims = m?.[1] ? Number(m[1]) : null;
    if (existingDims !== dimensions) {
      db.exec(`DROP TABLE IF EXISTS ann_centroids_vec`);
    }
  }
  const hasAnnVec = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ann_centroids_vec'`).get() as { name?: string } | undefined;
  if (!hasAnnVec?.name) {
    db.exec(`CREATE VIRTUAL TABLE ann_centroids_vec USING vec0(centroid_id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
  }
}

function getShardedCollections(): CollectionShardConfig[] {
  return listCollections()
    .map((c) => {
      const cfg = getCollection(c.name);
      const raw = (cfg as any)?.shard_count;
      const shardCount = Number(raw);
      const batchSizeRaw = Number((cfg as any)?.embedding_batch_size);
      const workersRaw = Number((cfg as any)?.embedding_workers);
      const queueLimitRaw = Number((cfg as any)?.embed_queue_limit);
      return {
        collection: c.name,
        shardCount: Number.isFinite(shardCount) && shardCount > 1 ? Math.floor(shardCount) : 1,
        embeddingBatchSize: Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.floor(batchSizeRaw) : undefined,
        embeddingWorkers: Number.isFinite(workersRaw) && workersRaw > 0 ? Math.floor(workersRaw) : undefined,
        embedQueueLimit: Number.isFinite(queueLimitRaw) && queueLimitRaw > 0 ? Math.floor(queueLimitRaw) : undefined,
      };
    })
    .filter((c) => c.shardCount > 1);
}

function openShardHandles(dbPath: string, collection: string, shardCount: number, dimensions: number): Database[] {
  const handles: Database[] = [];
  const root = join(getShardRoot(dbPath), normalizeCollectionDir(collection));
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < shardCount; i++) {
    const sdb = openDatabase(shardDbPath(dbPath, collection, i));
    try {
      loadSqliteVec(sdb);
    } catch {
      // if sqlite-vec unavailable, shard db remains metadata-only and vector search will skip
    }
    ensureShardSchema(sdb, dimensions);
    handles.push(sdb);
  }
  return handles;
}

function openExistingShardHandles(dbPath: string, collection: string, shardCount: number): Array<Database | undefined> {
  const handles: Array<Database | undefined> = [];
  for (let i = 0; i < shardCount; i++) {
    const path = shardDbPath(dbPath, collection, i);
    if (!existsSync(path)) {
      handles.push(undefined);
      continue;
    }
    const sdb = openDatabase(path);
    try {
      loadSqliteVec(sdb);
    } catch {
      // keep handle open for metadata checks even when sqlite-vec is unavailable.
    }
    handles.push(sdb);
  }
  return handles;
}

function closeShardHandles(handles: Database[]): void {
  for (const db of handles) {
    try { db.close(); } catch {}
  }
}

function closeOptionalShardHandles(handles: Array<Database | undefined>): void {
  for (const db of handles) {
    if (!db) continue;
    try { db.close(); } catch {}
  }
}

function validateShardParitySample(
  mainDb: MainDatabase,
  collection: string,
  shardCount: number,
  handles: Array<Database | undefined>,
  sampleSize = 32
): string[] {
  const warnings: string[] = [];
  const rows = mainDb.prepare(`
    SELECT cv.hash, cv.seq
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash
    WHERE d.active = 1 AND d.collection = ?
    ORDER BY cv.hash, cv.seq
    LIMIT ?
  `).all(collection, sampleSize) as Array<{ hash: string; seq: number }>;

  for (const row of rows) {
    const shardIdx = hashToShard(row.hash, shardCount);
    const shard = handles[shardIdx];
    if (!shard) {
      warnings.push(`parity_shard_handle_missing:${collection}:${shardIdx}`);
      continue;
    }
    const hashSeq = `${row.hash}_${row.seq}`;
    try {
      const vecPresent = shard.prepare(`SELECT 1 AS ok FROM shard_vectors WHERE hash = ? AND seq = ? LIMIT 1`).get(row.hash, row.seq) as { ok?: number } | undefined;
      if (!vecPresent?.ok) warnings.push(`parity_vector_missing:${collection}:${hashSeq}:shard${shardIdx}`);

      const docPresent = shard.prepare(`SELECT 1 AS ok FROM shard_docs WHERE collection = ? AND hash = ? LIMIT 1`).get(collection, row.hash) as { ok?: number } | undefined;
      if (!docPresent?.ok) warnings.push(`parity_doc_missing:${collection}:${row.hash}:shard${shardIdx}`);
    } catch {
      warnings.push(`parity_read_failed:${collection}:${shardIdx}`);
    }
  }
  return warnings;
}

export function getShardRuntimeStatus(dbPath: string): {
  enabledCollections: CollectionShardConfig[];
  checkpointPath: string;
  checkpointExists: boolean;
  warnings: string[];
} {
  const enabledCollections = getShardedCollections();
  const checkpointPath = getShardCheckpointPath(dbPath);
  const checkpointState = readCheckpoint(checkpointPath);
  const warnings: string[] = [...checkpointState.warnings];

  for (const cfg of enabledCollections) {
    const collectionRoot = join(getShardRoot(dbPath), normalizeCollectionDir(cfg.collection));
    if (!existsSync(collectionRoot)) {
      warnings.push(`shard_root_missing:${cfg.collection}`);
      continue;
    }
    for (let i = 0; i < cfg.shardCount; i++) {
      const p = shardDbPath(dbPath, cfg.collection, i);
      if (!existsSync(p)) warnings.push(`shard_missing:${cfg.collection}:${i}`);
    }
  }

  return {
    enabledCollections,
    checkpointPath,
    checkpointExists: existsSync(checkpointPath),
    warnings,
  };
}

export function getAnnRuntimeStatus(dbPath: string): AnnRuntimeStatus {
  const runtime = getShardRuntimeStatus(dbPath);
  const enabled = isAnnEnabled();
  const details: AnnRuntimeStatus["details"] = [];
  const probeCount = annProbeCount();
  const shortlistLimit = annShortlistLimit(20);

  if (runtime.enabledCollections.length === 0) {
    return {
      enabled,
      mode: "exact",
      state: "missing",
      probeCount,
      shortlistLimit,
      details: [{ collection: "__none__", shard: -1, state: "missing", reason: "ann_not_configured" }],
    };
  }

  for (const cfg of runtime.enabledCollections) {
    for (let i = 0; i < cfg.shardCount; i++) {
      const path = shardDbPath(dbPath, cfg.collection, i);
      if (!existsSync(path)) {
        details.push({ collection: cfg.collection, shard: i, state: "missing", reason: "shard_missing" });
        continue;
      }
      let db: Database | null = null;
      try {
        db = openDatabase(path);
        try {
          loadSqliteVec(db);
        } catch {
          details.push({ collection: cfg.collection, shard: i, state: "degraded", reason: "vec_unavailable" });
          continue;
        }
        if (!enabled) {
          details.push({ collection: cfg.collection, shard: i, state: "degraded", reason: "ann_disabled" });
          continue;
        }
        const hasVecTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { name?: string } | undefined;
        if (!hasVecTable?.name) {
          details.push({ collection: cfg.collection, shard: i, state: "missing", reason: "vectors_missing" });
          continue;
        }
        const hasAnnVec = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ann_centroids_vec'`).get() as { name?: string } | undefined;
        const annState = db.prepare(`
          SELECT version, dimensions, vector_count, centroid_count
          FROM ann_state
          WHERE id = 1
        `).get() as { version?: number; dimensions?: number; vector_count?: number; centroid_count?: number } | undefined;
        if (!hasAnnVec?.name || !annState) {
          details.push({ collection: cfg.collection, shard: i, state: "missing", reason: "ann_artifacts_missing" });
          continue;
        }
        const currentCount = (db.prepare(`SELECT COUNT(*) AS c FROM vectors_vec`).get() as { c: number }).c;
        const vecDims = parseVecDimensions(db, "vectors_vec");
        const annDims = Number(annState.dimensions || 0);
        if (annState.version !== 1 || currentCount !== Number(annState.vector_count || 0) || (vecDims !== null && annDims !== vecDims)) {
          details.push({ collection: cfg.collection, shard: i, state: "stale", reason: "ann_artifacts_stale" });
          continue;
        }
        details.push({ collection: cfg.collection, shard: i, state: "ready", reason: "ok" });
      } catch {
        details.push({ collection: cfg.collection, shard: i, state: "degraded", reason: "ann_probe_failed" });
      } finally {
        if (db) {
          try { db.close(); } catch {}
        }
      }
    }
  }

  const has = (state: AnnShardState) => details.some((d) => d.state === state);
  const state: AnnShardState = has("degraded")
    ? "degraded"
    : has("stale")
      ? "stale"
      : has("missing")
        ? "missing"
        : "ready";
  const mode: "ann" | "exact" = state === "ready" ? "ann" : "exact";

  return { enabled, mode, state, probeCount, shortlistLimit, details };
}

export async function syncCollectionShardsFromMainDb(
  db: MainDatabase,
  dbPath: string,
  options: ShardSyncOptions = {}
): Promise<ShardSyncResult> {
  const configs = getShardedCollections();
  const checkpointPath = getShardCheckpointPath(dbPath);
  const checkpointState = readCheckpoint(checkpointPath);
  const checkpoint = checkpointState.checkpoint;
  const results: ShardSyncResult["collections"] = [];
  const syncWarnings: string[] = [...checkpointState.warnings];

  if (configs.length === 0) {
    writeCheckpoint(checkpointPath, checkpoint);
    return { collections: [], checkpointPath, warnings: syncWarnings };
  }

  const dimensions = parseVectorDimensions(db);

  for (const cfg of configs) {
    const state = checkpoint.collections[cfg.collection] || {
      shardCount: cfg.shardCount,
      completed: false,
      lastHashSeq: null,
      processed: 0,
    };

    // shard topology changed, reset progress
    if (state.shardCount !== cfg.shardCount) {
      syncWarnings.push(`topology_drift:${cfg.collection}:${state.shardCount}->${cfg.shardCount}`);
      state.completed = false;
      state.lastHashSeq = null;
      state.processed = 0;
      state.shardCount = cfg.shardCount;
    }

    const resumed = !!options.resume;
    const handles = openShardHandles(dbPath, cfg.collection, cfg.shardCount, dimensions);
    try {
      const totalRow = db.prepare(`
        SELECT COUNT(*) as total FROM (
          SELECT 1
          FROM content_vectors cv
          JOIN documents d ON d.hash = cv.hash
          JOIN vectors_vec v ON v.hash_seq = cv.hash || '_' || cv.seq
          WHERE d.active = 1 AND d.collection = ?
          GROUP BY cv.hash, cv.seq
        )
      `).get(cfg.collection) as { total: number };
      const total = totalRow?.total || 0;

      const rowIter = db.prepare(`
      SELECT cv.hash, cv.seq, cv.pos, cv.model, cv.embedded_at, MIN(d.path) AS path, MIN(d.title) AS title, v.embedding
      FROM content_vectors cv
      JOIN documents d ON d.hash = cv.hash
      JOIN vectors_vec v ON v.hash_seq = cv.hash || '_' || cv.seq
      WHERE d.active = 1 AND d.collection = ?
      GROUP BY cv.hash, cv.seq, cv.pos, cv.model, cv.embedded_at, v.embedding
      ORDER BY cv.hash, cv.seq
      `).iterate(cfg.collection) as IterableIterator<{
        hash: string;
        seq: number;
        pos: number;
        model: string;
        embedded_at: string;
        path: string;
        title: string;
        embedding: Buffer;
      }>;

      // total evaluated via explicit SELECT COUNT above
      let processed = 0;
      let capped = false;
      let queueProcessed = 0;
      const queueLimit = cfg.embedQueueLimit ?? null;
      const batchSize = cfg.embeddingBatchSize ?? 200;
      const workers = cfg.embeddingWorkers ?? 1;
      const collectionWarnings: string[] = [];
      let batchSuccess = true;
      try {
        let last = options.resume ? state.lastHashSeq : null;
        if (last) {
          const isValid = db.prepare(`
            SELECT 1 FROM content_vectors cv 
            JOIN documents d ON d.hash = cv.hash 
            WHERE d.active = 1 AND d.collection = ? AND (cv.hash || '_' || cv.seq) = ?
          `).get(cfg.collection, last);
          if (!isValid) {
            collectionWarnings.push(`resume_cursor_invalid:${last}`);
            last = null;
          }
        }

        const activeHashesStrArr: string[] = [];
        for (const shard of handles) shard.exec("BEGIN");

        for (const row of rowIter) {
          const hashSeq = `${row.hash}_${row.seq}`;
          activeHashesStrArr.push(hashSeq);
          if (last && hashSeq <= last) {
            processed += 1;
            continue;
          }
          if (queueLimit !== null && queueProcessed >= queueLimit) {
            capped = true;
            collectionWarnings.push(`embed_queue_capped:${cfg.collection}:${queueLimit}`);
            syncWarnings.push(`embed_queue_capped:${cfg.collection}:${queueLimit}`);
            break;
          }

          const shardIdx = hashToShard(row.hash, cfg.shardCount);
          const shard = handles[shardIdx];
          if (!shard) {
            const reason = `shard_write_handle_missing:${cfg.collection}:${shardIdx}`;
            collectionWarnings.push(reason);
            syncWarnings.push(reason);
            batchSuccess = false;
            break;
          }
          try {
            const typedArray = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
            shard.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(hashSeq, typedArray);
            shard.prepare(`
            INSERT OR REPLACE INTO shard_vectors
              (hash_seq, hash, seq, pos, model, embedded_at, embedding_blob)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
              hashSeq, row.hash, row.seq, row.pos, row.model, row.embedded_at, Buffer.from(row.embedding)
            );
            shard.prepare(`INSERT OR REPLACE INTO shard_docs (collection, hash, path, title) VALUES (?, ?, ?, ?)`).run(
              cfg.collection, row.hash, row.path || "", row.title || ""
            );
          } catch (err) {
            const reason = `shard_write_failed:${cfg.collection}:${shardIdx}:${err instanceof Error ? err.message : String(err)}`;
            collectionWarnings.push(reason);
            syncWarnings.push(reason);
            batchSuccess = false;
            break;
          }

          processed += 1;
          queueProcessed += 1;
          state.lastHashSeq = hashSeq;
          state.processed = processed;
          if (processed > 0 && processed % batchSize === 0) {
            // F-001: Push COMMIT securely into checkpoint synchronization loop
            for (const shard of handles) {
              shard.exec("COMMIT");
            }
            checkpoint.collections[cfg.collection] = state;
            writeCheckpoint(checkpointPath, checkpoint);
            
            // Unblock event loop
            await new Promise((resolve) => setTimeout(resolve, 0));
            
            for (const shard of handles) {
              shard.exec("BEGIN");
            }
          }
          options.onProgress?.({ collection: cfg.collection, processed, total });
        }

        // Compute inactive seq bounds to clean orphaned shard items iteratively.
        if (!capped && batchSuccess && activeHashesStrArr.length > 0) {
          try {
            const activeHashesStr = JSON.stringify(activeHashesStrArr);
            for (const shard of handles) {
              shard.prepare(`DELETE FROM shard_vectors WHERE hash_seq NOT IN (SELECT value FROM json_each(?))`).run(activeHashesStr);
              shard.prepare(`DELETE FROM vectors_vec WHERE hash_seq NOT IN (SELECT value FROM json_each(?))`).run(activeHashesStr);
            }
          } catch (err) {
            const reason = `shard_cleanup_failed:${cfg.collection}:${err instanceof Error ? err.message : String(err)}`;
            collectionWarnings.push(reason);
            syncWarnings.push(reason);
            batchSuccess = false;
          }
        }

      } catch (err) {
        batchSuccess = false;
      } finally {
        // Execute database commits first.
        for (const shard of handles) {
          try {
            if (batchSuccess) {
              shard.exec("COMMIT");
            } else {
              shard.exec("ROLLBACK");
            }
          } catch (txErr) {
            const message = txErr instanceof Error ? txErr.message : String(txErr);
            const noActiveTx = /no transaction is active/i.test(message);
            if (!noActiveTx) {
              throw txErr;
            }
          }
        }

        // F-001: Align sync checkpoint with the trailing batch commit.
        if (batchSuccess && !capped && processed > 0) {
          checkpoint.collections[cfg.collection] = state;
          writeCheckpoint(checkpointPath, checkpoint);
        }
      }

      if (!batchSuccess) continue;

      state.completed = !capped && processed >= total;
      for (const shard of handles) {
        try {
          if (isAnnEnabled()) rebuildShardAnnIndex(shard, dimensions);
        } catch {
          const reason = `ann_rebuild_failed:${cfg.collection}`;
          collectionWarnings.push(reason);
          syncWarnings.push(reason);
        }
      }
      checkpoint.collections[cfg.collection] = state;
      writeCheckpoint(checkpointPath, checkpoint);
      const parityWarnings = validateShardParitySample(db, cfg.collection, cfg.shardCount, handles);
      for (const warning of parityWarnings) {
        collectionWarnings.push(warning);
        syncWarnings.push(warning);
      }
      results.push({
        collection: cfg.collection,
        shardCount: cfg.shardCount,
        processed,
        total,
        resumed,
        warnings: collectionWarnings,
        queue: {
          total,
          processed,
          pending: Math.max(0, total - processed),
          capped,
          queueLimit,
          workers,
          batchSize,
        },
      });
    } finally {
      closeShardHandles(handles);
    }
  }

  return { collections: results, checkpointPath, warnings: syncWarnings };
}

export function getSchedulerCheckpointState(dbPath: string): {
  checkpointPath: string;
  checkpointExists: boolean;
  version: number;
  valid: boolean;
  collections: Record<string, { shardCount: number; completed: boolean; lastHashSeq: string | null; processed: number }>;
  warnings: string[];
} {
  const checkpointPath = getShardCheckpointPath(dbPath);
  const state = readCheckpoint(checkpointPath);
  return {
    checkpointPath,
    checkpointExists: existsSync(checkpointPath),
    version: state.checkpoint.version,
    valid: state.warnings.length === 0,
    collections: state.checkpoint.collections,
    warnings: state.warnings,
  };
}

export function getSchedulerQueueState(
  db: MainDatabase,
  dbPath: string
): Array<{
  collection: string;
  shardCount: number;
  total: number;
  processed: number;
  pending: number;
  queueLimit: number | null;
  workers: number;
  batchSize: number;
  active: number;
}> {
  const checkpoint = getSchedulerCheckpointState(dbPath);
  const collections = getShardedCollections();
  return collections.map((cfg) => {
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT cv.hash, cv.seq
        FROM content_vectors cv
        JOIN documents d ON d.hash = cv.hash
        WHERE d.active = 1 AND d.collection = ?
        GROUP BY cv.hash, cv.seq
      )
    `).get(cfg.collection) as { total?: number } | undefined;
    const total = Number(totalRow?.total ?? 0);
    const state = checkpoint.collections[cfg.collection];
    const processed = Math.max(0, Math.min(total, Number(state?.processed ?? 0)));
    return {
      collection: cfg.collection,
      shardCount: cfg.shardCount,
      total,
      processed,
      pending: Math.max(0, total - processed),
      queueLimit: cfg.embedQueueLimit ?? null,
      workers: cfg.embeddingWorkers ?? 1,
      batchSize: cfg.embeddingBatchSize ?? 200,
      active: state?.completed ? 0 : Math.min(cfg.embeddingWorkers ?? 1, Math.max(0, total - processed)),
    };
  });
}

export function getShardHealthSummary(
  db: MainDatabase,
  dbPath: string,
  sampleSize = 16
): {
  status: "ok" | "warn" | "error";
  families: Record<"topology" | "checkpoint" | "read" | "write" | "parity", { count: number; severity: "warn" | "error" }>;
  warnings: string[];
} {
  const runtime = getShardRuntimeStatus(dbPath);
  const warnings = [...runtime.warnings];
  const classifyFamily = (warning: string): "topology" | "checkpoint" | "read" | "write" | "parity" => {
    if (warning.startsWith("topology_") || warning.startsWith("shard_root_missing:") || warning.startsWith("shard_missing:")) {
      return "topology";
    }
    if (warning.startsWith("checkpoint_") || warning.startsWith("resume_cursor_invalid:")) {
      return "checkpoint";
    }
    if (warning.startsWith("shard_read_")) {
      return "read";
    }
    if (warning.startsWith("shard_write_")) {
      return "write";
    }
    return "parity";
  };
  const classifySeverity = (warning: string): "warn" | "error" => {
    if (warning.startsWith("topology_drift:")) return "warn";
    if (warning.startsWith("embed_queue_capped:")) return "warn";
    return "error";
  };
  for (const cfg of runtime.enabledCollections) {
    const handles = openExistingShardHandles(dbPath, cfg.collection, cfg.shardCount);
    try {
      const parityWarnings = validateShardParitySample(
        db,
        cfg.collection,
        cfg.shardCount,
        handles,
        sampleSize
      );
      warnings.push(...parityWarnings);
    } finally {
      closeOptionalShardHandles(handles);
    }
  }
  const families: Record<"topology" | "checkpoint" | "read" | "write" | "parity", { count: number; severity: "warn" | "error" }> = {
    topology: { count: 0, severity: "warn" },
    checkpoint: { count: 0, severity: "warn" },
    read: { count: 0, severity: "warn" },
    write: { count: 0, severity: "warn" },
    parity: { count: 0, severity: "warn" },
  };
  for (const warning of warnings) {
    const family = classifyFamily(warning);
    const severity = classifySeverity(warning);
    const current = families[family];
    current.count += 1;
    if (severity === "error") current.severity = "error";
  }
  const familyValues = Object.values(families).filter((f) => f.count > 0);
  const status: "ok" | "warn" | "error" =
    warnings.length === 0 ? "ok" : familyValues.some((f) => f.severity === "error") ? "error" : "warn";
  return { status, families, warnings };
}

export function searchShardedVectorsWithDiagnostics(
  dbPath: string,
  collection: string,
  shardCount: number,
  embedding: Float32Array,
  perShardK: number
): { matches: Array<{ hash_seq: string; distance: number }>; warnings: string[] } {
  const warnings: string[] = [];
  const matches: Array<{ hash_seq: string; distance: number }> = [];
  const annEnabled = isAnnEnabled();
  const probeCount = annProbeCount();
  const shortlistPerShard = annShortlistLimit(perShardK);
  for (let i = 0; i < shardCount; i++) {
    const path = shardDbPath(dbPath, collection, i);
    if (!existsSync(path)) {
      warnings.push(`shard_read_missing:${collection}:${i}`);
      continue;
    }
    const sdb = openDatabase(path);
    try {
      try {
        loadSqliteVec(sdb);
      } catch {
        warnings.push(`shard_read_vec_unavailable:${collection}:${i}`);
      }
      const hasVec = sdb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { name?: string } | undefined;
      if (!hasVec?.name) {
        warnings.push(`shard_read_no_vectors_table:${collection}:${i}`);
        continue;
      }

      let usedAnn = false;
      if (annEnabled) {
        try {
          const annState = sdb.prepare(`
            SELECT version, dimensions, vector_count, centroid_count
            FROM ann_state
            WHERE id = 1
          `).get() as { version?: number; dimensions?: number; vector_count?: number; centroid_count?: number } | undefined;
          const hasCentroids = sdb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ann_centroids_vec'`).get() as { name?: string } | undefined;
          if (annState?.version === 1 && hasCentroids?.name) {
            const currentCount = (sdb.prepare(`SELECT COUNT(*) AS c FROM vectors_vec`).get() as { c: number }).c;
            if (currentCount !== Number(annState.vector_count || 0)) {
              warnings.push(`ann_stale:${collection}:${i}`);
            } else {
              const nearestCentroids = sdb.prepare(`
                SELECT centroid_id, distance
                FROM ann_centroids_vec
                WHERE embedding MATCH ? AND k = ?
              `).all(embedding, probeCount) as Array<{ centroid_id: string; distance: number }>;
              if (nearestCentroids.length > 0) {
                const centroidIds = nearestCentroids.map((c) => Number(c.centroid_id)).filter((n) => Number.isFinite(n));
                const centroidPlaceholders = centroidIds.map(() => "?").join(",");
                if (centroidIds.length > 0) {
                  const candidates = sdb.prepare(`
                    SELECT hash_seq
                    FROM ann_assignments
                    WHERE centroid_id IN (${centroidPlaceholders})
                    LIMIT ?
                  `).all(...centroidIds, shortlistPerShard) as Array<{ hash_seq: string }>;
                  const candidateIds = candidates.map((c) => c.hash_seq).filter(Boolean);
                  if (candidateIds.length > 0) {
                    const inClause = candidateIds.map(() => "?").join(",");
                    const candidateRows = sdb.prepare(`
                      SELECT hash_seq, vec_distance_cosine(embedding, ?) as distance
                      FROM vectors_vec
                      WHERE hash_seq IN (${inClause})
                    `).all(embedding, ...candidateIds) as Array<{ hash_seq: string; distance: number }>;
                    const approx = candidateRows
                      .sort((a, b) => (a.distance - b.distance) || a.hash_seq.localeCompare(b.hash_seq))
                      .slice(0, perShardK);
                    matches.push(...approx);
                    usedAnn = true;
                  }
                }
              }
            }
          } else {
            warnings.push(`ann_missing:${collection}:${i}`);
          }
        } catch {
          warnings.push(`ann_failed:${collection}:${i}`);
        }
      }
      if (!usedAnn) {
        const rows = sdb.prepare(`
          SELECT hash_seq, distance
          FROM vectors_vec
          WHERE embedding MATCH ? AND k = ?
        `).all(embedding, perShardK) as Array<{ hash_seq: string; distance: number }>;
        matches.push(...rows);
      }
    } catch {
      warnings.push(`shard_read_failed:${collection}:${i}`);
    } finally {
      try { sdb.close(); } catch {}
    }
  }
  const sorted = matches.sort((a, b) => (a.distance - b.distance) || a.hash_seq.localeCompare(b.hash_seq));
  return { matches: sorted, warnings };
}

export function searchShardedVectors(
  dbPath: string,
  collection: string,
  shardCount: number,
  embedding: Float32Array,
  perShardK: number
): Array<{ hash_seq: string; distance: number }> {
  return searchShardedVectorsWithDiagnostics(dbPath, collection, shardCount, embedding, perShardK).matches;
}
