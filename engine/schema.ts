import type { Database } from "./runtime.js";
import { initializeMemorySchema, initializeMemoryFeedbackSchema } from "./memory.js";
import { initializeAuditSchema } from "./audit.js";
import { initializeAiUsageSchema } from "./ai-usage.js";
import { KINDX_SCHEMA_VERSION, getUserVersion, setUserVersion } from "./utils/schema-version.js";
import { quietWarn } from "./utils/quiet-warn.js";

export function initializeCoreSchema(db: Database): void {
  const currentVersion = getUserVersion(db);
  // Schema version 0 = legacy / fresh DB. Version 1 = post-YAML-migration.
  // The legacy `path_contexts` and `collections` tables were superseded by
  // ~/.config/kindx/index.yml in v1.0. Drop them ONCE during the v0 -> v1
  // transition, after warning if they hold any rows. Previously this DROP
  // ran on every initialization, silently destroying any user data that
  // happened to exist in those tables.
  if (currentVersion < 1) {
    dropLegacyV0Tables(db);
  }

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/kindx/index.yml
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Document Link Graph - tracks internal cross-references
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_links (
      collection TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      PRIMARY KEY (collection, source_path, target_path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(collection, target_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_document_links_source ON document_links(collection, source_path)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Index capability metadata (used for runtime compatibility and diagnostics)
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_capabilities (
      capability TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Ingestion diagnostics per document path.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_ingest (
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      format TEXT NOT NULL,
      extractor TEXT NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      extracted_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (collection, path)
    )
  `);

  // Content vectors. Earlier schema lacked the `seq` column. The destructive
  // DROP path below loses every persisted embedding so it is gated on the
  // version-zero migration window only — operators who hit this on a populated
  // index see a counter-tracked warning and the existing tables are kept,
  // letting them recover with `KINDX_REPAIR=1` rather than silently losing
  // hours of GPU work on every startup.
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    if (currentVersion < 1) {
      db.exec(`DROP TABLE IF EXISTS content_vectors`);
      db.exec(`DROP TABLE IF EXISTS vectors_vec`);
    } else {
      quietWarn("schema.legacy_content_vectors_seq_missing", { current_version: currentVersion });
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
    BEGIN
      -- Always delete old FTS entry first (FTS5 does not cleanly support INSERT OR REPLACE)
      DELETE FROM documents_fts WHERE rowid = old.id;

      -- Insert new FTS entry if active
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  // Agent memory subsystem (m13v-style), scoped by namespace.
  initializeMemorySchema(db);
  initializeMemoryFeedbackSchema(db);

  // Audit logging subsystem — append-only operation log.
  initializeAuditSchema(db);

  // AI usage ledger — immutable per-call token consumption tracking.
  initializeAiUsageSchema(db);

  const now = new Date().toISOString();
  const setCapability = db.prepare(`
    INSERT OR REPLACE INTO index_capabilities (capability, value, updated_at)
    VALUES (?, ?, ?)
  `);
  setCapability.run("ann", "centroid-v1", now);
  setCapability.run("encryption", process.env.KINDX_ENCRYPTION_KEY ? "keyed-runtime" : "none", now);
  setCapability.run("extractors", "native-text+pdf-docx-adapter-v1", now);

  // Stamp schema version so future startups skip the v0 migration window.
  if (currentVersion < KINDX_SCHEMA_VERSION) {
    setUserVersion(db, KINDX_SCHEMA_VERSION);
  }
}

/**
 * v0 -> v1 migration: drop the legacy `path_contexts` and `collections`
 * tables that were superseded by ~/.config/kindx/index.yml. Pre-emptively
 * warns if either table holds any rows so an operator notices before data
 * is gone.
 */
function dropLegacyV0Tables(db: Database): void {
  for (const table of ["path_contexts", "collections"] as const) {
    try {
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table);
      if (!exists) continue;
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      if (row.c > 0) {
        quietWarn("schema.dropping_legacy_table_with_rows", {
          table,
          row_count: row.c,
        });
        process.stderr.write(
          `KINDX Migration: dropping legacy table "${table}" (had ${row.c} rows). ` +
          `Collections / contexts now live in ~/.config/kindx/index.yml.\n`
        );
      }
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch (e) {
      quietWarn("schema.legacy_table_drop_failed", {
        table,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
