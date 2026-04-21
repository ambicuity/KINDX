import { afterEach, describe, expect, test } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import {
  initializeMemorySchema,
  upsertMemory,
  textSearchMemory,
  semanticSearchMemory,
  purgeExpiredMemories,
  getMemoryHistory,
  getMemoryStats,
  markMemoryAccessed,
  deriveWorkspaceMemoryScope,
  resolveMemoryScope,
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
  test("resolveMemoryScope prefers explicit > session > workspace > default", () => {
    const explicit = resolveMemoryScope({
      explicitScope: "explicit-scope",
      sessionScope: "session-scope",
      workspaceScope: "workspace-scope",
    });
    expect(explicit.scope).toBe("explicit-scope");
    expect(explicit.source).toBe("explicit");

    const session = resolveMemoryScope({
      sessionScope: "session-scope",
      workspaceScope: "workspace-scope",
    });
    expect(session.scope).toBe("session-scope");
    expect(session.source).toBe("session");

    const workspace = resolveMemoryScope({
      workspaceScope: "workspace-scope",
    });
    expect(workspace.scope).toBe("workspace-scope");
    expect(workspace.source).toBe("workspace");

    const fallback = resolveMemoryScope({});
    expect(fallback.scope).toBe("default");
    expect(fallback.source).toBe("default");
  });

  test("resolveMemoryScope rejects explicit cross-scope when strict isolation is enabled", () => {
    const resolved = resolveMemoryScope({
      explicitScope: "scope-b",
      sessionScope: "scope-a",
      strictIsolation: true,
    });
    expect(resolved.error?.code).toBe("cross_scope_forbidden");
    expect(resolved.error?.message).toContain("scope-b");
    expect(resolved.error?.message).toContain("scope-a");
  });

  test("deriveWorkspaceMemoryScope disambiguates same basename across different paths", () => {
    const a = deriveWorkspaceMemoryScope("/workspace/team-a/app");
    const b = deriveWorkspaceMemoryScope("/workspace/team-b/app");

    expect(a).toMatch(/^app-[a-f0-9]{8}$/);
    expect(b).toMatch(/^app-[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
  });

  test("deriveWorkspaceMemoryScope is stable for file:// URIs", () => {
    const first = deriveWorkspaceMemoryScope("file:///Users/example/projects/kindx");
    const second = deriveWorkspaceMemoryScope("file:///Users/example/projects/kindx");

    expect(first).toBe(second);
    expect(first).toMatch(/^kindx-[a-f0-9]{8}$/);
  });

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

  test("purgeExpiredMemories purges expired rows across all scopes when no scope is provided", () => {
    const db = createMemoryDb();
    const now = Date.now();
    const expiredIso = new Date(now - 60_000).toISOString();
    const futureIso = new Date(now + 60_000).toISOString();
    const insert = db.prepare(`
      INSERT INTO memories (
        scope, key, value, confidence, source, appeared_count, accessed_count,
        created_at, last_appeared_at, expires_at, search_text
      ) VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?, ?)
    `);

    const defaultExpired = insert.run("default", "k:default:expired", "v1", expiredIso, "k:default:expired v1");
    const teamExpired = insert.run("team-a", "k:team:expired", "v2", expiredIso, "k:team:expired v2");
    insert.run("team-a", "k:team:active", "v3", futureIso, "k:team:active v3");
    insert.run("team-b", "k:team:no-ttl", "v4", null, "k:team:no-ttl v4");

    const purged = purgeExpiredMemories(db);
    expect(purged).toBe(2);

    const defaultGone = db.prepare(`SELECT id FROM memories WHERE id = ?`).get(Number(defaultExpired.lastInsertRowid));
    const teamGone = db.prepare(`SELECT id FROM memories WHERE id = ?`).get(Number(teamExpired.lastInsertRowid));
    const remaining = db.prepare(`SELECT scope, key FROM memories ORDER BY scope, key`).all() as Array<{ scope: string; key: string }>;

    expect(defaultGone).toBeUndefined();
    expect(teamGone).toBeUndefined();
    expect(remaining).toEqual([
      { scope: "team-a", key: "k:team:active" },
      { scope: "team-b", key: "k:team:no-ttl" },
    ]);
  });
});
