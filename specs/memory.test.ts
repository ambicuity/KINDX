import { afterEach, describe, expect, test } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import {
  initializeMemorySchema,
  upsertMemory,
  textSearchMemory,
  semanticSearchMemory,
  purgeExpiredMemories,
  consolidateMemories,
  getMemoryHistory,
  getMemoryStats,
  markMemoryAccessed,
  deriveWorkspaceMemoryScope,
  resolveMemoryScope,
  initializeMemoryFeedbackSchema,
  recordFeedback,
  getFeedbackForScope,
  computeFeedbackBias,
  evictIfNeeded,
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

  test("initializeMemoryFeedbackSchema creates table and indexes", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);

    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_feedback'`
    ).get() as { name: string } | undefined;
    expect(tables?.name).toBe("memory_feedback");

    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_feedback'`
    ).all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain("idx_memory_feedback_scope_hash");
    expect(indexNames).toContain("idx_memory_feedback_scope_result");
  });

  test("recordFeedback inserts batch feedback rows", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);

    const mem = db.prepare(
      `INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count, created_at, last_appeared_at, search_text)
       VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?)`
    ).run("s1", "test:key", "test value", "test:key test value");

    const count = recordFeedback(db, "s1", "test query", [
      { id: Number(mem.lastInsertRowid), satisfaction: "positive" },
      { id: Number(mem.lastInsertRowid), satisfaction: "negative" },
    ]);
    expect(count).toBe(2);

    const rows = db.prepare(
      `SELECT * FROM memory_feedback WHERE scope = 's1'`
    ).all();
    expect(rows.length).toBe(2);
  });

  test("recordFeedback returns 0 for empty results array", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);
    const count = recordFeedback(db, "s1", "test query", []);
    expect(count).toBe(0);
  });

  test("getFeedbackForScope aggregates correctly", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);

    const mem = db.prepare(
      `INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count, created_at, last_appeared_at, search_text)
       VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?)`
    ).run("s1", "test:key", "test value", "test:key test value");
    const memId = Number(mem.lastInsertRowid);

    recordFeedback(db, "s1", "query a", [
      { id: memId, satisfaction: "positive" },
      { id: memId, satisfaction: "positive" },
      { id: memId, satisfaction: "negative" },
    ]);

    const summary = getFeedbackForScope(db, "s1");
    expect(summary.length).toBe(1);
    expect(summary[0]?.positive).toBe(2);
    expect(summary[0]?.negative).toBe(1);
    expect(summary[0]?.neutral).toBe(0);
    expect(summary[0]?.total).toBe(3);
  });

  test("computeFeedbackBias returns empty Map for empty input", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);
    const bias = computeFeedbackBias(db, "s1", []);
    expect(bias.size).toBe(0);
  });

  test("positive feedback boosts bias above 1.0", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);

    const mem = db.prepare(
      `INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count, created_at, last_appeared_at, search_text)
       VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?)`
    ).run("s1", "test:key", "value", "test:key value");
    const memId = Number(mem.lastInsertRowid);

    recordFeedback(db, "s1", "query", [
      { id: memId, satisfaction: "positive" },
      { id: memId, satisfaction: "positive" },
      { id: memId, satisfaction: "positive" },
    ]);

    const bias = computeFeedbackBias(db, "s1", [memId]);
    expect(bias.get(memId)).toBeGreaterThan(1.0);
  });

  test("negative feedback reduces bias below 1.0", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);

    const mem = db.prepare(
      `INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count, created_at, last_appeared_at, search_text)
       VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?)`
    ).run("s1", "test:key", "value", "test:key value");
    const memId = Number(mem.lastInsertRowid);

    recordFeedback(db, "s1", "query", [
      { id: memId, satisfaction: "negative" },
      { id: memId, satisfaction: "negative" },
      { id: memId, satisfaction: "negative" },
    ]);

    const bias = computeFeedbackBias(db, "s1", [memId]);
    expect(bias.get(memId)).toBeLessThan(1.0);
  });

  test("no feedback defaults to 1.0 bias", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);

    const mem = db.prepare(
      `INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count, created_at, last_appeared_at, search_text)
       VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?)`
    ).run("s1", "test:key", "value", "test:key value");
    const memId = Number(mem.lastInsertRowid);

    const bias = computeFeedbackBias(db, "s1", [memId]);
    expect(bias.get(memId)).toBe(1.0);
  });

  test("feedback from different scopes does not affect bias", () => {
    const db = createMemoryDb();
    initializeMemoryFeedbackSchema(db);

    const mem = db.prepare(
      `INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count, created_at, last_appeared_at, search_text)
       VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?)`
    ).run("s1", "test:key", "value", "test:key value");
    const memId = Number(mem.lastInsertRowid);

    recordFeedback(db, "other-scope", "query", [
      { id: memId, satisfaction: "positive" },
    ]);

    const bias = computeFeedbackBias(db, "s1", [memId]);
    expect(bias.get(memId)).toBe(1.0);
  });

  test("TTL refreshed on textSearchMemory access", async () => {
    const db = createMemoryDb();

    const ttlSeconds = 3600;
    const futureExpiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(`
      INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count,
        created_at, last_appeared_at, search_text, expires_at, ttl_seconds)
      VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?, ?, ?)
    `).run("s1", "test:key", "searchable", "test:key searchable", futureExpiry, ttlSeconds);

    await new Promise(r => setTimeout(r, 50));

    textSearchMemory(db, "s1", "searchable", 5);

    const after = db.prepare(`SELECT expires_at FROM memories WHERE scope = 's1' AND key = 'test:key'`).get() as { expires_at: string };
    const afterTime = new Date(after.expires_at).getTime();
    expect(afterTime).toBeGreaterThan(new Date(futureExpiry).getTime());
  });

  test("TTL not refreshed when ttl_seconds is NULL", async () => {
    const db = createMemoryDb();

    const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(`
      INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count,
        created_at, last_appeared_at, search_text, expires_at, ttl_seconds)
      VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?, ?, NULL)
    `).run("s1", "test:key", "searchable", "test:key searchable", futureExpiry);

    textSearchMemory(db, "s1", "searchable", 5);

    const after = db.prepare(`SELECT expires_at FROM memories WHERE scope = 's1' AND key = 'test:key'`).get() as { expires_at: string };
    expect(after.expires_at).toBe(futureExpiry);
  });

  test("cross-prefix semantic dedup supersedes similar memory under different prefix", async () => {
    const db = createMemoryDb();

    const oldMemory = await upsertMemory(db, {
      scope: "s1",
      key: "preference:editor",
      value: "vim",
      precomputedVector: [1, 0, 0],
    });

    const newMemory = await upsertMemory(db, {
      scope: "s1",
      key: "setting:editor",
      value: "vim",
      crossPrefixThreshold: 0.9,
      precomputedVector: [0.98, 0.2, 0],
    });

    expect(newMemory.id).not.toBe(oldMemory.id);
    const oldRow = db.prepare(`SELECT superseded_by FROM memories WHERE id = ?`).get(oldMemory.id) as { superseded_by: number };
    expect(Number(oldRow.superseded_by)).toBe(newMemory.id);
  });

  test("cross-prefix dedup does not merge low-similarity memories", async () => {
    const db = createMemoryDb();

    await upsertMemory(db, {
      scope: "s1",
      key: "preference:color",
      value: "blue",
      precomputedVector: [1, 0, 0],
    });

    const newMemory = await upsertMemory(db, {
      scope: "s1",
      key: "setting:language",
      value: "TypeScript",
      crossPrefixThreshold: 0.94,
      precomputedVector: [0, 1, 0],
    });

    const activeCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM memories
      WHERE scope = 's1' AND superseded_by IS NULL
    `).get() as { cnt: number };
    expect(activeCount.cnt).toBe(2);
  });

  test("same-prefix dedup takes priority over cross-prefix", async () => {
    const db = createMemoryDb();

    const samePrefixOld = await upsertMemory(db, {
      scope: "s1",
      key: "prefs:editor",
      value: "vim",
      precomputedVector: [1, 0, 0],
    });

    const crossPrefixOld = await upsertMemory(db, {
      scope: "s1",
      key: "setting:editor",
      value: "vim",
      disableSemanticDedup: true,
      precomputedVector: [0.98, 0.2, 0],
    });

    // Now insert same-prefix update — should supersede samePrefixOld, not crossPrefixOld
    const newMemory = await upsertMemory(db, {
      scope: "s1",
      key: "prefs:editor",
      value: "neovim",
      semanticThreshold: 0.9,
      crossPrefixThreshold: 0.94,
      precomputedVector: [0.97, 0.24, 0],
    });

    const oldRow = db.prepare(`SELECT superseded_by FROM memories WHERE id = ?`).get(samePrefixOld.id) as { superseded_by: number };
    expect(Number(oldRow.superseded_by)).toBe(newMemory.id);
  });

  test("markMemoryAccessed refreshes TTL when ttl_seconds is set", async () => {
    const db = createMemoryDb();

    const ttlSeconds = 3600;
    const futureExpiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const insert = db.prepare(`
      INSERT INTO memories (scope, key, value, confidence, source, appeared_count, accessed_count,
        created_at, last_appeared_at, search_text, expires_at, ttl_seconds)
      VALUES (?, ?, ?, 1.0, NULL, 1, 0, datetime('now'), datetime('now'), ?, ?, ?)
    `).run("s1", "test:key", "value", "test:key value", futureExpiry, ttlSeconds);
    const memId = Number(insert.lastInsertRowid);

    await new Promise(r => setTimeout(r, 50));
    markMemoryAccessed(db, "s1", memId);

    const after = db.prepare(`SELECT expires_at FROM memories WHERE id = ?`).get(memId) as { expires_at: string };
    const afterTime = new Date(after.expires_at).getTime();
    expect(afterTime).toBeGreaterThan(new Date(futureExpiry).getTime());
  });

  test("evictIfNeeded returns 0 when under limit", async () => {
    const db = createMemoryDb();
    await upsertMemory(db, { scope: "s1", key: "k:a", value: "v1", precomputedVector: [1, 0] });

    const evicted = evictIfNeeded(db, "s1", 10);
    expect(evicted).toBe(0);
  });

  test("eviction removes oldest accessed memory when scope exceeds cap", async () => {
    const db = createMemoryDb();

    const mem1 = await upsertMemory(db, { scope: "s1", key: "k:a", value: "v1", precomputedVector: [1, 0] });
    const mem2 = await upsertMemory(db, { scope: "s1", key: "k:b", value: "v2", precomputedVector: [0, 1] });
    const mem3 = await upsertMemory(db, { scope: "s1", key: "k:c", value: "v3", precomputedVector: [1, 1] });

    // Mark mem1 and mem2 as accessed (they get last_accessed_at updated)
    markMemoryAccessed(db, "s1", mem1.id);
    markMemoryAccessed(db, "s1", mem2.id);
    // mem3 never accessed (last_accessed_at is NULL) — evicted last with NULLS LAST

    // Cap at 2: should evict mem1 (oldest accessed)
    const evicted = evictIfNeeded(db, "s1", 2);
    expect(evicted).toBe(1);

    const remaining = db.prepare(
      `SELECT id FROM memories WHERE scope = 's1' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).all() as { id: number }[];
    const remainingIds = remaining.map(r => r.id);
    expect(remainingIds).not.toContain(mem1.id);
    expect(remainingIds).toContain(mem2.id);
    expect(remainingIds).toContain(mem3.id);
  });

  test("eviction cleans up tags and embeddings", async () => {
    const db = createMemoryDb();
    const mem1 = await upsertMemory(db, { scope: "s1", key: "k:a", value: "v1", tags: ["t1"], precomputedVector: [1, 0] });

    const evicted = evictIfNeeded(db, "s1", 0);
    expect(evicted).toBe(1);

    const tags = db.prepare(`SELECT * FROM memory_tags WHERE memory_id = ?`).all(mem1.id);
    expect(tags.length).toBe(0);

    const embeddings = db.prepare(`SELECT * FROM memory_embeddings WHERE memory_id = ?`).all(mem1.id);
    expect(embeddings.length).toBe(0);
  });

  test("maybeRunLifecycleJobs purges expired memories when triggered", () => {
    const db = createMemoryDb();

    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO memories (scope, key, value, appeared_count, accessed_count,
        created_at, last_appeared_at, search_text, expires_at, ttl_seconds)
      VALUES (?, ?, ?, 1, 0, datetime('now'), datetime('now'), ?, ?, 60)
    `).run("s1", "k:expired", "v", "k:expired v", expiredIso);

    const before = db.prepare(`SELECT COUNT(*) AS cnt FROM memories WHERE scope = 's1'`).get() as { cnt: number };
    expect(before.cnt).toBe(1);

    purgeExpiredMemories(db, "s1");

    const after = db.prepare(`SELECT COUNT(*) AS cnt FROM memories WHERE scope = 's1'`).get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test("consolidateMemories merges near-duplicate memories", async () => {
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
      value: "vim editor",
      disableSemanticDedup: true,
      precomputedVector: [0.99, 0.14],
    });

    const before = db.prepare(`
      SELECT COUNT(*) AS cnt FROM memories
      WHERE scope = 's1' AND superseded_by IS NULL
    `).get() as { cnt: number };
    expect(before.cnt).toBe(2);

    consolidateMemories(db, "s1", 0.9);

    const after = db.prepare(`
      SELECT COUNT(*) AS cnt FROM memories
      WHERE scope = 's1' AND superseded_by IS NULL
    `).get() as { cnt: number };
    expect(after.cnt).toBe(1);
  });

  test("embedding model is not hardcoded to kindx-local", async () => {
    const db = createMemoryDb();
    const mem = await upsertMemory(db, {
      scope: "s1",
      key: "test:model",
      value: "check model",
      precomputedVector: [1, 0, 0],
    });

    const row = db.prepare(
      `SELECT model FROM memory_embeddings WHERE memory_id = ?`
    ).get(mem.id) as { model: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.model).not.toBe("kindx-local");
    expect(row?.model).toBe(
      process.env.KINDX_EMBED_MODEL ?? "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"
    );
  });
});
