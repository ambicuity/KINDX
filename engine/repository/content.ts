// Extracted from engine/repository.ts as part of W1 decomposition (C5).
// Content-addressable storage and document CRUD operations: hashing, title
// extraction, inserting / updating / deactivating documents, link tracking,
// and orphan cleanup.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { createHash } from "crypto";
import type { Database } from "../runtime.js";
import { quietWarn, errString } from "../utils/quiet-warn.js";

// =============================================================================
// Cleanup helpers
// =============================================================================

/**
 * Remove inactive document records (active = 0).
 * Returns the number of inactive documents deleted.
 */
export function deleteInactiveDocuments(db: Database): number {
  const result = db.prepare(`DELETE FROM documents WHERE active = 0`).run();
  return result.changes;
}

/**
 * Remove orphaned content hashes that are not referenced by any active document.
 * Returns the number of orphaned content hashes deleted.
 */
export function cleanupOrphanedContent(db: Database): number {
  const result = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
      AND hash NOT IN (SELECT DISTINCT hash FROM document_versions)
  `).run();
  return result.changes;
}

/**
 * Remove orphaned vector embeddings that are not referenced by any active document.
 * Returns the number of orphaned embedding chunks deleted.
 */
export function cleanupOrphanedVectors(db: Database): number {
  // Check if vectors_vec table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'
  `).get();

  if (!tableExists) {
    return 0;
  }

  // Count orphaned vectors first
  const countResult = db.prepare(`
    SELECT COUNT(*) as c FROM content_vectors cv
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
    )
  `).get() as { c: number };

  if (countResult.c === 0) {
    return 0;
  }

  // Delete from vectors_vec first
  db.exec(`
    DELETE FROM vectors_vec WHERE hash_seq IN (
      SELECT cv.hash || '_' || cv.seq FROM content_vectors cv
      WHERE NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
      )
    )
  `);

  // Delete from content_vectors
  db.exec(`
    DELETE FROM content_vectors WHERE hash NOT IN (
      SELECT hash FROM documents WHERE active = 1
    )
  `);

  return countResult.c;
}

// =============================================================================
// Document helpers
// =============================================================================

