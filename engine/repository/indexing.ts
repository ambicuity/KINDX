// Extracted from engine/repository.ts as part of W1 decomposition (C15).
// Single-file index / unlink operations used by the file-watcher integration.
// These wrap the content-CRUD primitives in repository/content.ts with file IO
// (statSync, ingestion, link extraction) and a write transaction.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { statSync } from "node:fs";
import { createHash } from "crypto";
import type { Database } from "../runtime.js";
import { ingestFile } from "../ingestion.js";
import { extractInternalLinks } from "../link-extractor.js";
import { storeDocumentSchema } from "../schema.js";
import {
  extractTitle,
  findActiveDocument,
  insertContent,
  insertDocument,
  updateDocument,
  upsertDocumentIngestion,
  upsertDocumentLinks,
  deactivateDocument,
} from "./content.js";
// handelize is still defined in engine/repository.ts; import it back through
// the parent module. This is the cross-cluster pattern used while migration
// is in progress.
import { handelize } from "../repository.js";

export async function indexSingleFile(
  db: Database,
  collectionName: string,
  relativePath: string,
  absolutePath: string
): Promise<"embedded" | "unchanged" | "failed"> {
  try {
    const stat = statSync(absolutePath);
    const path = handelize(relativePath);
    const ingested = await ingestFile(absolutePath);
    const content = ingested.text;

    // Match full-index behavior: skip empty or unsupported payloads.
    if (!content.trim()) {
      return "unchanged";
    }

    const hash = createHash("sha256").update(content).digest("hex");
    const title = extractTitle(content, relativePath);

    // Check if unchanged
    const activeDoc = findActiveDocument(db, collectionName, path);
    if (activeDoc && activeDoc.hash === hash) {
      return "unchanged";
    }

    const now = new Date().toISOString();
    const modifiedAt = stat.mtime.toISOString();

    // Tier-0-11: Pre-compute everything BEFORE opening the write txn.
    // The previous code did `db.exec("BEGIN")` then `await import(
    // "./link-extractor.js")` and the link extraction inside the open txn.
    // Yielding the event loop with a write txn open meant other watcher
    // callbacks for parallel files hit SQLITE_BUSY and starved (or worse,
    // the busy_timeout raced with WAL recovery). The import is now static
    // and link extraction runs synchronously before BEGIN, so the txn
    // body holds the write lock for microseconds, not milliseconds.
    const links = extractInternalLinks(content, relativePath);

    db.exec("BEGIN TRANSACTION");
    try {
      insertContent(db, hash, content, now);
      if (activeDoc) {
        // Delete old vectors if hash changed
        db.prepare(`DELETE FROM content_vectors WHERE hash = ?`).run(activeDoc.hash);
        updateDocument(db, activeDoc.id, title, hash, modifiedAt);
      } else {
        insertDocument(db, collectionName, path, title, hash, now, modifiedAt);
      }
      upsertDocumentIngestion(db, collectionName, path, {
        format: ingested.metadata.format,
        extractor: ingested.metadata.extractor,
        warnings: ingested.warnings,
        contentHash: hash,
        extractedAt: now,
      });
      upsertDocumentLinks(db, collectionName, path, links);

      // Store schema for CSV/JSON files
      if (ingested.metadata.format === "csv" || ingested.metadata.format === "json") {
        try {
          const schemaMatch = ingested.text.match(/Schema:\s*([^\n]+)/);
          if (schemaMatch && schemaMatch[1]) {
            const schema: Record<string, string> = {};
            for (const pair of schemaMatch[1].split(",")) {
              const [key, type] = pair.split(":").map(s => s.trim());
              if (key && type) schema[key] = type;
            }
            if (Object.keys(schema).length > 0) {
              storeDocumentSchema(db, collectionName, path, schema);
            }
          }
        } catch { /* schema storage is best-effort */ }
      }

      db.exec("COMMIT");
      return "embedded"; // Properly enqueued for BM25 and embedding
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } catch (err) {
    console.error(`Failed to index ${relativePath}:`, err);
    return "failed";
  }
}

export async function unlinkSingleFile(
  db: Database,
  collectionName: string,
  relativePath: string
): Promise<boolean> {
  try {
    const path = handelize(relativePath);
    deactivateDocument(db, collectionName, path);
    return true;
  } catch (err) {
    return false;
  }
}
