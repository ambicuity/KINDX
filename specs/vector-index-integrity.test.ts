/**
 * Regression: vector index integrity must NOT auto-truncate by default.
 *
 * The previous behavior of `ensureVectorIndexIntegrity` silently DELETEd
 * `vectors_vec` and `content_vectors` whenever row counts disagreed. This
 * destroyed hours of GPU embedding work on any transient mismatch
 * (interrupted embed run, schema upgrade, sharded delete) without consent.
 *
 * Default: log + count + return.
 * KINDX_REPAIR=1 (or `repair: true`): rebuild as before.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { ensureVectorIndexIntegrity } from "../engine/repository.js";
import { resetQuietWarnForTests, getQuietWarnCount } from "../engine/utils/quiet-warn.js";

function makeMismatchedDb(): Database.Database {
  const db = new Database(":memory:");
  // Minimal schema that mimics the production tables enough for the parity probe.
  db.exec(`CREATE TABLE content_vectors (hash TEXT, seq INTEGER, embedding BLOB)`);
  // Use a regular table named vectors_vec to mimic the virtual table shape; the
  // parity check only looks at row count and (optionally) hash_seq column existence.
  db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT, embedding BLOB)`);
  // Insert content rows but NOT vector rows -> count mismatch.
  db.prepare(`INSERT INTO content_vectors VALUES (?, ?, ?)`).run("h1", 0, Buffer.alloc(8));
  db.prepare(`INSERT INTO content_vectors VALUES (?, ?, ?)`).run("h2", 0, Buffer.alloc(8));
  return db;
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetQuietWarnForTests();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  delete process.env.KINDX_REPAIR;
});

afterEach(() => {
  stderrSpy.mockRestore();
  delete process.env.KINDX_REPAIR;
});

describe("ensureVectorIndexIntegrity", () => {
  test("returns no-mismatch when vectors_vec table is absent", () => {
    const db = new Database(":memory:");
    try {
      const r = ensureVectorIndexIntegrity(db);
      expect(r).toEqual({ mismatch: false, rebuilt: false, contentCount: 0, indexCount: 0 });
    } finally { db.close(); }
  });

  test("DEFAULT: refuses to delete on parity mismatch and emits warning", () => {
    const db = makeMismatchedDb();
    try {
      const r = ensureVectorIndexIntegrity(db);
      expect(r.mismatch).toBe(true);
      expect(r.rebuilt).toBe(false);
      expect(r.contentCount).toBe(2);
      expect(r.indexCount).toBe(0);
      // content_vectors still has its rows
      const content = db.prepare(`SELECT COUNT(*) as c FROM content_vectors`).get() as { c: number };
      expect(content.c).toBe(2);
      // Warning logged + counter bumped
      expect(getQuietWarnCount("repository.vec_parity_mismatch")).toBe(1);
      const warnText = stderrSpy.mock.calls.map(c => c[0]).join("");
      expect(warnText).toContain("vector index parity mismatch");
      expect(warnText).toContain("KINDX_REPAIR=1");
    } finally { db.close(); }
  });

  test("KINDX_REPAIR=1 env var: rebuilds (truncates) the tables", () => {
    process.env.KINDX_REPAIR = "1";
    const db = makeMismatchedDb();
    try {
      const r = ensureVectorIndexIntegrity(db);
      expect(r.mismatch).toBe(true);
      expect(r.rebuilt).toBe(true);
      const content = db.prepare(`SELECT COUNT(*) as c FROM content_vectors`).get() as { c: number };
      expect(content.c).toBe(0);
    } finally { db.close(); }
  });

  test("opts.repair: true rebuilds without env var", () => {
    const db = makeMismatchedDb();
    try {
      const r = ensureVectorIndexIntegrity(db, { repair: true });
      expect(r.rebuilt).toBe(true);
      const content = db.prepare(`SELECT COUNT(*) as c FROM content_vectors`).get() as { c: number };
      expect(content.c).toBe(0);
    } finally { db.close(); }
  });

  test("balanced tables produce no mismatch", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE content_vectors (hash TEXT, seq INTEGER, embedding BLOB)`);
      db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT, embedding BLOB)`);
      // Both empty -> no mismatch
      const r = ensureVectorIndexIntegrity(db);
      expect(r.mismatch).toBe(false);
      expect(r.rebuilt).toBe(false);
    } finally { db.close(); }
  });
});
