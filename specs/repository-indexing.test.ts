/**
 * specs/repository-indexing.test.ts
 *
 * Unit tests for engine/repository/indexing.ts - Document indexing operations.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../engine/runtime.js";
import { initializeCoreSchema } from "../engine/schema.js";
import { createStore } from "../engine/repository.js";
import type { Store } from "../engine/repository.js";
import type { Database } from "../engine/runtime.js";

describe("repository-indexing", () => {
  let testDir: string;
  let store: Store;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "kindx-indexing-test-"));
    store = createStore(":memory:");
    db = store.db;
    initializeCoreSchema(db);
  });

  afterEach(async () => {
    store.close();
    await rm(testDir, { recursive: true, force: true });
  });

  describe("indexSingleFile", () => {
    test("indexes a markdown file", async () => {
      const { indexSingleFile } = await import("../engine/repository/indexing.js");
      
      const filePath = join(testDir, "test.md");
      await writeFile(filePath, "# Test Document\n\nThis is test content.");

      const result = await indexSingleFile(db, "test-collection", "test.md", filePath);

      expect(result).toBe("embedded");
    });

    test("returns unchanged for duplicate content", async () => {
      const { indexSingleFile } = await import("../engine/repository/indexing.js");
      
      const filePath = join(testDir, "test.md");
      await writeFile(filePath, "# Test Document\n\nThis is test content.");

      await indexSingleFile(db, "test-collection", "test.md", filePath);
      const result = await indexSingleFile(db, "test-collection", "test.md", filePath);

      expect(result).toBe("unchanged");
    });

    test("returns unchanged for empty content", async () => {
      const { indexSingleFile } = await import("../engine/repository/indexing.js");
      
      const filePath = join(testDir, "empty.md");
      await writeFile(filePath, "");

      const result = await indexSingleFile(db, "test-collection", "empty.md", filePath);

      expect(result).toBe("unchanged");
    });

    test("updates document when content changes", async () => {
      const { indexSingleFile } = await import("../engine/repository/indexing.js");
      
      const filePath = join(testDir, "test.md");
      await writeFile(filePath, "# Original Content");
      await indexSingleFile(db, "test-collection", "test.md", filePath);

      await writeFile(filePath, "# Updated Content");
      const result = await indexSingleFile(db, "test-collection", "test.md", filePath);

      expect(result).toBe("embedded");
    });
  });
});
