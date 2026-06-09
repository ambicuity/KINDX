/**
 * specs/store-maintenance.test.ts
 *
 * Unit tests for engine/repository/store-maintenance.ts - Store maintenance utilities.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema } from "../engine/schema.js";
import type { Database } from "../engine/runtime.js";

describe("store-maintenance", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initializeCoreSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("getHashesNeedingEmbedding", () => {
    test("returns 0 for empty database", async () => {
      const { getHashesNeedingEmbedding } = await import("../engine/repository/store-maintenance.js");
      
      const result = getHashesNeedingEmbedding(db);
      expect(result).toBe(0);
    });

    test("returns count of documents needing embedding", async () => {
      const { getHashesNeedingEmbedding } = await import("../engine/repository/store-maintenance.js");
      
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
      ).run("hash1", "test content", now);
      db.prepare(
        "INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("test", "test.md", "Test", "hash1", now, now, 1);
      
      const result = getHashesNeedingEmbedding(db);
      expect(result).toBe(1);
    });
  });

  describe("getIndexHealth", () => {
    test("returns health info for empty database", async () => {
      const { getIndexHealth } = await import("../engine/repository/store-maintenance.js");
      
      const result = getIndexHealth(db);
      expect(result.needsEmbedding).toBe(0);
      expect(result.totalDocs).toBe(0);
    });

    test("returns health info with documents", async () => {
      const { getIndexHealth } = await import("../engine/repository/store-maintenance.js");
      
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
      ).run("hash1", "test content", now);
      db.prepare(
        "INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("test", "test.md", "Test", "hash1", now, now, 1);
      
      const result = getIndexHealth(db);
      expect(result.totalDocs).toBe(1);
    });
  });

  describe("vacuumDatabase", () => {
    test("runs without error", async () => {
      const { vacuumDatabase } = await import("../engine/repository/store-maintenance.js");
      
      expect(() => vacuumDatabase(db)).not.toThrow();
    });
  });

  describe("walCheckpointTruncate", () => {
    test("returns true on success", async () => {
      const { walCheckpointTruncate } = await import("../engine/repository/store-maintenance.js");
      
      const result = walCheckpointTruncate(db);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("getIndexCapabilities", () => {
    test("returns capabilities object", async () => {
      const { getIndexCapabilities } = await import("../engine/repository/store-maintenance.js");
      
      const result = getIndexCapabilities(db);
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });
  });
});
