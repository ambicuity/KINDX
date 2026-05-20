// Extracted from engine/repository.ts as part of W1 decomposition (C3).
// Database maintenance and health utilities: VACUUM, WAL checkpoint, sidecar
// cleanup, index health probes, and capability lookup.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { existsSync, unlinkSync } from "node:fs";
import type { Database } from "../runtime.js";
import type { IndexHealthInfo } from "./types.js";

export function getHashesNeedingEmbedding(db: Database): number {
  const result = db.prepare(`
    SELECT COUNT(DISTINCT d.hash) as count
    FROM documents d
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
  `).get() as { count: number };
  return result.count;
}

export function getIndexHealth(db: Database): IndexHealthInfo {
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const totalDocs = (db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number }).count;

  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };
  let daysStale: number | null = null;
  if (mostRecent?.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    daysStale = Math.floor((Date.now() - lastUpdate.getTime()) / (24 * 60 * 60 * 1000));
  }

  return { needsEmbedding, totalDocs, daysStale };
}

/**
 * Run VACUUM to reclaim unused space in the database.
 * This operation rebuilds the database file to eliminate fragmentation.
 */
export function vacuumDatabase(db: Database): void {
  db.exec(`VACUUM`);
}

export function walCheckpointTruncate(db: Database): boolean {
  try {
    db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    return true;
  } catch {
    return false;
  }
}

export function cleanupSqliteSidecars(dbPath: string): {
  walRemoved: boolean;
  shmRemoved: boolean;
  lockedFiles: string[];
} {
  const lockedFiles: string[] = [];
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  let walRemoved = false;
  let shmRemoved = false;

  for (const file of [walPath, shmPath]) {
    if (!existsSync(file)) continue;
    try {
      unlinkSync(file);
      if (file === walPath) walRemoved = true;
      if (file === shmPath) shmRemoved = true;
    } catch {
      lockedFiles.push(file);
    }
  }

  return { walRemoved, shmRemoved, lockedFiles };
}

export function getIndexCapabilities(db: Database): Record<string, string> {
  const hasCapsTable = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type='table' AND name='index_capabilities'
  `).get() as { name?: string } | undefined;
  if (!hasCapsTable?.name) {
    return {
      ann: "centroid-v1",
      encryption: process.env.KINDX_ENCRYPTION_KEY ? "keyed-runtime" : "none",
      extractors: "native-text+pdf-docx-adapter-v1",
    };
  }
  const rows = db.prepare(`
    SELECT capability, value
    FROM index_capabilities
    ORDER BY capability
  `).all() as Array<{ capability: string; value: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.capability] = row.value;
  return out;
}
