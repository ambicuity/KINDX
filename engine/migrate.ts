import Database from "better-sqlite3";
import type { Database as SQLiteDatabase } from "better-sqlite3";
import { type Store } from "./repository.js";

import { resolve } from "node:path";
import { createHash } from "node:crypto";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export class ChromaMigrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChromaMigrationError";
    this.code = code;
  }
}

export type ChromaMigrationReport = {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
};

export async function migrateChroma(
  chromaDbPath: string,
  targetCollectionName: string,
  store: Store
): Promise<ChromaMigrationReport> {
  const startMs = Date.now();
  console.log(`\n${c.bold}Migrating from ChromaDB: ${chromaDbPath}${c.reset}`);
  console.log(`Target KINDX Collection: ${c.cyan}${targetCollectionName}${c.reset}`);

  // Tier-0-12: throw rather than process.exit so library consumers (MCP,
  // tests, other CLIs) can catch and report instead of being killed.
  let chromaDb: SQLiteDatabase;
  try {
    chromaDb = new Database(resolve(process.cwd(), chromaDbPath), { readonly: true });
  } catch (err: any) {
    throw new ChromaMigrationError("open_failed", `Failed to open Chroma database: ${err.message}`);
  }

  // Check if it's actually a Chroma database
  try {
    chromaDb.prepare(`SELECT 1 FROM collections LIMIT 1`).get();
    chromaDb.prepare(`SELECT 1 FROM embeddings LIMIT 1`).get();
  } catch {
    throw new ChromaMigrationError(
      "invalid_schema",
      "Invalid Chroma database schema. Missing required tables ('collections' or 'embeddings')."
    );
  }

  // Chroma schema uses `string_value` in `embedding_fulltext` for the raw document text
  // And `embedding_metadata` for `id`, `key`, `string_value` etc.
  
  // Get all documents
  // We'll perform a query to join embeddings, their text, and maybe extract source/path from metadata
  
  const documentsQuery = `
    SELECT 
      e.id as embedding_uuid,
      e.embedding_id as doc_id,
      ef.string_value as document_text,
      c.name as chroma_collection
    FROM embeddings e
    JOIN collections c ON e.collection_id = c.id
    LEFT JOIN embedding_fulltext ef ON ef.rowid = e.rowid
  `;

  let rows: any[] = [];
  try {
    rows = chromaDb.prepare(documentsQuery).all();
  } catch (err: any) {
    // Older chroma schema might map rowid differently or use document instead of string_value. 
    // Let's try to query just embeddings and fetch metadata manually to be safer.
    console.log(`${c.yellow}Warning: Could not perform optimized join. Falling back to sequential reads. (${err.message})${c.reset}`);
    rows = chromaDb.prepare(`SELECT id as embedding_uuid, embedding_id as doc_id, collection_id FROM embeddings`).all();
  }

  if (!rows || rows.length === 0) {
    console.log(`No documents found in ChromaDB.`);
    return { scanned: 0, migrated: 0, skipped: 0, errors: 0, elapsedMs: Date.now() - startMs };
  }

  console.log(`Found ${c.bold}${rows.length}${c.reset} vectors in Chroma.`);

  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  console.log(`Mapping metadata and enqueueing for KINDX target...`);
  
  // Register the collection so it shows up in `kindx ls` and can be queried
  const { addCollection } = await import("./catalogs.js");
  const absoluteDbPath = resolve(process.cwd(), chromaDbPath);
  addCollection(targetCollectionName, absoluteDbPath, "*");

  try {
    for (const row of rows) {
      try {
        // Fetch metadata
        const metadataQuery = chromaDb.prepare(`SELECT key, string_value, int_value FROM embedding_metadata WHERE id = ?`);
        const metadataRows = metadataQuery.all(row.embedding_uuid) as { key: string, string_value: string, int_value: number }[];
        
        let path = row.doc_id; // Default to chroma's doc_id if no path available
        let title = "Chroma Document";
        
        // Some users store path or source
        for (const meta of metadataRows) {
          if (meta.key === 'source' || meta.key === 'path' || meta.key === 'file') {
             path = typeof meta.string_value === 'string' ? meta.string_value : path;
          }
          if (meta.key === 'title') {
             title = typeof meta.string_value === 'string' ? meta.string_value : title;
          }
        }

        // Fetch document text if we didn't get it in the join
        let docText = row.document_text;
        if (!docText) {
          try {
            // Chroma v0.4+ embedding_fulltext
            const ftQuery = chromaDb.prepare(`SELECT string_value FROM embedding_fulltext WHERE rowid = (SELECT rowid FROM embeddings WHERE id = ?)`);
            const ftRes = ftQuery.get(row.embedding_uuid) as { string_value: string } | undefined;
            if (ftRes) docText = ftRes.string_value;
          } catch(e) {}
        }

        if (!docText) docText = `[Imported from Chroma: ${row.doc_id}]`;

        // We will just re-embed these in KINDX to avoid dimension mismatches and ensure FTS sync.
        // Doing raw embedding copy from SQLite blobs is error-prone due to struct packing differences (Chroma uses numpy binary dumps vs sqlite-vec float arrays). 
        // We'll queue them as documents.
        
        const contentHash = createHash("sha256").update(docText).digest("hex");
        const now = new Date().toISOString();

        // Use the Chroma collection name as a prefix to avoid collisions if targetCollectionName is generic
        const normalizedPath = `${row.chroma_collection || 'import'}/${path}`.replace(/[^a-zA-Z0-9/._-]/g, '_');

        // Tier-0-12: idempotency. If we crashed mid-run last time and the
        // user re-invokes the migration, the previous code threw on the
        // UNIQUE(collection, path) constraint and counted every already-
        // migrated row as an error, leaving the run unable to complete.
        // Skip rows whose target document already exists with the same hash.
        const existing = store.findActiveDocument(targetCollectionName, normalizedPath);
        if (existing && existing.hash === contentHash) {
          skippedCount++;
          continue;
        }

        // Insert content (content-addressed by hash; safe to re-run).
        store.insertContent(contentHash, docText, now);

        if (existing) {
          // Same path, different content -> previous import is stale.
          // Without an updateDocument exposed on the Store interface here,
          // skip rather than orphaning the prior row. Operator can rerun
          // after `kindx collection rm` for a clean re-import.
          skippedCount++;
          continue;
        }

        store.insertDocument(
          targetCollectionName,
          normalizedPath,
          title,
          contentHash,
          now,
          now
        );

        migratedCount++;
      } catch (err) {
        errorCount++;
        console.error(`Error migrating row ${row.embedding_uuid}:`, err);
      }
    }
  } catch (error) {
    console.error(`Migration failed: ${error}`);
  }

  const elapsedMs = Date.now() - startMs;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  console.log(`\n${c.bold}Migration Summary${c.reset}`);
  console.log(`  ${c.green}Migrated: ${migratedCount} documents${c.reset}`);
  if (skippedCount > 0) console.log(`  ${c.yellow}Skipped:  ${skippedCount} existing hashes${c.reset}`);
  if (errorCount > 0) console.log(`  ${c.red}Errors:   ${errorCount} failed${c.reset}`);
  console.log(`  Time:     ${elapsed}s`);

  console.log(`\nRun ${c.bold}kindx embed${c.reset} to generate local vectors for the migrated data.`);

  return {
    scanned: rows.length,
    migrated: migratedCount,
    skipped: skippedCount,
    errors: errorCount,
    elapsedMs,
  };
}
