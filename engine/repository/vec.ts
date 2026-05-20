// Extracted from engine/repository.ts as part of W1 decomposition (C11a).
// Vector search via sqlite-vec — query embedding lookup, sharded fanout,
// and mapping vec matches back to full DocumentResult rows.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../runtime.js";
import type { ILLMSession } from "../inference.js";
import { searchShardedVectorsWithDiagnostics } from "../sharding.js";
import { getDefaultDbPath } from "./paths.js";
import type { SearchResult } from "./types.js";
// These symbols still live in engine/repository.ts. Importing them back via
// the parent module is safe because Node ESM resolves function references
// lazily; nothing here runs at module-load time.
import {
  getContextForFile,
  isSqliteVecAvailable,
  getCollectionShardCount,
  getEmbedding,
  getDocid,
} from "../repository.js";

let _vecUnavailableWarned = false;

export function getMainDatabasePath(db: Database): string {
  const row = db.prepare(`PRAGMA database_list`).all() as Array<{ name: string; file: string }>;
  const main = row.find((r) => r.name === "main");
  return main?.file || getDefaultDbPath();
}

export function mapVectorMatchesToDocuments(
  db: Database,
  vecResults: Array<{ hash_seq: string; distance: number }>,
  limit: number,
  collectionName?: string
): SearchResult[] {
  if (vecResults.length === 0) return [];
  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));

  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT
      cv.hash || '_' || cv.seq as hash_seq,
      cv.hash,
      cv.pos,
      'kindx://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      d.modified_at,
      content.doc as body
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];
  if (collectionName) {
    docSql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  const docRows = db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; filepath: string;
    display_path: string; title: string; modified_at: string; body: string;
  }[];

  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => (a.bestDist - b.bestDist) || a.row.filepath.localeCompare(b.row.filepath))
    .slice(0, limit)
    .map(({ row, bestDist }) => {
      const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
      return {
        filepath: row.filepath,
        displayPath: row.display_path,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName,
        modifiedAt: row.modified_at,
        bodyLength: row.body.length,
        body: row.body,
        context: getContextForFile(db, row.filepath),
        score: 1 - bestDist,
        source: "vec" as const,
        chunkPos: row.pos,
      };
    });
}

export async function searchVec(
  db: Database,
  query: string,
  model: string,
  limit: number = 20,
  collectionName?: string,
  session?: ILLMSession,
  precomputedEmbedding?: number[],
  diagnostics?: { onWarning?: (warning: string) => void }
): Promise<SearchResult[]> {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  const shardCount = getCollectionShardCount(collectionName);
  if (!tableExists && shardCount <= 1) {
    if (!_vecUnavailableWarned) {
      _vecUnavailableWarned = true;
      if (isSqliteVecAvailable() === false) {
        process.stderr.write(
          `[KINDX] ⚠ Vector search unavailable: sqlite-vec extension failed to load. Run 'kindx doctor' for setup guidance.\n`
        );
      } else {
        process.stderr.write(
          `[KINDX] ⚠ Vector search unavailable: no embeddings found. Run 'kindx embed' to generate vectors.\n`
        );
      }
    }
    return [];
  }

  const embedding = precomputedEmbedding ?? await getEmbedding(query, model, true, session);
  if (!embedding) return [];

  // If collection sharding is enabled, fan out over shard DBs and merge top matches.
  if (collectionName && shardCount > 1) {
    const mainDbPath = getMainDatabasePath(db);
    const perShardK = Math.max(4, Math.ceil((limit * 3) / shardCount));
    const shardResult = searchShardedVectorsWithDiagnostics(
      mainDbPath,
      collectionName,
      shardCount,
      new Float32Array(embedding),
      perShardK
    );
    for (const warning of shardResult.warnings) diagnostics?.onWarning?.(warning);
    const shardResults = shardResult.matches;
    if (shardResults.length > 0) {
      return mapVectorMatchesToDocuments(db, shardResults.slice(0, limit * 3), limit, collectionName);
    }
    // fallback to main vectors table if shard results are empty
  }

  if (!tableExists) return [];

  // IMPORTANT: We use a two-step query approach here because sqlite-vec virtual tables
  // hang indefinitely when combined with JOINs in the same query. Do NOT try to
  // "optimize" this by combining into a single query with JOINs - it will break.
  // See: https://github.com/ambicuity/KINDX/pull/23

  // Tier-1 perf: clamp k to KINDX_MAX_VEC_K (default 2000) so a caller
  // passing limit=10000 doesn't ask vec0 to scan 30000 nearest neighbors —
  // sqlite-vec is known to slow down quadratically with k and can OOM at
  // very large k.
  const MAX_VEC_K = (() => {
    const raw = parseInt(process.env.KINDX_MAX_VEC_K || "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 2000;
  })();
  const k = Math.min(limit * 3, MAX_VEC_K);

  // Step 1: Get vector matches from sqlite-vec (no JOINs allowed)
  const vecResults = db.prepare(`
    SELECT hash_seq, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(embedding), k) as { hash_seq: string; distance: number }[];
  return mapVectorMatchesToDocuments(db, vecResults, limit, collectionName);
}
