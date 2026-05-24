/**
 * specs/content.test.ts
 *
 * Unit tests for engine/repository/content.ts - Content-addressable storage.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema } from "../engine/schema.js";
import type { Database } from "../engine/runtime.js";

describe("content", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initializeCoreSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("hashContent", () => {
    test("returns consistent hash for same content", async () => {
      const { hashContent } = await import("../engine/repository/content.js");
      
      const hash1 = await hashContent("test content");
      const hash2 = await hashContent("test content");
      expect(hash1).toBe(hash2);
    });

    test("returns different hash for different content", async () => {
      const { hashContent } = await import("../engine/repository/content.js");
      
      const hash1 = await hashContent("content 1");
      const hash2 = await hashContent("content 2");
      expect(hash1).not.toBe(hash2);
    });

    test("returns hex string", async () => {
      const { hashContent } = await import("../engine/repository/content.js");
      
      const hash = await hashContent("test");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("deleteInactiveDocuments", () => {
    test("returns 0 for empty database", async () => {
      const { deleteInactiveDocuments } = await import("../engine/repository/content.js");
      
      const result = deleteInactiveDocuments(db);
      expect(result).toBe(0);
    });

    test("deletes inactive documents", async () => {
      const { deleteInactiveDocuments } = await import("../engine/repository/content.js");
      
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
      ).run("hash1", "test content", now);
      db.prepare(
        "INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("test", "test.md", "Test", "hash1", now, now, 0);
      
      const result = deleteInactiveDocuments(db);
      expect(result).toBe(1);
    });
  });

  describe("cleanupOrphanedContent", () => {
    test("returns 0 for empty database", async () => {
      const { cleanupOrphanedContent } = await import("../engine/repository/content.js");
      
      const result = cleanupOrphanedContent(db);
      expect(result).toBe(0);
    });

    test("removes orphaned content", async () => {
      const { cleanupOrphanedContent } = await import("../engine/repository/content.js");
      
      db.prepare(
        "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
      ).run("orphan-hash", "orphan content", new Date().toISOString());
      
      const result = cleanupOrphanedContent(db);
      expect(result).toBe(1);
    });
  });
});
