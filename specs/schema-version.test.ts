import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { KINDX_SCHEMA_VERSION, getUserVersion, setUserVersion } from "../engine/utils/schema-version.js";

describe("schema-version", () => {
  test("fresh database reports version 0", () => {
    const db = new Database(":memory:");
    try {
      expect(getUserVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("setUserVersion persists across reads", () => {
    const db = new Database(":memory:");
    try {
      setUserVersion(db, 1);
      expect(getUserVersion(db)).toBe(1);
      setUserVersion(db, 17);
      expect(getUserVersion(db)).toBe(17);
    } finally {
      db.close();
    }
  });

  test("rejects negative or non-integer versions", () => {
    const db = new Database(":memory:");
    try {
      expect(() => setUserVersion(db, -1)).toThrow();
      expect(() => setUserVersion(db, 1.5)).toThrow();
      expect(() => setUserVersion(db, NaN)).toThrow();
      expect(() => setUserVersion(db, 0x80000000)).toThrow();
    } finally {
      db.close();
    }
  });

  test("KINDX_SCHEMA_VERSION is a positive integer", () => {
    expect(Number.isInteger(KINDX_SCHEMA_VERSION)).toBe(true);
    expect(KINDX_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