export async function hashContent(content: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

const titleExtractors: Record<string, (content: string) => string | null> = {
  '.md': (content) => {
    const match = content.match(/^##?\s+(.+)$/m);
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title === "📝 Notes" || title === "Notes") {
        const nextMatch = content.match(/^##\s+(.+)$/m);
        if (nextMatch?.[1]) return nextMatch[1].trim();
      }
      return title;
    }
    return null;
  },
  '.org': (content) => {
    const titleProp = content.match(/^#\+TITLE:\s*(.+)$/im);
    if (titleProp?.[1]) return titleProp[1].trim();
    const heading = content.match(/^\*+\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    return null;
  },
};

export function extractTitle(content: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const extractor = titleExtractors[ext];
  if (extractor) {
    const title = extractor(content);
    if (title) return title;
  }
  return filename.replace(/\.[^.]+$/, "").split("/").pop() || filename;
}

// =============================================================================
// Document indexing operations
// =============================================================================

/**
 * Insert content into the content table (content-addressable storage).
 * Uses INSERT OR IGNORE so duplicate hashes are skipped.
 */
export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
}

/**
 * Insert a new document into the documents table.
 * When an existing document's content changes (hash differs), the previous
 * version is preserved in document_versions before the update.
 */
export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string
): void {
  // Snapshot the current record (if any) before the upsert.
  const existing = db.prepare(
    `SELECT id, title, hash, created_at FROM documents WHERE collection = ? AND path = ?`
  ).get(collectionName, path) as { id: number; title: string; hash: string; created_at: string } | undefined;

  if (existing && existing.hash !== hash) {
    // Content changed — archive the previous version.
    db.prepare(`
      INSERT INTO document_versions (document_id, collection, path, title, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(existing.id, collectionName, path, existing.title, existing.hash, existing.created_at);
  }

  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(collection, path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      modified_at = excluded.modified_at,
      active = 1
  `).run(collectionName, path, title, hash, createdAt, modifiedAt);
}

export function upsertDocumentIngestion(
  db: Database,
  collectionName: string,
  path: string,
  payload: {
    format: string;
    extractor: string;
    warnings: string[];
    contentHash: string;
    extractedAt: string;
  }
): void {
  db.prepare(`
    INSERT OR REPLACE INTO document_ingest
      (collection, path, format, extractor, warnings_json, extracted_at, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    collectionName,
    path,
    payload.format,
    payload.extractor,
    JSON.stringify(payload.warnings || []),
    payload.extractedAt,
    payload.contentHash
  );
}

export function upsertDocumentLinks(db: Database, collectionName: string, sourcePath: string, targetPaths: string[]): void {
  // We explicitly wipe any old links from this source first
  db.prepare(`DELETE FROM document_links WHERE collection = ? AND source_path = ?`).run(collectionName, sourcePath);

  if (targetPaths.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO document_links (collection, source_path, target_path)
    VALUES (?, ?, ?)
  `);

  for (const target of targetPaths) {
    stmt.run(collectionName, sourcePath, target);
  }
}

export function getLinkedDocuments(db: Database, collectionName: string, sourcePath: string): string[] {
  const rows = db.prepare(`SELECT target_path FROM document_links WHERE collection = ? AND source_path = ?`)
    .all(collectionName, sourcePath) as { target_path: string }[];
  return rows.map(r => r.target_path);
}

export function getBacklinkedDocuments(db: Database, collectionName: string, targetPath: string): string[] {
  const rows = db.prepare(`SELECT source_path FROM document_links WHERE collection = ? AND target_path = ?`)
    .all(collectionName, targetPath) as { source_path: string }[];
  return rows.map(r => r.source_path);
}

/**
 * Find an active document by collection name and path.
 */
export function findActiveDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string } | null {
  const row = db.prepare(`
    SELECT id, hash, title FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as { id: number; hash: string; title: string } | undefined;
  return row ?? null;
}

/**
 * Update the title and modified_at timestamp for a document.
 */
export function updateDocumentTitle(
  db: Database,
  documentId: number,
  title: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, modified_at = ? WHERE id = ?`)
    .run(title, modifiedAt, documentId);
}

/**
 * Update an existing document's hash, title, and modified_at timestamp.
 * Used when content changes but the file path stays the same.
 * When the content hash changes, the previous version is preserved in document_versions.
 */
export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string
): void {
  // Snapshot the current record before the update.
  const existing = db.prepare(
    `SELECT id, collection, path, title, hash, created_at FROM documents WHERE id = ?`
  ).get(documentId) as { id: number; collection: string; path: string; title: string; hash: string; created_at: string } | undefined;

  if (existing && existing.hash !== hash) {
    // Content changed — archive the previous version.
    db.prepare(`
      INSERT INTO document_versions (document_id, collection, path, title, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(existing.id, existing.collection, existing.path, existing.title, existing.hash, existing.created_at);
  }

  db.prepare(`UPDATE documents SET title = ?, hash = ?, modified_at = ? WHERE id = ?`)
    .run(title, hash, modifiedAt, documentId);
}

/**
 * Deactivate a document (mark as inactive but don't delete).
 */
export function deactivateDocument(db: Database, collectionName: string, path: string): void {
  const res = db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ? AND active = 1`)
    .run(collectionName, path);

  if (res.changes > 0) {
    // Schedule asynchronous GC for unreferenced vectors to prevent index bloat.
    setTimeout(() => {
      try { cleanupOrphanedVectors(db); }
      catch (e) { quietWarn("repository.cleanup_orphaned_vectors_failed", { err: errString(e) }); }
    }, 0);
  }
}

/**
 * Get all active document paths for a collection.
 */
export function getActiveDocumentPaths(db: Database, collectionName: string): string[] {
  const rows = db.prepare(`
    SELECT path FROM documents WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];
  return rows.map(r => r.path);
}

// =============================================================================
// Document version history
// =============================================================================

/**
 * Get all version history for a document, newest first.
 * Includes both archived versions and the current active version
 * (the active version is returned as the final entry in the result set,
 * with created_at = documents.modified_at for consistency).
 */
export function getDocumentVersions(
  db: Database,
  collectionName: string,
  path: string
): { versionId: number; title: string; hash: string; createdAt: string }[] {
  // Archived versions from document_versions (newest first).
  const archived = db.prepare(`
    SELECT id AS versionId, title, hash, created_at AS createdAt
    FROM document_versions
    WHERE collection = ? AND path = ?
    ORDER BY created_at DESC
  `).all(collectionName, path) as { versionId: number; title: string; hash: string; createdAt: string }[];

  // Current active version (if it exists).
  const current = db.prepare(`
    SELECT id, title, hash, modified_at AS createdAt
    FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as { id: number; title: string; hash: string; createdAt: string } | undefined;

  const result: { versionId: number; title: string; hash: string; createdAt: string }[] = [];
  if (current) {
    result.push({ versionId: current.id, title: current.title, hash: current.hash, createdAt: current.createdAt });
  }
  // Prepend archived versions (already DESC) before the current version.
  result.push(...archived);

  // De-duplicate by hash — keep the first occurrence (most recent).
  const seen = new Set<string>();
  return result.filter(r => {
    if (seen.has(r.hash)) return false;
    seen.add(r.hash);
    return true;
  });
}

/**
 * Get document content as it existed at a specific ISO timestamp.
 * Finds the most recent version whose created_at <= timestamp,
 * or falls back to the current active document if no version precedes the timestamp.
 */
export function getDocumentAtTime(
  db: Database,
  collectionName: string,
  path: string,
  timestamp: string
): { title: string; hash: string; body: string; createdAt: string } | null {
  // 1. Try the archived versions (most recent before or at timestamp).
  const version = db.prepare(`
    SELECT title, hash, created_at AS createdAt
    FROM document_versions
    WHERE collection = ? AND path = ? AND created_at <= ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(collectionName, path, timestamp) as { title: string; hash: string; createdAt: string } | undefined;

  if (version) {
    const body = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(version.hash) as { doc: string } | undefined;
    if (body) return { title: version.title, hash: version.hash, body: body.doc, createdAt: version.createdAt };
  }

  // 2. Fall back to the current active document if its created_at <= timestamp.
  const current = db.prepare(`
    SELECT d.title, d.hash, d.created_at AS createdAt, c.doc AS body
    FROM documents d
    JOIN content c ON c.hash = d.hash
    WHERE d.collection = ? AND d.path = ? AND d.active = 1 AND d.created_at <= ?
  `).get(collectionName, path, timestamp) as { title: string; hash: string; body: string; createdAt: string } | undefined;

  return current ?? null;
}

/**
 * Find document metadata (without body) at a point in time.
 * Same logic as getDocumentAtTime but does not fetch the content body.
 */
export function findDocumentAtTime(
  db: Database,
  collectionName: string,
  path: string,
  timestamp: string
): { title: string; hash: string; createdAt: string } | null {
  const version = db.prepare(`
    SELECT title, hash, created_at AS createdAt
    FROM document_versions
    WHERE collection = ? AND path = ? AND created_at <= ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(collectionName, path, timestamp) as { title: string; hash: string; createdAt: string } | undefined;

  if (version) return version;

  const current = db.prepare(`
    SELECT title, hash, created_at AS createdAt
    FROM documents
    WHERE collection = ? AND path = ? AND active = 1 AND created_at <= ?
  `).get(collectionName, path, timestamp) as { title: string; hash: string; createdAt: string } | undefined;

  return current ?? null;
}
