// Extracted from engine/repository.ts as part of W1 decomposition (C3).
// SQLite database initialization, sqlite-vec availability gating, and the
// vectors_vec virtual-table lifecycle (parity check + per-dimension setup).
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../runtime.js";
import { loadSqliteVec } from "../runtime.js";
import { initializeCoreSchema } from "../schema.js";
import { quietWarn, errString } from "../utils/quiet-warn.js";

function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location."
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifySqliteVecLoaded(db: Database): void {
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version?: string } | null;
    if (!row?.version || typeof row.version !== "string") {
      throw new Error("vec_version() returned no version");
    }
  } catch (err) {
    const message = getErrorMessage(err);
    throw createSqliteVecUnavailableError(`sqlite-vec probe failed (${message})`);
  }
}

let _sqliteVecAvailable: boolean | null = null;

export function initializeDatabase(db: Database): void {
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    _sqliteVecAvailable = true;
  } catch {
    // sqlite-vec is optional — vector search won't work but FTS is fine
    _sqliteVecAvailable = false;
  }
  db.exec("PRAGMA journal_mode = WAL");
  // Tier-1 perf: WAL mode's recommended pairing is synchronous=NORMAL, not
  // FULL. FULL forces an extra fsync per commit (~2-3x write slowdown) for
  // a durability guarantee WAL doesn't actually need — a crash with
  // synchronous=NORMAL+WAL will roll back the most recent uncommitted
  // transaction but never corrupt the database. Operators who specifically
  // need group-commit durability can opt back in via KINDX_SYNCHRONOUS=FULL.
  const syncMode = (process.env.KINDX_SYNCHRONOUS || "NORMAL").toUpperCase();
  db.exec(`PRAGMA synchronous = ${syncMode === "FULL" ? "FULL" : "NORMAL"}`);
  db.exec("PRAGMA busy_timeout = 30000"); // Allow concurrent processes to wait for lock
  db.exec("PRAGMA foreign_keys = ON");

  initializeCoreSchema(db);

  ensureVectorIndexIntegrity(db);
}

/**
 * Verifies that `vectors_vec` and `content_vectors` agree on row count and
 * hash_seq coverage.
 *
 * Behavior:
 *   - On mismatch with KINDX_REPAIR=1 (or callers passing `repair: true`):
 *     truncates both tables so the next embed run rebuilds the vector index.
 *   - On mismatch otherwise: logs a loud warning, records an `error` counter,
 *     and returns. Search continues to operate on what is in the tables; the
 *     operator sees the warning and runs `KINDX_REPAIR=1 kindx ...` (or a
 *     future `kindx repair` subcommand) to rebuild on demand.
 *
 * Auto-truncate was the previous default but the audit found this destroys
 * hours of GPU embedding work on any transient mismatch (interrupted embed,
 * schema upgrade, sharded delete) without consent.
 */
export function ensureVectorIndexIntegrity(
  db: Database,
  opts: { repair?: boolean } = {}
): { mismatch: boolean; rebuilt: boolean; contentCount: number; indexCount: number } {
  const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableCheck) return { mismatch: false, rebuilt: false, contentCount: 0, indexCount: 0 };

  const contentCount = (db.prepare(`SELECT COUNT(*) as c FROM content_vectors`).get() as { c: number } | undefined)?.c ?? 0;
  const indexCount = (db.prepare(`SELECT COUNT(*) as c FROM vectors_vec`).get() as { c: number } | undefined)?.c ?? 0;

  let mismatch = contentCount !== indexCount;

  if (!mismatch && contentCount > 0) {
    try {
      const missingInIndex = db.prepare(`
        SELECT 1 FROM content_vectors
        WHERE NOT EXISTS (
          SELECT 1 FROM vectors_vec
          WHERE vectors_vec.hash_seq = content_vectors.hash || '_' || content_vectors.seq
        ) LIMIT 1
      `).get();
      if (missingInIndex) mismatch = true;
    } catch (e) {
      // SQLite versions that prohibit virtual-table outer joins fail this
      // probe. Surface as a quiet warning so operators can see when the
      // probe is silently skipped — previously this catch was a black hole.
      quietWarn("repository.vec_parity_probe_unsupported", { err: errString(e) });
      // Fallback probe: hash-of-hash_seq from each side, no virtual-table
      // join required. Same row count + same sorted-string fingerprint =
      // same set. Different fingerprints flag the mismatch even on SQLite
      // builds that block vec0 in correlated subqueries.
      try {
        const cvFp = db.prepare(`
          SELECT group_concat(hs) AS fp FROM (
            SELECT hash || '_' || seq AS hs FROM content_vectors ORDER BY hash, seq
          )
        `).get() as { fp: string | null };
        const vvFp = db.prepare(`
          SELECT group_concat(hs) AS fp FROM (
            SELECT hash_seq AS hs FROM vectors_vec ORDER BY hash_seq
          )
        `).get() as { fp: string | null };
        if ((cvFp?.fp ?? "") !== (vvFp?.fp ?? "")) {
          mismatch = true;
        }
      } catch (e2) {
        quietWarn("repository.vec_parity_fallback_probe_failed", { err: errString(e2) });
      }
    }
  }

  if (!mismatch) return { mismatch: false, rebuilt: false, contentCount, indexCount };

  const repairRequested = opts.repair === true || process.env.KINDX_REPAIR === "1";
  if (!repairRequested) {
    quietWarn("repository.vec_parity_mismatch", {
      content_rows: contentCount,
      index_rows: indexCount,
    });
    process.stderr.write(
      `KINDX Warning: vector index parity mismatch (content_vectors=${contentCount}, ` +
      `vectors_vec=${indexCount}). Vector search may return incomplete results until repaired. ` +
      `Re-run with KINDX_REPAIR=1 to rebuild.\n`
    );
    return { mismatch: true, rebuilt: false, contentCount, indexCount };
  }

  process.stderr.write(
    `KINDX Repair: vector index parity mismatch (content_vectors=${contentCount}, ` +
    `vectors_vec=${indexCount}). KINDX_REPAIR=1 set — rebuilding...\n`
  );
  db.exec(`DELETE FROM vectors_vec`);
  db.exec(`DELETE FROM content_vectors`);
  return { mismatch: true, rebuilt: true, contentCount, indexCount };
}

export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable === true;
}

export function ensureVecTableInternal(db: Database, dimensions: number): void {
  if (!_sqliteVecAvailable) {
    throw new Error("sqlite-vec is not available. Vector operations require a SQLite build with extension loading support.");
  }
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasHashSeq = tableInfo.sql.includes('hash_seq');
    const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasHashSeq && hasCosine) return;
    // Table exists but wrong schema - need to rebuild
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }
  db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
}
