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
 */
export function listCollections(db: Database): { name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null }[] {
  const collections = collectionsListCollections();

  const result = collections.map(coll => {
    const stats = db.prepare(`
      SELECT
        COUNT(d.id) as doc_count,
        SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active_count,
        MAX(d.modified_at) as last_modified
      FROM documents d
      WHERE d.collection = ?
    `).get(coll.name) as { doc_count: number; active_count: number; last_modified: string | null } | null;

    return {
      name: coll.name,
      pwd: coll.path,
      glob_pattern: coll.pattern,
      doc_count: stats?.doc_count || 0,
      active_count: stats?.active_count || 0,
      last_modified: stats?.last_modified || null,
    };
  });

  return result;
}

/**
 * Remove a collection: delete its documents, clean orphaned content,
 * and remove from YAML config.
 */
export function removeCollection(db: Database, collectionName: string): { deletedDocs: number; cleanedHashes: number } {
  const docResult = db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collectionName);

  const cleanupResult = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
  `).run();

  collectionsRemoveCollection(collectionName);

  return {
    deletedDocs: docResult.changes,
    cleanedHashes: cleanupResult.changes
  };
}

/**
 * Rename a collection in both YAML config and the documents table.
 */
export function renameCollection(db: Database, oldName: string, newName: string): void {
  db.prepare(`UPDATE documents SET collection = ? WHERE collection = ?`)
    .run(newName, oldName);
  collectionsRenameCollection(oldName, newName);
}

/**
 * Get all collections (name only).
 */
export function getAllCollections(db: Database): { name: string }[] {
  const collections = collectionsListCollections();
  return collections.map(c => ({ name: c.name }));
}
