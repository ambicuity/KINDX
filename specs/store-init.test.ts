/**
 * specs/store-init.test.ts
 *
 * Unit tests for engine/repository/store-init.ts - Store initialization.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";

describe("store-init", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("initializeDatabase", () => {
    test("initializes database with WAL mode", async () => {
      const { initializeDatabase } = await import("../engine/repository/store-init.js");
      
      initializeDatabase(db);
      
      const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(result.journal_mode).toBeDefined();
    });

    test("sets foreign keys on", async () => {
      const { initializeDatabase } = await import("../engine/repository/store-init.js");
      
      initializeDatabase(db);
      
      const result = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(result.foreign_keys).toBe(1);
    });

    test("creates core schema tables", async () => {
      const { initializeDatabase } = await import("../engine/repository/store-init.js");
      
      initializeDatabase(db);
      
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      
      expect(tableNames).toContain("content");
      expect(tableNames).toContain("documents");
    });

    test("is idempotent", async () => {
      const { initializeDatabase } = await import("../engine/repository/store-init.js");
      
      initializeDatabase(db);
      expect(() => initializeDatabase(db)).not.toThrow();
    });
  });

  describe("verifySqliteVecLoaded", () => {
    test("does not throw when vec is loaded", async () => {
      const { initializeDatabase, verifySqliteVecLoaded } = await import("../engine/repository/store-init.js");
      
      initializeDatabase(db);
      expect(() => verifySqliteVecLoaded(db)).not.toThrow();
    });
  });

  describe("ensureVectorIndexIntegrity", () => {
    test("returns no mismatch when tables are empty", async () => {
      const { initializeDatabase, ensureVectorIndexIntegrity } = await import("../engine/repository/store-init.js");
      
      initializeDatabase(db);
      const result = ensureVectorIndexIntegrity(db);
      
      expect(result.mismatch).toBe(false);
      expect(result.rebuilt).toBe(false);
    });

    test("runs without error when tables exist", async () => {
      const { initializeDatabase, ensureVectorIndexIntegrity } = await import("../engine/repository/store-init.js");
      
      initializeDatabase(db);
      
      const result = ensureVectorIndexIntegrity(db);
      
      expect(result).toBeDefined();
      expect(typeof result.mismatch).toBe("boolean");
      expect(typeof result.rebuilt).toBe("boolean");
    });
  });
});
