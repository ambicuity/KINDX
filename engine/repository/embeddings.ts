// Extracted from engine/repository.ts as part of W1 decomposition (C11b).
// Embedding storage: query/doc embedding fetch via the inference layer, plus
// the prepared-statement and transaction caches for inserting embeddings into
// content_vectors / vectors_vec.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../runtime.js";
import {
  getDefaultLLM,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  type ILLMSession,
} from "../inference.js";

export async function getEmbedding(text: string, model: string, isQuery: boolean, session?: ILLMSession): Promise<number[] | null> {
  // Format text using the appropriate prompt template
  const formattedText = isQuery ? formatQueryForEmbedding(text, model) : formatDocForEmbedding(text, undefined, model);
  const result = session
    ? await session.embed(formattedText, { model, isQuery })
    : await getDefaultLLM().embed(formattedText, { model, isQuery });
  return result?.embedding || null;
}

/**
 * Get all unique content hashes that need embeddings (from active documents).
 * Returns hash, document body, and a sample path for display purposes.
 */
export function getHashesForEmbedding(db: Database): { hash: string; body: string; path: string }[] {
  return db.prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
  `).all() as { hash: string; body: string; path: string }[];
}

/**
 * Clear all embeddings from the database (force re-index).
 * Deletes all rows from content_vectors and drops the vectors_vec table.
 *
 * The per-db prepared-statement and transaction caches MUST be invalidated
 * here. Without invalidation the next insertEmbedding call would reuse a
 * compiled statement bound to the dropped vectors_vec, blowing up with
 * "no such table" or executing against a stale plan.
 */
export function clearAllEmbeddings(db: Database): void {
  db.exec(`DELETE FROM content_vectors`);
  db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  invalidateEmbeddingStmtCaches(db);
}

// Prepared statement cache for insertEmbedding — avoids recompiling the same SQL
// on every call during bulk embed runs. Keyed by Database instance via WeakMap
// so statements are freed when the database is closed.
const _insertEmbeddingStmtCache = new WeakMap<
  Database,
  {
    insertVec: ReturnType<Database["prepare"]>;
    insertContentVector: ReturnType<Database["prepare"]>;
    insertPairTxn: (h: string, s: number, p: number, e: Float32Array, m: string, t: string) => void;
  }
>();

export function invalidateEmbeddingStmtCaches(db: Database): void {
  _insertEmbeddingStmtCache.delete(db);
  _bulkInsertTxnCache.delete(db);
}

export function getInsertEmbeddingStmts(db: Database) {
  const cached = _insertEmbeddingStmtCache.get(db);
  if (cached) return cached;
  const insertVec = db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
  const insertContentVector = db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`);
  // Cache a compiled transaction wrapper so single-row inserts commit
  // atomically without paying the BEGIN/COMMIT compilation cost on every
  // call. Without this wrapper the two .run() calls auto-commit
  // independently and an interrupted process drifts the two tables out of
  // parity — the exact mismatch ensureVectorIndexIntegrity now warns on.
  const insertPairTxn = db.transaction((
    h: string,
    s: number,
    p: number,
    e: Float32Array,
    m: string,
    t: string,
  ) => {
    insertVec.run(`${h}_${s}`, e);
    insertContentVector.run(h, s, p, m, t);
  });
  const stmts = { insertVec, insertContentVector, insertPairTxn };
  _insertEmbeddingStmtCache.set(db, stmts);
  return stmts;
}

/**
 * Insert a single embedding into both content_vectors and vectors_vec tables.
 * The hash_seq key is formatted as "hash_seq_N" for the vectors_vec table.
 *
 * Performance note: prepared statements are cached per database connection via a
 * WeakMap, so this function compiles the SQL exactly once per store lifetime.
 *
 * Atomicity: both inserts commit together via a cached SQLite transaction so
 * an interrupted call cannot leave content_vectors and vectors_vec out of
 * parity.
 */
export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string
): void {
  const { insertPairTxn } = getInsertEmbeddingStmts(db);
  insertPairTxn(hash, seq, pos, embedding, model, embeddedAt);
}

// Cached transaction wrapper for bulk embedding inserts.
// db.transaction() interns a compiled transaction object; re-using the same
// wrapper avoids recompiling it on every bulk-insert call.
const _bulkInsertTxnCache = new WeakMap<
  Database,
  (embeddings: ReadonlyArray<{
    hash: string;
    seq: number;
    pos: number;
    embedding: Float32Array;
    model: string;
    embeddedAt: string;
  }>) => void
>();

export function getBulkInsertTxn(db: Database) {
  const cached = _bulkInsertTxnCache.get(db);
  if (cached) return cached;

  const { insertVec, insertContentVector } = getInsertEmbeddingStmts(db);
  const txn = db.transaction((embeddings: ReadonlyArray<{
    hash: string;
    seq: number;
    pos: number;
    embedding: Float32Array;
    model: string;
    embeddedAt: string;
  }>) => {
    for (const e of embeddings) {
      const hashSeq = `${e.hash}_${e.seq}`;
      insertVec.run(hashSeq, e.embedding);
      insertContentVector.run(e.hash, e.seq, e.pos, e.model, e.embeddedAt);
    }
  });

  _bulkInsertTxnCache.set(db, txn);
  return txn;
}

/**
 * Insert multiple embeddings atomically within a single SQLite transaction.
 *
 * Without an explicit transaction, `better-sqlite3` auto-commits every `.run()`
 * call individually, causing a WAL flush (and potential fsync) per row. For bulk
 * embed runs with hundreds to thousands of chunks this overhead is significant.
 *
 * This function wraps the entire batch in a single BEGIN/COMMIT, amortising the
 * WAL flush cost across the full batch. Both the transaction wrapper and the
 * prepared statements it uses are cached per-db-instance in WeakMaps, so there
 * is no compilation overhead after the first call.
 *
 * Empirically, this yields a 10-50× throughput improvement over per-row commits
 * for batch sizes ≥ 32 on a local NVMe drive.
 *
 * @param db        - The SQLite database instance
 * @param embeddings - Embedding records to insert; no-op if empty
 */
export function bulkInsertEmbeddings(
  db: Database,
  embeddings: ReadonlyArray<{
    hash: string;
    seq: number;
    pos: number;
    embedding: Float32Array;
    model: string;
    embeddedAt: string;
  }>
): void {
  if (embeddings.length === 0) return;
  getBulkInsertTxn(db)(embeddings);
}
