/**
 * Regression: schema initialization must NOT unconditionally drop legacy
 * tables (`path_contexts`, `collections`) on every startup.
 *
 * The previous code ran `DROP TABLE IF EXISTS path_contexts;
 * DROP TABLE IF EXISTS collections;` at the top of `initializeCoreSchema`,
 * deleting any user data still present in those tables on every engine open.
 * The fix gates the drop behind `PRAGMA user_version`: drop happens once
 * during the v0 -> v1 migration window, never again.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeCoreSchema } from "../engine/schema.js";
import { getUserVersion, KINDX_SCHEMA_VERSION } from "../engine/utils/schema-version.js";
import { resetQuietWarnForTests, getQuietWarnCount } from "../engine/utils/quiet-warn.js";

let stderrSpy: any;

beforeEach(() => {
  resetQuietWarnForTests();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("initializeCoreSchema schema-version gate", () => {
  test("fresh DB: stamps user_version to KINDX_SCHEMA_VERSION", () => {
    const db = new Database(":memory:");
    try {
      expect(getUserVersion(db)).toBe(0);
      initializeCoreSchema(db as any);
      expect(getUserVersion(db)).toBe(KINDX_SCHEMA_VERSION);
    } finally { db.close(); }
  });

  test("v0 -> v1: legacy tables ARE dropped during migration window", () => {
    const db = new Database(":memory:");
    try {
      // Simulate a legacy DB with a path_contexts table holding rows.
      db.exec(`CREATE TABLE path_contexts (id INTEGER PRIMARY KEY, ctx TEXT)`);
      db.prepare(`INSERT INTO path_contexts (ctx) VALUES (?)`).run("legacy-1");
      db.exec(`CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT)`);
      db.prepare(`INSERT INTO collections (name) VALUES (?)`).run("legacy-coll");
      // user_version is still 0 (legacy DB).
      expect(getUserVersion(db)).toBe(0);

      initializeCoreSchema(db as any);

      // Legacy tables gone; warning + counter recorded so the operator notices.
      const stillThere = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='path_contexts'`)
        .get();
      expect(stillThere).toBeUndefined();
      expect(getQuietWarnCount("schema.dropping_legacy_table_with_rows")).toBe(2);
      const warnText = stderrSpy.mock.calls.map((c: any[]) => c[0]).join("");
      expect(warnText).toContain("legacy table");
    } finally { db.close(); }
  });

  test("post-v1: legacy tables created AFTER migration are NOT dropped", () => {
    const db = new Database(":memory:");
    try {
      // First initialization stamps version 1.
      initializeCoreSchema(db as any);
      expect(getUserVersion(db)).toBe(KINDX_SCHEMA_VERSION);

      // An operator (or external tool) creates a table with the legacy name
      // post-migration. This must SURVIVE re-initialization — the previous
      // unconditional DROP would silently delete it on every store open.
      db.exec(`CREATE TABLE path_contexts (id INTEGER PRIMARY KEY, important TEXT)`);
      db.prepare(`INSERT INTO path_contexts (important) VALUES (?)`).run("DO NOT DROP");

      initializeCoreSchema(db as any);

      const row = db.prepare(`SELECT important FROM path_contexts`).get() as { important: string };
      expect(row.important).toBe("DO NOT DROP");
    } finally { db.close(); }
  });

  test("re-running initializeCoreSchema is idempotent (no spurious warnings)", () => {
    const db = new Database(":memory:");
    try {
      initializeCoreSchema(db as any);
      resetQuietWarnForTests();
      // Second run: no legacy tables, no warnings, version unchanged.
      initializeCoreSchema(db as any);
      expect(getUserVersion(db)).toBe(KINDX_SCHEMA_VERSION);
      expect(getQuietWarnCount("schema.dropping_legacy_table_with_rows")).toBe(0);
    } finally { db.close(); }
  });

  test("v0 -> v1 with content_vectors lacking 'seq' column: drops it", () => {
    const db = new Database(":memory:");
    try {
      // Old schema: content_vectors without 'seq' column.
      db.exec(`CREATE TABLE content_vectors (hash TEXT, model TEXT)`);
      db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT, embedding BLOB)`);
      // user_version stays 0 -> migration window.
      initializeCoreSchema(db as any);
      const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
      expect(cvInfo.some(c => c.name === 'seq')).toBe(true);
    } finally { db.close(); }
  });

  test("post-v1 with content_vectors lacking 'seq' column: WARNS, does NOT drop", () => {
    const db = new Database(":memory:");
    try {
      // Stamp version 1 first.
      initializeCoreSchema(db as any);
      // Drop the now-correct content_vectors and recreate without 'seq'.
      db.exec(`DROP TABLE IF EXISTS content_vectors`);
      db.exec(`CREATE TABLE content_vectors (hash TEXT, model TEXT)`);
      // Re-initialize. Should NOT drop the user's table (post-v1 protection).
      initializeCoreSchema(db as any);
      // Warning recorded.
      expect(getQuietWarnCount("schema.legacy_content_vectors_seq_missing")).toBe(1);
    } finally { db.close(); }
  });
});
