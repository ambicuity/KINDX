import type { Database } from "./runtime.js";
import { initializeMemorySchema, initializeMemoryFeedbackSchema, initializeMemoryScopeConfigSchema } from "./memory.js";
import { initializeAuditSchema } from "./audit.js";
import { initializeAiUsageSchema } from "./ai-usage.js";
import { KINDX_SCHEMA_VERSION, getUserVersion, setUserVersion } from "./utils/schema-version.js";
import { quietWarn } from "./utils/quiet-warn.js";

/**
 * Forward-only schema migrations. Each entry runs exactly once on databases
 * whose current user_version is < `to`. The runner only stamps user_version
 * after every applicable migration has executed, so bumping
 * KINDX_SCHEMA_VERSION without adding a matching entry here is a hard error
 * instead of silently marking unmigrated databases as up-to-date.
 *
 * Add a new migration as `{ from: N, to: N+1, run(db) { /* ... *\/ } }`.
 */
const SCHEMA_MIGRATIONS: ReadonlyArray<{ from: number; to: number; run: (db: Database) => void }> = [
  {
    from: 0,
    to: 1,
    run(db) {
      // Schema version 0 -> 1: drop the legacy `path_contexts` and `collections`
      // tables superseded by ~/.config/kindx/index.yml in v1.0.
      dropLegacyV0Tables(db);
    },
  },
];

function applyMigrations(db: Database, current: number): number {
  let v = current;
  for (const step of SCHEMA_MIGRATIONS) {
    if (step.from < v || step.to <= v) continue;
    if (step.from !== v) {
      throw new Error(
        `schema: migration step ${step.from}->${step.to} cannot run from current version ${v}; missing intermediate migration.`
      );
    }
    step.run(db);
    setUserVersion(db, step.to);
    v = step.to;
  }
  if (v < KINDX_SCHEMA_VERSION) {
    throw new Error(
      `schema: no migration registered to reach KINDX_SCHEMA_VERSION=${KINDX_SCHEMA_VERSION}; stopped at v${v}. Add an entry to SCHEMA_MIGRATIONS.`
    );
  }
  return v;
}

export function initializeCoreSchema(db: Database): void {
  const currentVersion = getUserVersion(db);
  applyMigrations(db, currentVersion);

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

  // Document versions - tracks historical snapshots of document content
  // Populated automatically when insertDocument/updateDocument detect a content hash change.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE NO ACTION
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_versions_doc_id ON document_versions(document_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_versions_coll_path ON document_versions(collection, path, created_at)`);

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

  // Drop the previous unconditional trigger if it exists so DBs created
  // before the WHEN gate pick up the gated version on next startup.
  db.exec(`DROP TRIGGER IF EXISTS documents_au`);
  db.exec(`
    CREATE TRIGGER documents_au AFTER UPDATE ON documents
    WHEN new.hash IS NOT old.hash
      OR new.title IS NOT old.title
      OR new.active IS NOT old.active
      OR new.collection IS NOT old.collection
      OR new.path IS NOT old.path
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
  initializeMemoryScopeConfigSchema(db);

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
  setCapability.run("extractors", "native-text+pdf-docx-adapter-v1+vision-model+csv-json", now);

  // user_version is already stamped by applyMigrations() at the top of this
  // function — after every registered step ran. No fallback stamp here:
  // bumping KINDX_SCHEMA_VERSION without a matching migration is a hard
  // error rather than a silent version-only bump.
}

export function storeDocumentSchema(
  db: Database,
  collection: string,
  path: string,
  schema: Record<string, string>
): void {
  const schemaJson = JSON.stringify(schema);
  const now = new Date().toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_schemas (
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      schema_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, path)
    )
  `);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO document_schemas (collection, path, schema_json, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(collection, path, schemaJson, now);
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
