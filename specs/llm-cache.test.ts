/**
 * specs/llm-cache.test.ts
 *
 * Unit tests for engine/repository/llm-cache.ts - LLM response cache.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema } from "../engine/schema.js";
import type { Database } from "../engine/runtime.js";

describe("llm-cache", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initializeCoreSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("getCacheKey", () => {
    test("returns consistent hash for same input", async () => {
      const { getCacheKey } = await import("../engine/repository/llm-cache.js");
      
      const key1 = getCacheKey("http://test.com", { query: "test" });
      const key2 = getCacheKey("http://test.com", { query: "test" });
      expect(key1).toBe(key2);
    });

    test("returns different hash for different URLs", async () => {
      const { getCacheKey } = await import("../engine/repository/llm-cache.js");
      
      const key1 = getCacheKey("http://test1.com", { query: "test" });
      const key2 = getCacheKey("http://test2.com", { query: "test" });
      expect(key1).not.toBe(key2);
    });

    test("returns different hash for different bodies", async () => {
      const { getCacheKey } = await import("../engine/repository/llm-cache.js");
      
      const key1 = getCacheKey("http://test.com", { query: "test1" });
      const key2 = getCacheKey("http://test.com", { query: "test2" });
      expect(key1).not.toBe(key2);
    });

    test("normalizes object key order", async () => {
      const { getCacheKey } = await import("../engine/repository/llm-cache.js");
      
      const key1 = getCacheKey("http://test.com", { a: 1, b: 2 });
      const key2 = getCacheKey("http://test.com", { b: 2, a: 1 });
      expect(key1).toBe(key2);
    });
  });

  describe("getCachedResult", () => {
    test("returns null for missing key", async () => {
      const { getCachedResult } = await import("../engine/repository/llm-cache.js");
      
      const result = getCachedResult(db, "nonexistent-key");
      expect(result).toBeNull();
    });
  });

  describe("setCachedResult", () => {
    test("stores and retrieves result", async () => {
      const { getCacheKey, setCachedResult, getCachedResult } = await import("../engine/repository/llm-cache.js");
      
      const key = getCacheKey("http://test.com", { query: "test" });
      setCachedResult(db, key, "cached result");
      
      const result = getCachedResult(db, key);
      expect(result).toBe("cached result");
    });

    test("overwrites existing result", async () => {
      const { getCacheKey, setCachedResult, getCachedResult } = await import("../engine/repository/llm-cache.js");
      
      const key = getCacheKey("http://test.com", { query: "test" });
      setCachedResult(db, key, "old result");
      setCachedResult(db, key, "new result");
      
      const result = getCachedResult(db, key);
      expect(result).toBe("new result");
    });
  });

  describe("clearCache", () => {
    test("removes all cached results", async () => {
      const { getCacheKey, setCachedResult, clearCache, getCachedResult } = await import("../engine/repository/llm-cache.js");
      
      const key = getCacheKey("http://test.com", { query: "test" });
      setCachedResult(db, key, "cached result");
      clearCache(db);
      
      const result = getCachedResult(db, key);
      expect(result).toBeNull();
    });
  });

  describe("deleteLLMCache", () => {
    test("returns number of deleted entries", async () => {
      const { getCacheKey, setCachedResult, deleteLLMCache } = await import("../engine/repository/llm-cache.js");
      
      setCachedResult(db, getCacheKey("http://test1.com", {}), "result1");
      setCachedResult(db, getCacheKey("http://test2.com", {}), "result2");
      
      const deleted = deleteLLMCache(db);
      expect(deleted).toBe(2);
    });
  });
});
