// Extracted from engine/repository.ts as part of W1 decomposition (C9).
// Collection registry helpers — thin wrappers over catalogs.js plus DB queries
// for doc counts and rename/delete coordination.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../runtime.js";
import {
  getCollection,
  listCollections as collectionsListCollections,
  removeCollection as collectionsRemoveCollection,
  renameCollection as collectionsRenameCollection,
} from "../catalogs.js";
import { evictRerankController } from "./rerank-queue.js";

/**
 * Get collection by name from YAML config.
 */
export function getCollectionByName(db: Database, name: string): { name: string; pwd: string; glob_pattern: string } | null {
  const collection = getCollection(name);
  if (!collection) return null;

  return {
    name: collection.name,
    pwd: collection.path,
    glob_pattern: collection.pattern,
  };
}

/**
 * List all collections with document counts from database.
 *
 * Uses a single GROUP BY aggregate instead of one stats query per collection
 * (the previous N+1 pattern was visibly slow on large catalogs).
 */
export function listCollections(db: Database): { name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null }[] {
  const collections = collectionsListCollections();
  if (collections.length === 0) return [];

  const stats = db.prepare(`
    SELECT
      collection,
      COUNT(id) AS doc_count,
      SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_count,
      MAX(modified_at) AS last_modified
    FROM documents
    GROUP BY collection
  `).all() as Array<{ collection: string; doc_count: number; active_count: number; last_modified: string | null }>;

  const statsByName = new Map<string, { doc_count: number; active_count: number; last_modified: string | null }>();
  for (const row of stats) {
    statsByName.set(row.collection, {
      doc_count: Number(row.doc_count ?? 0),
      active_count: Number(row.active_count ?? 0),
      last_modified: row.last_modified ?? null,
    });
  }

  return collections.map(coll => {
    const s = statsByName.get(coll.name);
    return {
      name: coll.name,
      pwd: coll.path,
      glob_pattern: coll.pattern,
      doc_count: s?.doc_count ?? 0,
      active_count: s?.active_count ?? 0,
      last_modified: s?.last_modified ?? null,
    };
  });
}

/**
 * Remove a collection: delete its documents (and dependent sibling rows that
 * carry the collection name), clean truly-orphaned content, and remove from
 * YAML config.
 *
 * Orphan cleanup uses the broad "no document references this hash at all"
 * predicate and excludes hashes referenced by document_versions. The narrow
 * "active = 1 only" form previously here had two bugs:
 *   1. It violated the document_versions.hash FK NO ACTION constraint when
 *      version rows still pointed at the deleted content (raising at runtime).
 *   2. Where no version row existed, the FK on documents.hash CASCADE'd and
 *      silently destroyed inactive rows in OTHER collections that happened
 *      to share the content.
 *
 * All statements run in one transaction so a crash mid-remove can't leave
 * dangling rows in document_links / document_versions / document_ingest /
 * document_schemas pointing at a collection name that no longer exists.
 */
export function removeCollection(db: Database, collectionName: string): { deletedDocs: number; cleanedHashes: number } {
  const txn = db.transaction(() => {
    // Sibling rows that carry the collection name need to go first so the
    // orphan-cleanup predicate sees a consistent picture.
    db.prepare(`DELETE FROM document_links WHERE collection = ?`).run(collectionName);
    db.prepare(`DELETE FROM document_ingest WHERE collection = ?`).run(collectionName);
    // document_schemas table may not exist yet (created lazily) — guard.
    const hasSchemas = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_schemas'`
    ).get();
    if (hasSchemas) {
      db.prepare(`DELETE FROM document_schemas WHERE collection = ?`).run(collectionName);
    }
    // Versions for this collection — drop them so their hash references are
    // gone before we orphan-clean content. (Removing the collection also
    // means dropping its history.)
    db.prepare(`DELETE FROM document_versions WHERE collection = ?`).run(collectionName);

    const docResult = db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collectionName);

    const cleanupResult = db.prepare(`
      DELETE FROM content
      WHERE hash NOT IN (SELECT DISTINCT hash FROM documents)
        AND hash NOT IN (SELECT DISTINCT hash FROM document_versions)
    `).run();

    return {
      deletedDocs: Number(docResult.changes ?? 0),
      cleanedHashes: Number(cleanupResult.changes ?? 0),
    };
  });

  const result = txn();
  // YAML mutation happens AFTER the DB transaction commits so an in-flight
  // crash leaves YAML consistent with on-disk DB state. If the YAML write
  // throws after this point, the next startup will rebuild the indexed
  // catalog from YAML and the deleted-collection rows simply stay deleted.
  collectionsRemoveCollection(collectionName);
  // Best-effort: drop the rerank backpressure controller for this collection
  // so a long-running daemon doesn't leak Map entries on churn.
  evictRerankController(collectionName);
  return result;
}

/**
 * Rename a collection in YAML config plus every table that carries a
 * `collection` column. Previously only documents was updated, leaving
 * document_versions / document_links / document_ingest / document_schemas
 * stuck on the old name — getDocumentVersions, getLinkedDocuments and
 * friends would return empty for the renamed collection.
 */
export function renameCollection(db: Database, oldName: string, newName: string): void {
  const txn = db.transaction(() => {
    db.prepare(`UPDATE documents SET collection = ? WHERE collection = ?`).run(newName, oldName);
    db.prepare(`UPDATE document_versions SET collection = ? WHERE collection = ?`).run(newName, oldName);
    db.prepare(`UPDATE document_links SET collection = ? WHERE collection = ?`).run(newName, oldName);
    db.prepare(`UPDATE document_ingest SET collection = ? WHERE collection = ?`).run(newName, oldName);
    const hasSchemas = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_schemas'`
    ).get();
    if (hasSchemas) {
      db.prepare(`UPDATE document_schemas SET collection = ? WHERE collection = ?`).run(newName, oldName);
    }
  });
  txn();
  collectionsRenameCollection(oldName, newName);
  // The rerank controller is keyed by collection name; drop the stale entry
  // so the renamed collection starts with a fresh accounting record.
  evictRerankController(oldName);
}

/**
 * Get all collections (name only).
 */
export function getAllCollections(db: Database): { name: string }[] {
  const collections = collectionsListCollections();
  return collections.map(c => ({ name: c.name }));
}
