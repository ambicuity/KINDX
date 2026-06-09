/**
 * specs/schema.test.ts
 *
 * Unit tests for engine/schema.ts - Database schema initialization and migrations.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema, storeDocumentSchema } from "../engine/schema.js";
import type { Database } from "../engine/runtime.js";

describe("schema", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("initializeCoreSchema", () => {
    test("creates content table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='content'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates documents table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates content_vectors table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='content_vectors'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates llm_cache table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='llm_cache'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates document_versions table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='document_versions'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates document_links table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='document_links'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates index_capabilities table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='index_capabilities'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates document_ingest table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='document_ingest'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates documents_fts virtual table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates mcp_query_log table", () => {
      initializeCoreSchema(db);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_query_log'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("is idempotent - can be called multiple times", () => {
      initializeCoreSchema(db);
      expect(() => initializeCoreSchema(db)).not.toThrow();
    });

    test("sets schema version", () => {
      initializeCoreSchema(db);
      const version = db.pragma?.("user_version", { simple: true });
      expect(typeof version).toBe("number");
      expect(version).toBeGreaterThan(0);
    });

    test("creates indexes on documents table", () => {
      initializeCoreSchema(db);
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='documents'"
      ).all();
      const indexNames = indexes.map((i: any) => i.name);
      expect(indexNames).toContain("idx_documents_collection");
      expect(indexNames).toContain("idx_documents_hash");
      expect(indexNames).toContain("idx_documents_path");
    });

    test("creates FTS triggers", () => {
      initializeCoreSchema(db);
      const triggers = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger'"
      ).all();
      const triggerNames = triggers.map((t: any) => t.name);
      expect(triggerNames).toContain("documents_ai");
      expect(triggerNames).toContain("documents_ad");
      expect(triggerNames).toContain("documents_au");
    });

    test("populates index_capabilities", () => {
      initializeCoreSchema(db);
      const caps = db.prepare(
        "SELECT capability FROM index_capabilities"
      ).all();
      const capNames = caps.map((c: any) => c.capability);
      expect(capNames).toContain("ann");
      expect(capNames).toContain("encryption");
      expect(capNames).toContain("extractors");
    });
  });

  describe("storeDocumentSchema", () => {
    test("creates document_schemas table and stores schema", () => {
      initializeCoreSchema(db);
      const schema = { title: "string", content: "string", tags: "array" };
      storeDocumentSchema(db, "test-collection", "test/doc.md", schema);

      const row = db.prepare(
        "SELECT schema_json FROM document_schemas WHERE collection = ? AND path = ?"
      ).get("test-collection", "test/doc.md") as { schema_json: string };

      expect(row).toBeDefined();
      expect(JSON.parse(row.schema_json)).toEqual(schema);
    });

    test("overwrites existing schema for same collection/path", () => {
      initializeCoreSchema(db);
      const schema1 = { title: "string" };
      const schema2 = { title: "string", content: "string" };

      storeDocumentSchema(db, "test-collection", "test/doc.md", schema1);
      storeDocumentSchema(db, "test-collection", "test/doc.md", schema2);

      const row = db.prepare(
        "SELECT schema_json FROM document_schemas WHERE collection = ? AND path = ?"
      ).get("test-collection", "test/doc.md") as { schema_json: string };

      expect(JSON.parse(row.schema_json)).toEqual(schema2);
    });
  });
});
