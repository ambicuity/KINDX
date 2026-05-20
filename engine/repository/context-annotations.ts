// Extracted from engine/repository.ts as part of W1 decomposition (C8).
// Context annotation helpers — thin wrappers over catalogs.js for the
// per-collection / per-path-prefix context system.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import type { Database } from "../runtime.js";
import {
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  listAllContexts as collectionsListAllContexts,
  getCollection,
  listCollections as collectionsListCollections,
  setGlobalContext,
  loadConfig as collectionsLoadConfig,
} from "../catalogs.js";

/**
 * Get the effective context for a (collection, path) pair by combining the
 * global context with all matching path-prefix contexts (most general first).
 */
export function getContextForPath(db: Database, collectionName: string, path: string): string | null {
  const config = collectionsLoadConfig();
  const coll = getCollection(collectionName);

  if (!coll) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  if (config.global_context) {
    contexts.push(config.global_context);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

/**
 * Insert or update a context for a specific collection and path prefix.
 */
export function insertContext(db: Database, collectionId: number, pathPrefix: string, context: string): void {
  // Get collection name from ID
  const coll = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId) as { name: string } | null;
  if (!coll) {
    throw new Error(`Collection with id ${collectionId} not found`);
  }

  // Use catalogs.ts to add context
  collectionsAddContext(coll.name, pathPrefix, context);
}

/**
 * Delete a context for a specific collection and path prefix.
 * Returns the number of contexts deleted.
 */
export function deleteContext(db: Database, collectionName: string, pathPrefix: string): number {
  // Use catalogs.ts to remove context
  const success = collectionsRemoveContext(collectionName, pathPrefix);
  return success ? 1 : 0;
}

/**
 * Delete all global contexts (contexts with empty path_prefix).
 * Returns the number of contexts deleted.
 */
export function deleteGlobalContexts(db: Database): number {
  let deletedCount = 0;

  // Remove global context
  setGlobalContext(undefined);
  deletedCount++;

  // Remove root context (empty string) from all collections
  const collections = collectionsListCollections();
  for (const coll of collections) {
    const success = collectionsRemoveContext(coll.name, '');
    if (success) {
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * List all contexts, grouped by collection.
 * Returns contexts ordered by collection name, then by path prefix length (longest first).
 */
export function listPathContexts(db: Database): { collection_name: string; path_prefix: string; context: string }[] {
  const allContexts = collectionsListAllContexts();

  // Convert to expected format and sort
  return allContexts.map(ctx => ({
    collection_name: ctx.collection,
    path_prefix: ctx.path,
    context: ctx.context,
  })).sort((a, b) => {
    // Sort by collection name first
    if (a.collection_name !== b.collection_name) {
      return a.collection_name.localeCompare(b.collection_name);
    }
    // Then by path prefix length (longest first)
    if (a.path_prefix.length !== b.path_prefix.length) {
      return b.path_prefix.length - a.path_prefix.length;
    }
    // Then alphabetically
    return a.path_prefix.localeCompare(b.path_prefix);
  });
}

/**
 * Check which collections don't have any context defined.
 * Returns collections that have no context entries at all (not even root context).
 */
export function getCollectionsWithoutContext(db: Database): { name: string; pwd: string; doc_count: number }[] {
  // Get all collections from YAML config
  const yamlCollections = collectionsListCollections();

  // Filter to those without context
  const collectionsWithoutContext: { name: string; pwd: string; doc_count: number }[] = [];

  for (const coll of yamlCollections) {
    // Check if collection has any context
    if (!coll.context || Object.keys(coll.context).length === 0) {
      // Get doc count from database
      const stats = db.prepare(`
        SELECT COUNT(d.id) as doc_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { doc_count: number } | null;

      collectionsWithoutContext.push({
        name: coll.name,
        pwd: coll.path,
        doc_count: stats?.doc_count || 0,
      });
    }
  }

  return collectionsWithoutContext.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get top-level directories in a collection that don't have context.
 * Useful for suggesting where context might be needed.
 */
export function getTopLevelPathsWithoutContext(db: Database, collectionName: string): string[] {
  // Get all paths in the collection from database
  const paths = db.prepare(`
    SELECT DISTINCT path FROM documents
    WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];

  // Get existing contexts for this collection from YAML
  const yamlColl = getCollection(collectionName);
  if (!yamlColl) return [];

  const contextPrefixes = new Set<string>();
  if (yamlColl.context) {
    for (const prefix of Object.keys(yamlColl.context)) {
      contextPrefixes.add(prefix);
    }
  }

  // Extract top-level directories (first path component)
  const topLevelDirs = new Set<string>();
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const dir = parts[0];
      if (dir) topLevelDirs.add(dir);
    }
  }

  // Filter out directories that already have context (exact or parent)
  const missing: string[] = [];
  for (const dir of topLevelDirs) {
    let hasContext = false;

    // Check if this dir or any parent has context
    for (const prefix of contextPrefixes) {
      if (prefix === '' || prefix === dir || dir.startsWith(prefix + '/')) {
        hasContext = true;
        break;
      }
    }

    if (!hasContext) {
      missing.push(dir);
    }
  }

  return missing.sort();
}
