/**
 * specs/watcher.test.ts
 *
 * Unit tests for engine/watcher.ts - File system watcher daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { WatchDaemon } from "../engine/watcher.js";
import { createStore } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";

describe("watcher", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("WatchDaemon", () => {
    test("can be instantiated", () => {
      const daemon = new WatchDaemon(store);
      expect(daemon).toBeDefined();
      expect(daemon.startTime).toBeGreaterThan(0);
      expect(daemon.lastUpdateTs).toBeGreaterThan(0);
      expect(daemon.eventCount).toBe(0);
    });

    test("tracks start time", () => {
      const before = Date.now();
      const daemon = new WatchDaemon(store);
      const after = Date.now();

      expect(daemon.startTime).toBeGreaterThanOrEqual(before);
      expect(daemon.startTime).toBeLessThanOrEqual(after);
    });

    test("start() completes without error for empty collections", async () => {
      const daemon = new WatchDaemon(store);
      await expect(daemon.start([])).resolves.toBeUndefined();
    });
  });
});
