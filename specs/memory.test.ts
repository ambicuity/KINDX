import { afterEach, describe, expect, test } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import {
  initializeMemorySchema,
  upsertMemory,
  textSearchMemory,
  semanticSearchMemory,
  getMemoryHistory,
  getMemoryStats,
  markMemoryAccessed,
} from "../engine/memory.js";

const openDbs: Database[] = [];

function createMemoryDb(): Database {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemorySchema(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
});

describe("memory subsystem", () => {
  test("exact dedup for (scope,key,value)", async () => {
    const db = createMemoryDb();
    const first = await upsertMemory(db, {
      scope: "s1",
      key: "user:name",
      value: "Alice",
      tags: ["profile"],
      source: "seed",
      precomputedVector: [1, 0, 0],
    });
    const second = await upsertMemory(db, {
      scope: "s1",
      key: "user:name",
      value: "Alice",
      tags: ["profile", "primary"],
      source: "chat",
      precomputedVector: [1, 0, 0],
    });

    expect(second.id).toBe(first.id);
    expect(second.appearedCount).toBe(2);
    expect(second.source).toBe("seed, chat");

    const tagCount = db.prepare(`SELECT COUNT(*) AS cnt FROM memory_tags WHERE memory_id = ?`).get(second.id) as { cnt: number };
    expect(tagCount.cnt).toBe(2);
  });

  test("semantic supersession within same scope and key prefix", async () => {
    const db = createMemoryDb();
    const oldMemory = await upsertMemory(db, {
      scope: "s1",
      key: "profile:city",
      value: "Austin",
      precomputedVector: [1, 0],
    });

    const nextMemory = await upsertMemory(db, {
      scope: "s1",
      key: "profile:city",
      value: "Austin, TX",
      semanticThreshold: 0.9,
      precomputedVector: [0.97, 0.24],
    });

    expect(nextMemory.id).not.toBe(oldMemory.id);
    const oldRow = db.prepare(`SELECT superseded_by FROM memories WHERE id = ?`).get(oldMemory.id) as { superseded_by: number };
    expect(Number(oldRow.superseded_by)).toBe(nextMemory.id);
  });

  test("single-cardinality key supersession", async () => {
    const db = createMemoryDb();
    const first = await upsertMemory(db, {
      scope: "s1",
      key: "first_name",
      value: "Alice",
      semanticThreshold: 0.999,
      precomputedVector: [1, 0],
    });
    const second = await upsertMemory(db, {
      scope: "s1",
      key: "first_name",
      value: "Alicia",
      semanticThreshold: 0.999,
      precomputedVector: [0, 1],
    });

    const oldRow = db.prepare(`SELECT superseded_by FROM memories WHERE id = ?`).get(first.id) as { superseded_by: number };
    expect(Number(oldRow.superseded_by)).toBe(second.id);
  });

  test("scope isolation prevents collisions", async () => {
    const db = createMemoryDb();
    const left = await upsertMemory(db, {
      scope: "left",
      key: "profile:team",
      value: "core",
      precomputedVector: [1, 0, 0],
    });
    const right = await upsertMemory(db, {
      scope: "right",
      key: "profile:team",
      value: "core",
      precomputedVector: [1, 0, 0],
    });

    expect(left.id).not.toBe(right.id);
  });

  test("semantic threshold controls supersession", async () => {
    const db = createMemoryDb();
    await upsertMemory(db, {
      scope: "s1",
      key: "prefs:editor",
      value: "vim",
      precomputedVector: [1, 0],
    });
    await upsertMemory(db, {
      scope: "s1",
      key: "prefs:editor",
      value: "neovim",
      semanticThreshold: 0.99,
      precomputedVector: [0.8, 0.2],
    });

    const activeCount = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM memories
      WHERE scope = 's1' AND key = 'prefs:editor' AND superseded_by IS NULL
    `).get() as { cnt: number };
    expect(activeCount.cnt).toBe(2);
  });

  test("search counters and mark-accessed behavior", async () => {
    const db = createMemoryDb();
    const stored = await upsertMemory(db, {
      scope: "s1",
      key: "profile:company",
      value: "Ambicuity",
      precomputedVector: [1, 0, 0],
    });

    const initial = db.prepare(`SELECT appeared_count, accessed_count FROM memories WHERE id = ?`).get(stored.id) as { appeared_count: number; accessed_count: number };
    expect(initial.appeared_count).toBe(1);
    expect(initial.accessed_count).toBe(0);

    const results = textSearchMemory(db, "s1", "ambicuity", 5);
    expect(results.length).toBe(1);

    const afterSearch = db.prepare(`SELECT appeared_count, accessed_count FROM memories WHERE id = ?`).get(stored.id) as { appeared_count: number; accessed_count: number };
    expect(afterSearch.appeared_count).toBe(2);
    expect(afterSearch.accessed_count).toBe(1);

    const marked = markMemoryAccessed(db, "s1", stored.id);
    expect(marked).toBe(true);

    const afterMark = db.prepare(`SELECT appeared_count, accessed_count FROM memories WHERE id = ?`).get(stored.id) as { appeared_count: number; accessed_count: number };
    expect(afterMark.appeared_count).toBe(2);
    expect(afterMark.accessed_count).toBe(2);
  });

  test("history and stats include supersession and tags", async () => {
    const db = createMemoryDb();
    await upsertMemory(db, {
      scope: "s1",
      key: "job_title",
      value: "Engineer",
      tags: ["work"],
      precomputedVector: [1, 0],
    });
    await upsertMemory(db, {
      scope: "s1",
      key: "job_title",
      value: "Senior Engineer",
      tags: ["work", "updated"],
      precomputedVector: [0, 1],
    });

    const history = getMemoryHistory(db, "s1", "job_title");
    expect(history.length).toBe(2);

    const stats = getMemoryStats(db, "s1");
    expect(stats.totalMemories).toBe(1);
    expect(stats.superseded).toBe(1);
    expect(stats.byTag.work).toBe(2);
    expect(stats.byTag.updated).toBe(1);
  });

  test("semantic search falls back to text when embeddings are unavailable", async () => {
    const db = createMemoryDb();
    db.prepare(`
      INSERT INTO memories (
        scope, key, value, confidence, source, appeared_count, accessed_count,
        created_at, last_appeared_at, search_text
      ) VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?)
    `).run("s1", "profile:project", "KINDX", "profile:project: KINDX");

    const results = await semanticSearchMemory(db, "s1", "kindx", 5, 0.3, [1, 0, 0]);
    expect(results.length).toBe(1);
    expect(results[0]?.key).toBe("profile:project");
  });
});
