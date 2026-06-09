/**
 * specs/helpers/db-helpers.ts
 *
 * Shared SQLite test-database helpers extracted from specs/mcp.test.ts.
 * Creates the full KINDX schema (content, documents, content_vectors, FTS,
 * vec0) on an already-opened Database handle and seeds arbitrary collections.
 *
 * specs/mcp.test.ts retains its inline copy pending a follow-up migration.
 */

import { loadSqliteVec } from "../../engine/runtime.js";
import type { Database } from "../../engine/runtime.js";

export function initTestDatabase(db: Database): void {
  loadSqliteVec(db);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

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

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      name, body,
      content='documents',
      content_rowid='id',
      tokenize='porter unicode61'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, name, body)
      SELECT new.id, new.path, content.doc
      FROM content
      WHERE content.hash = new.hash;
    END
  `);

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine)`);
}

export function seedCollection(
  db: Database,
  collection: string,
  docs: { path: string; title: string; body: string }[],
): void {
  const now = new Date().toISOString();
  for (const doc of docs) {
    const hash = `${collection}-${doc.path}`;
    db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
      .run(hash, doc.body, now);
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(collection, doc.path, doc.title, hash, now, now);
  }
}
