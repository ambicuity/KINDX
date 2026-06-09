/**
 * specs/diagnostics.test.ts
 *
 * Unit tests for engine/diagnostics.ts - Database and system diagnostics.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema } from "../engine/schema.js";
import {
  checkDatabaseIntegrity,
  checkWalHealth,
  getDefaultBackupName,
} from "../engine/diagnostics.js";
import type { Database } from "../engine/runtime.js";

describe("diagnostics", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initializeCoreSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("checkDatabaseIntegrity", () => {
    test("returns ok for healthy database", () => {
      const result = checkDatabaseIntegrity(db);
      expect(result.ok).toBe(true);
      expect(result.result).toBe("ok");
    });

    test("returns result string", () => {
      const result = checkDatabaseIntegrity(db);
      expect(typeof result.result).toBe("string");
      expect(result.result.length).toBeGreaterThan(0);
    });
  });

  describe("checkWalHealth", () => {
    test("returns journal mode", () => {
      const result = checkWalHealth(db);
      expect(typeof result.journalMode).toBe("string");
      expect(result.journalMode.length).toBeGreaterThan(0);
    });

    test("detects non-WAL mode", () => {
      const result = checkWalHealth(db);
      expect(result.walHealthy).toBe(result.journalMode === "wal");
    });
  });

  describe("getDefaultBackupName", () => {
    test("generates backup name from index path", () => {
      const name = getDefaultBackupName("/path/to/index.sqlite");
      expect(name).toMatch(/^index\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*\.sqlite$/);
    });

    test("handles path without .sqlite extension", () => {
      const name = getDefaultBackupName("/path/to/database");
      expect(name).toMatch(/^database\.backup\./);
    });

    test("uses 'index' as default stem", () => {
      const name = getDefaultBackupName("/path/to/.sqlite");
      expect(name).toMatch(/^index\.backup\./);
    });
  });
});
