/**
 * specs/backup.test.ts
 *
 * Unit tests for engine/backup.ts - Database backup and restore operations.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema } from "../engine/schema.js";
import {
  createBackup,
  verifyBackup,
  restoreBackup,
} from "../engine/backup.js";

describe("backup", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-backup-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("createBackup", () => {
    test("creates backup file", async () => {
      const dbPath = join(testDir, "test.sqlite");
      const backupPath = join(testDir, "backup.sqlite");

      const db = openDatabase(dbPath);
      initializeCoreSchema(db);
      db.close();

      const result = createBackup(dbPath, backupPath);

      expect(result.backupPath).toBe(backupPath);
      expect(result.bytes).toBeGreaterThan(0);
      expect(existsSync(backupPath)).toBe(true);
    });

    test("creates parent directories", async () => {
      const dbPath = join(testDir, "test.sqlite");
      const backupPath = join(testDir, "subdir", "backup.sqlite");

      const db = openDatabase(dbPath);
      initializeCoreSchema(db);
      db.close();

      const result = createBackup(dbPath, backupPath);

      expect(existsSync(backupPath)).toBe(true);
    });

    test("detects encryption state", async () => {
      const dbPath = join(testDir, "test.sqlite");
      const backupPath = join(testDir, "backup.sqlite");

      const db = openDatabase(dbPath);
      initializeCoreSchema(db);
      db.close();

      const result = createBackup(dbPath, backupPath);

      expect(result.encrypted).toBe(false);
    });
  });

  describe("verifyBackup", () => {
    test("verifies valid backup", async () => {
      const dbPath = join(testDir, "test.sqlite");
      const backupPath = join(testDir, "backup.sqlite");

      const db = openDatabase(dbPath);
      initializeCoreSchema(db);
      db.close();

      createBackup(dbPath, backupPath);
      const result = verifyBackup(backupPath);

      expect(result.exists).toBe(true);
      expect(result.integrity).toBe("ok");
      expect(result.bytes).toBeGreaterThan(0);
    });

    test("returns failed for non-existent backup", () => {
      const result = verifyBackup(join(testDir, "nonexistent.sqlite"));

      expect(result.exists).toBe(false);
      expect(result.integrity).toBe("failed");
      expect(result.detail).toBe("file_not_found");
    });
  });

  describe("restoreBackup", () => {
    test("restores backup to target", async () => {
      const dbPath = join(testDir, "test.sqlite");
      const backupPath = join(testDir, "backup.sqlite");
      const restorePath = join(testDir, "restored.sqlite");

      const db = openDatabase(dbPath);
      initializeCoreSchema(db);
      db.close();

      createBackup(dbPath, backupPath);
      const result = restoreBackup(backupPath, restorePath);

      expect(result.restoredTo).toBe(restorePath);
      expect(existsSync(restorePath)).toBe(true);
    });

    test("throws when backup not found", () => {
      expect(() => restoreBackup(
        join(testDir, "nonexistent.sqlite"),
        join(testDir, "restored.sqlite")
      )).toThrow("Backup not found");
    });

    test("throws when target exists without force", async () => {
      const dbPath = join(testDir, "test.sqlite");
      const backupPath = join(testDir, "backup.sqlite");
      const restorePath = join(testDir, "restored.sqlite");

      const db = openDatabase(dbPath);
      initializeCoreSchema(db);
      db.close();

      createBackup(dbPath, backupPath);
      restoreBackup(backupPath, restorePath);

      expect(() => restoreBackup(backupPath, restorePath)).toThrow("Target already exists");
    });

    test("overwrites target with force", async () => {
      const dbPath = join(testDir, "test.sqlite");
      const backupPath = join(testDir, "backup.sqlite");
      const restorePath = join(testDir, "restored.sqlite");

      const db = openDatabase(dbPath);
      initializeCoreSchema(db);
      db.close();

      createBackup(dbPath, backupPath);
      restoreBackup(backupPath, restorePath);
      const result = restoreBackup(backupPath, restorePath, true);

      expect(result.restoredTo).toBe(restorePath);
    });
  });
});
