/**
 * specs/rerank-queue.test.ts
 *
 * Unit tests for engine/repository/rerank-queue.ts - Rerank queue management.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { createStore } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";

describe("rerank-queue", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("getQueueController", () => {
    test("creates controller for new key", async () => {
      const { getQueueController } = await import("../engine/repository/rerank-queue.js");
      
      const controller = getQueueController("test-key");
      expect(controller).toBeDefined();
      expect(controller.active).toBe(0);
      expect(controller.nextSeq).toBe(1);
    });

    test("returns same controller for same key", async () => {
      const { getQueueController } = await import("../engine/repository/rerank-queue.js");
      
      const controller1 = getQueueController("test-key");
      const controller2 = getQueueController("test-key");
      expect(controller1).toBe(controller2);
    });

    test("creates different controllers for different keys", async () => {
      const { getQueueController } = await import("../engine/repository/rerank-queue.js");
      
      const controller1 = getQueueController("key1");
      const controller2 = getQueueController("key2");
      expect(controller1).not.toBe(controller2);
    });
  });

  describe("evictRerankController", () => {
    test("returns false for non-existent key", async () => {
      const { evictRerankController } = await import("../engine/repository/rerank-queue.js");
      
      const result = evictRerankController("nonexistent");
      expect(result).toBe(false);
    });

    test("returns true for idle controller", async () => {
      const { getQueueController, evictRerankController } = await import("../engine/repository/rerank-queue.js");
      
      getQueueController("test-key");
      const result = evictRerankController("test-key");
      expect(result).toBe(true);
    });
  });
});
