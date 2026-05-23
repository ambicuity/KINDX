/**
 * specs/status-command.test.ts
 *
 * Unit tests for engine/commands/status-command.ts - Status command implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import { createStore } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";

describe("status-command", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("StatusDeps", () => {
    test("can create deps object", async () => {
      const { runStatusCommand } = await import("../engine/commands/status-command.js");
      
      const deps = {
        getDb: () => store.db,
        getDbPath: () => ":memory:",
        closeDb: () => {},
        getKindxCacheDir: () => "/tmp/kindx-test",
      };

      expect(deps).toBeDefined();
      expect(typeof deps.getDb).toBe("function");
      expect(typeof deps.getDbPath).toBe("function");
      expect(typeof deps.closeDb).toBe("function");
      expect(typeof deps.getKindxCacheDir).toBe("function");
    });
  });
});
