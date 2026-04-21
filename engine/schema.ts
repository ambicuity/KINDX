import type { Database } from "./runtime.js";
import { initializeMemorySchema } from "./memory.js";
import { initializeAuditSchema } from "./audit.js";

export function initializeCoreSchema(db: Database): void {
  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

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

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.exec(`DROP TABLE IF EXISTS content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
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

  // Audit logging subsystem — append-only operation log.
  initializeAuditSchema(db);

  const now = new Date().toISOString();
  const setCapability = db.prepare(`
    INSERT OR REPLACE INTO index_capabilities (capability, value, updated_at)
    VALUES (?, ?, ?)
  `);
  setCapability.run("ann", "centroid-v1", now);
  setCapability.run("encryption", process.env.KINDX_ENCRYPTION_KEY ? "keyed-runtime" : "none", now);
  setCapability.run("extractors", "native-text+pdf-docx-adapter-v1", now);
}
