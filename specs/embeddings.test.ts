/**
 * specs/embeddings.test.ts
 *
 * Unit tests for engine/repository/embeddings.ts - Embedding storage.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema } from "../engine/schema.js";
import type { Database } from "../engine/runtime.js";

describe("embeddings", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initializeCoreSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("getHashesForEmbedding", () => {
    test("returns empty array for empty database", async () => {
      const { getHashesForEmbedding } = await import("../engine/repository/embeddings.js");
      
      const result = getHashesForEmbedding(db);
      expect(result).toEqual([]);
    });

    test("returns documents needing embedding", async () => {
      const { getHashesForEmbedding } = await import("../engine/repository/embeddings.js");
      
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
      ).run("hash1", "test content", now);
      db.prepare(
        "INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("test", "test.md", "Test", "hash1", now, now, 1);
      
      const result = getHashesForEmbedding(db);
      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe("hash1");
    });

    test("excludes documents with existing embeddings", async () => {
      const { getHashesForEmbedding } = await import("../engine/repository/embeddings.js");
      
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)"
      ).run("hash1", "test content", now);
      db.prepare(
        "INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("test", "test.md", "Test", "hash1", now, now, 1);
      db.prepare(
        "INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)"
      ).run("hash1", 0, 0, "test-model", now);
      
      const result = getHashesForEmbedding(db);
      expect(result).toHaveLength(0);
    });
  });

  describe("clearAllEmbeddings", () => {
    test("removes all embeddings", async () => {
      const { clearAllEmbeddings } = await import("../engine/repository/embeddings.js");
      
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)"
      ).run("hash1", 0, 0, "test-model", now);
      
      clearAllEmbeddings(db);
      
      const count = db.prepare("SELECT COUNT(*) as c FROM content_vectors").get() as { c: number };
      expect(count.c).toBe(0);
    });
  });

  describe("invalidateEmbeddingStmtCaches", () => {
    test("runs without error", async () => {
      const { invalidateEmbeddingStmtCaches } = await import("../engine/repository/embeddings.js");
      
      expect(() => invalidateEmbeddingStmtCaches(db)).not.toThrow();
    });
  });
});
