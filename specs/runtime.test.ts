/**
 * specs/runtime.test.ts
 *
 * Unit tests for engine/runtime.ts - Cross-runtime SQLite compatibility layer.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  isBun,
  openDatabase,
  loadSqliteVec,
  getSqliteRuntimeDriverName,
  supportsSqlCipherPragma,
  installSqliteStdoutNoiseFilter,
  type Database,
} from "../engine/runtime.js";

describe("runtime", () => {
  describe("isBun", () => {
    test("is false in Node.js", () => {
      expect(isBun).toBe(false);
    });
  });

  describe("openDatabase", () => {
    let db: Database;

    afterEach(() => {
      if (db) db.close();
    });

    test("creates in-memory database", () => {
      db = openDatabase(":memory:");
      expect(db).toBeDefined();
      expect(db.open).toBe(true);
    });

    test("creates file database", async () => {
      const { mkdtemp, unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const testDir = await mkdtemp(join(tmpdir(), "kindx-runtime-test-"));
      const dbPath = join(testDir, "test.sqlite");

      db = openDatabase(dbPath);
      expect(db).toBeDefined();

      db.close();
      await unlink(dbPath).catch(() => {});
      const { rmdir } = await import("node:fs/promises");
      await rmdir(testDir).catch(() => {});
    });

    test("sets busy_timeout pragma", () => {
      db = openDatabase(":memory:");
      const result = db.pragma?.("busy_timeout", { simple: true });
      expect(result).toBe(30000);
    });

    test("rejects invalid encryption key format", () => {
      const original = process.env.KINDX_ENCRYPTION_KEY;
      try {
        process.env.KINDX_ENCRYPTION_KEY = "short";
        expect(() => openDatabase(":memory:")).toThrow(/KINDX_ENCRYPTION_KEY must be/);
      } finally {
        if (original === undefined) {
          delete process.env.KINDX_ENCRYPTION_KEY;
        } else {
          process.env.KINDX_ENCRYPTION_KEY = original;
        }
      }
    });
  });

  describe("loadSqliteVec", () => {
    test("loads vec extension into database", () => {
      const db = openDatabase(":memory:");
      expect(() => loadSqliteVec(db)).not.toThrow();
      db.close();
    });

    test("enables vec0 virtual table", () => {
      const db = openDatabase(":memory:");
      loadSqliteVec(db);
      db.exec(`
        CREATE VIRTUAL TABLE test_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[4] distance_metric=cosine
        )
      `);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_vec'"
      ).all();
      expect(tables).toHaveLength(1);
      db.close();
    });
  });

  describe("getSqliteRuntimeDriverName", () => {
    test("returns a string", () => {
      const name = getSqliteRuntimeDriverName();
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    });

    test("returns better-sqlite3 or better-sqlite3-multiple-ciphers", () => {
      const name = getSqliteRuntimeDriverName();
      expect(name).toMatch(/^better-sqlite3/);
    });
  });

  describe("supportsSqlCipherPragma", () => {
    test("returns false for plain SQLite database", () => {
      const db = openDatabase(":memory:");
      expect(supportsSqlCipherPragma(db)).toBe(false);
      db.close();
    });
  });

  describe("installSqliteStdoutNoiseFilter", () => {
    test("returns uninstall function", () => {
      const uninstall = installSqliteStdoutNoiseFilter();
      expect(typeof uninstall).toBe("function");
      uninstall();
    });

    test("is idempotent - returns same uninstall on second call", () => {
      const uninstall1 = installSqliteStdoutNoiseFilter();
      const uninstall2 = installSqliteStdoutNoiseFilter();
      expect(uninstall1).toBe(uninstall2);
      uninstall1();
    });

    test("uninstall is safe to call multiple times", () => {
      const uninstall = installSqliteStdoutNoiseFilter();
      uninstall();
      expect(() => uninstall()).not.toThrow();
    });
  });
});
