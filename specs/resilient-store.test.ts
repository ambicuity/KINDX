/**
 * specs/resilient-store.test.ts
 *
 * Unit tests for engine/resilient-store.ts - Resilient store with connection recycling.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createResilientStore } from "../engine/resilient-store.js";
import type { Store } from "../engine/repository.js";

describe("resilient-store", () => {
  let store: Store;

  beforeEach(() => {
    store = createResilientStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("createResilientStore", () => {
    test("creates a store instance", () => {
      expect(store).toBeDefined();
      expect(store.db).toBeDefined();
    });

    test("store has db property", () => {
      expect(store.db).toBeDefined();
      expect(typeof store.db.prepare).toBe("function");
    });

    test("can execute basic operations", () => {
      const result = store.db.prepare("SELECT 1 as num").get();
      expect(result).toEqual({ num: 1 });
    });

    test("can prepare and run statements", () => {
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS test_table (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);

      const stmt = store.db.prepare("INSERT INTO test_table (name) VALUES (?)");
      stmt.run("test");

      const row = store.db.prepare("SELECT name FROM test_table").get();
      expect(row).toEqual({ name: "test" });
    });

    test("supports transactions", () => {
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS test_table (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);

      const insert = store.db.prepare("INSERT INTO test_table (name) VALUES (?)");
      const transaction = store.db.transaction((names: string[]) => {
        for (const name of names) {
          insert.run(name);
        }
      });

      transaction(["a", "b", "c"]);

      const rows = store.db.prepare("SELECT name FROM test_table").all();
      expect(rows).toHaveLength(3);
    });

    test("recycles connection on corrupt error", () => {
      expect(() => {
        store.db.prepare("SELECT * FROM nonexistent_table").get();
      }).toThrow();
    });
  });
});
