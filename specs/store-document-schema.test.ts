import { describe, expect, test } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { storeDocumentSchema } from "../engine/schema.js";

describe("storeDocumentSchema", () => {
  test("creates document_schemas table and stores schema", () => {
    const db = openDatabase(":memory:");
    try {
      const schema = { name: "string", age: "number", active: "boolean" };
      storeDocumentSchema(db, "users", "user.csv", schema);

      const row = db.prepare("SELECT * FROM document_schemas WHERE collection = ? AND path = ?")
        .get("users", "user.csv") as { collection: string; path: string; schema_json: string; updated_at: string };

      expect(row).toBeDefined();
      expect(row.collection).toBe("users");
      expect(row.path).toBe("user.csv");
      expect(JSON.parse(row.schema_json)).toEqual(schema);
      expect(row.updated_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  test("overwrites existing schema for same collection/path", () => {
    const db = openDatabase(":memory:");
    try {
      storeDocumentSchema(db, "users", "user.csv", { name: "string" });
      storeDocumentSchema(db, "users", "user.csv", { name: "string", email: "string" });

      const rows = db.prepare("SELECT * FROM document_schemas WHERE collection = ? AND path = ?")
        .all("users", "user.csv");

      expect(rows).toHaveLength(1);
      expect(JSON.parse((rows[0] as { schema_json: string }).schema_json)).toEqual({ name: "string", email: "string" });
    } finally {
      db.close();
    }
  });

  test("stores multiple schemas for different paths", () => {
    const db = openDatabase(":memory:");
    try {
      storeDocumentSchema(db, "users", "users.csv", { name: "string" });
      storeDocumentSchema(db, "users", "orders.json", { total: "number" });
      storeDocumentSchema(db, "products", "items.csv", { title: "string" });

      const rows = db.prepare("SELECT * FROM document_schemas").all();
      expect(rows).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
