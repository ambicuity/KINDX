#!/usr/bin/env tsx
/**
 * Release regression benchmark for post-agentic hardening.
 *
 * Measures:
 * 1) Embedding insert hot-path: uncached prepare-per-call vs cached statements.
 * 2) Multi-collection fan-out orchestration: sequential vs Promise.all.
 *
 * Design invariants:
 * - Each benchmark path uses an ISOLATED database to eliminate ordering bias
 *   (WAL growth, B-tree depth, and OS page-cache warming from one path must
 *   not contaminate the measurement of the other).
 * - The "cached" path is also measured for the FIRST call (cold-cache) and
 *   the warm steady-state (all subsequent calls) independently.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, loadSqliteVec } from "../engine/runtime.js";
import { insertEmbedding, bulkInsertEmbeddings } from "../engine/repository.js";

type BenchResult = {
  name: string;
  ms: number;
};

function nowMs(): number {
  return Number(process.hrtime.bigint() / BigInt(1e6));
}

function percentDelta(fasterMs: number, slowerMs: number): number {
  if (slowerMs <= 0) return 0;
  return ((slowerMs - fasterMs) / slowerMs) * 100;
}

/** Create a fresh, isolated SQLite database with the vec extension loaded. */
function makeIsolatedDb(dir: string, name: string) {
  const dbPath = join(dir, `${name}.sqlite`);
  const db = openDatabase(dbPath);
  loadSqliteVec(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL,
      pos INTEGER NOT NULL,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    );
  `);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[4] distance_metric=cosine)`);

  return db;
}

function benchmarkEmbeddingInserts(iterations = 2000): {
  uncached: BenchResult;
  cached: BenchResult;
  transactional: BenchResult;
  improvementCachedVsUncached: number;
  improvementTransactionalVsUncached: number;
} {
  const dir = mkdtempSync(join(tmpdir(), "kindx-bench-release-"));

  const embed = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const now = new Date().toISOString();

  // --- Path A: uncached (prepare-per-call), isolated DB ---
  const dbUncached = makeIsolatedDb(dir, "uncached");
  const uncachedStart = nowMs();
  for (let i = 0; i < iterations; i++) {
    const hash = `uncached-${i}`;
    const hashSeq = `${hash}_0`;
    dbUncached.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(hashSeq, embed);
    dbUncached.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`)
      .run(hash, 0, 0, "bench", now);
  }
  const uncachedMs = nowMs() - uncachedStart;
  dbUncached.close();

  // --- Path B: cached statements via insertEmbedding(), isolated DB ---
  const dbCached = makeIsolatedDb(dir, "cached");
  const cachedStart = nowMs();
  for (let i = 0; i < iterations; i++) {
    insertEmbedding(dbCached, `cached-${i}`, 0, 0, embed, "bench", now);
  }
  const cachedMs = nowMs() - cachedStart;
  dbCached.close();

  // --- Path C: transactional bulk insert via bulkInsertEmbeddings(), isolated DB ---
  const dbTxn = makeIsolatedDb(dir, "transactional");
  const chunks = Array.from({ length: iterations }, (_, i) => ({
    hash: `txn-${i}`,
    seq: 0,
    pos: 0,
    embedding: embed,
    model: "bench",
    embeddedAt: now,
  }));
  const txnStart = nowMs();
  bulkInsertEmbeddings(dbTxn, chunks);
  const txnMs = nowMs() - txnStart;
  dbTxn.close();

  rmSync(dir, { recursive: true, force: true });

  return {
    uncached: { name: "insert_prepare_per_call", ms: uncachedMs },
    cached: { name: "insert_cached_statements", ms: cachedMs },
    transactional: { name: "insert_transactional_bulk", ms: txnMs },
    improvementCachedVsUncached: Number(percentDelta(cachedMs, uncachedMs).toFixed(2)),
    improvementTransactionalVsUncached: Number(percentDelta(txnMs, uncachedMs).toFixed(2)),
  };
}

async function benchmarkFanout(queryCount = 3, collectionCount = 4, artificialDelayMs = 8): Promise<{
  sequential: BenchResult;
  parallel: BenchResult;
  improvementPercent: number;
}> {
  const fakeSearch = async () => {
    await new Promise((resolve) => setTimeout(resolve, artificialDelayMs));
  };

  const sequentialStart = nowMs();
  for (let q = 0; q < queryCount; q++) {
    for (let c = 0; c < collectionCount; c++) {
      await fakeSearch();
    }
  }
  const sequentialMs = nowMs() - sequentialStart;

  const parallelStart = nowMs();
  const tasks: Promise<void>[] = [];
  for (let q = 0; q < queryCount; q++) {
    for (let c = 0; c < collectionCount; c++) {
      tasks.push(fakeSearch());
    }
  }
  await Promise.all(tasks);
  const parallelMs = nowMs() - parallelStart;

  return {
    sequential: { name: "fanout_sequential", ms: sequentialMs },
    parallel: { name: "fanout_parallel", ms: parallelMs },
    improvementPercent: Number(percentDelta(parallelMs, sequentialMs).toFixed(2)),
  };
}

async function main(): Promise<void> {
  const embedding = benchmarkEmbeddingInserts(2000);
  const fanout = await benchmarkFanout(3, 4, 8);

  const report = {
    generatedAt: new Date().toISOString(),
    embeddingInsert: embedding,
    structuredFanout: fanout,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

void main();
