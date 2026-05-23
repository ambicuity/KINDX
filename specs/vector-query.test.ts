/**
 * specs/vector-query.test.ts
 *
 * Unit tests for engine/repository/retrieval/vector-query.ts - Vector search orchestrator.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { createStore } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";

describe("vector-query", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("vectorSearchQuery", () => {
    test("returns empty array when no vectors table exists", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const results = await vectorSearchQuery(store, "test query");
      expect(results).toEqual([]);
    });

    test("accepts options parameter", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      const results = await vectorSearchQuery(store, "test query", {
        limit: 5,
        minScore: 0.5,
        collection: "test",
      });
      expect(results).toEqual([]);
    });

    test("accepts hooks parameter", async () => {
      const { vectorSearchQuery } = await import("../engine/repository/retrieval/vector-query.js");
      
      let expandCalled = false;
      const results = await vectorSearchQuery(store, "test query", {
        hooks: {
          onExpand: () => { expandCalled = true; },
        },
      });
      expect(results).toEqual([]);
    });
  });
});
