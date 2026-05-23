/**
 * Protocol instructions — auto-invocation contract (TDD)
 *
 * Drives the buildInstructions() rewrite in Phase A Task 3. These tests are
 * intentionally failing on `main` of feat/auto-invocation-phase-a: the contract
 * constants from Task 1 (AUTO_INVOCATION_CONTRACT, MAX_INSTRUCTIONS_BYTES,
 * TRUNCATION_MARKER, isAutoInvokeEnabled) are defined but not wired into
 * buildInstructions yet.
 *
 * Each test uses a fresh on-disk SQLite + YAML catalog so we exercise the real
 * store.getStatus() path (no mocks). Per-test isolation is achieved with a
 * unique KINDX_CONFIG_DIR + unique index name so the mtime-keyed catalog cache
 * in engine/catalogs.ts cannot leak between tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { openDatabase, loadSqliteVec } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import { setConfigIndexName, type CollectionConfig } from "../engine/catalogs.js";
import { buildInstructionsForTest } from "../engine/protocol.js";
import { getStatus, type Store } from "../engine/repository.js";

// =============================================================================
// Test harness — mirrors specs/mcp.test.ts initTestDatabase + seed
// =============================================================================

function initTestDatabase(db: Database): void {
  loadSqliteVec(db);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      name, body,
      content='documents',
      content_rowid='id',
      tokenize='porter unicode61'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, name, body)
      SELECT new.id, new.path, content.doc
      FROM content
      WHERE content.hash = new.hash;
    END
  `);

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine)`);
}

function seedCollection(db: Database, collection: string, docs: { path: string; title: string; body: string }[]): void {
  const now = new Date().toISOString();
  for (const doc of docs) {
    const hash = `${collection}-${doc.path}`;
    db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
      .run(hash, doc.body, now);
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(collection, doc.path, doc.title, hash, now, now);
  }
}

/**
 * Build a minimal Store-shaped object that satisfies buildInstructions().
 * We can't call repository.createStore() because it ensures encryption /
 * shard-index state and we want a fully ephemeral DB. buildInstructions only
 * reaches into store.db (for the memory-prefetch SELECT) and store.getStatus().
 */
function makeStore(db: Database): Store {
  return {
    db,
    dbPath: ":memory:",
    indexName: "index",
    getStatus: () => getStatus(db),
  } as unknown as Store;
}

interface Fixture {
  db: Database;
  dbPath: string;
  configDir: string;
  indexName: string;
  cleanup: () => void;
}

function setupFixture(opts: {
  collections: Record<string, { path: string; pattern?: string; context?: Record<string, string> }>;
  seed: Record<string, { path: string; title: string; body: string }[]>;
  withVectorIndex: boolean;
}): Fixture {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const configDir = mkdtempSync(join(tmpdir(), `kindx-instr-cfg-${stamp}-`));
  const indexName = `instr-${stamp}`;
  const dbPath = join(tmpdir(), `kindx-instr-${stamp}.sqlite`);

  process.env.KINDX_CONFIG_DIR = configDir;
  setConfigIndexName(indexName);

  const cfg: CollectionConfig = {
    collections: Object.fromEntries(
      Object.entries(opts.collections).map(([name, c]) => [
        name,
        { path: c.path, pattern: c.pattern ?? "**/*.md", context: c.context ?? {} },
      ]),
    ) as any,
  };
  writeFileSync(join(configDir, `${indexName}.yml`), YAML.stringify(cfg));

  const db = openDatabase(dbPath);
  initTestDatabase(db);

  for (const [collection, docs] of Object.entries(opts.seed)) {
    seedCollection(db, collection, docs);
  }

  if (!opts.withVectorIndex) {
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }

  return {
    db,
    dbPath,
    configDir,
    indexName,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      try { unlinkSync(dbPath); } catch { /* ignore */ }
      try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("buildInstructions — auto-invocation contract", () => {
  let fixtures: Fixture[] = [];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fixtures = [];
    // Default: auto-invoke ON (unset the gate). Individual tests may set it.
    delete process.env.KINDX_AUTO_INVOKE;
  });

  afterEach(() => {
    for (const f of fixtures) f.cleanup();
    fixtures = [];
    // Restore env to avoid cross-test pollution.
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  test("emits the auto-invocation contract when at least one collection exists", () => {
    const fx = setupFixture({
      collections: { docs: { path: "/tmp/docs" } },
      seed: { docs: [{ path: "readme.md", title: "Readme", body: "hello world" }] },
      withVectorIndex: true,
    });
    fixtures.push(fx);

    const instructions = buildInstructionsForTest(makeStore(fx.db));

    expect(instructions).toContain("## When to call KINDX (auto-invocation contract)");
    // Sentinel lines from AUTO_INVOCATION_CONTRACT in engine/protocol.ts
    expect(instructions).toContain("Auto-invoke is default-on");
    expect(instructions).toContain("Decision table:");
  });

  test("suppresses the contract and shows an onboarding hint when no collections exist", () => {
    const fx = setupFixture({
      collections: {},
      seed: {},
      withVectorIndex: true,
    });
    fixtures.push(fx);

    const instructions = buildInstructionsForTest(makeStore(fx.db));

    expect(instructions).not.toContain("## When to call KINDX (auto-invocation contract)");
    // The user-facing nudge to create a collection. Phrasing locked to
    // `kindx collection add` so the message stays actionable.
    expect(instructions).toMatch(/no collections/i);
    expect(instructions).toContain("kindx collection add");
  });

  test("suppresses the contract when KINDX_AUTO_INVOKE=off but still lists collections", () => {
    const fx = setupFixture({
      collections: { docs: { path: "/tmp/docs" } },
      seed: { docs: [{ path: "readme.md", title: "Readme", body: "hello" }] },
      withVectorIndex: true,
    });
    fixtures.push(fx);

    // Baseline: with env unset, the contract MUST be present (otherwise this
    // test trivially passes today — we need to verify env actively gates it).
    delete process.env.KINDX_AUTO_INVOKE;
    const baseline = buildInstructionsForTest(makeStore(fx.db));
    expect(baseline).toContain("## When to call KINDX (auto-invocation contract)");

    // Now flip the gate off and re-render.
    process.env.KINDX_AUTO_INVOKE = "off";
    const gated = buildInstructionsForTest(makeStore(fx.db));

    expect(gated).not.toContain("## When to call KINDX (auto-invocation contract)");
    expect(gated).not.toContain("Auto-invoke is default-on");
    // Collection listing is independent of the contract — still emitted.
    expect(gated).toContain('"docs"');
  });

  test("includes a lex-only mode note (no vec/hyde) when hasVectorIndex is false", () => {
    const fx = setupFixture({
      collections: { docs: { path: "/tmp/docs" } },
      seed: { docs: [{ path: "readme.md", title: "Readme", body: "hello" }] },
      withVectorIndex: false,
    });
    fixtures.push(fx);

    const instructions = buildInstructionsForTest(makeStore(fx.db));

    expect(instructions).toContain("## When to call KINDX (auto-invocation contract)");
    // Lex-only mode is a contract-level adjustment: the model must be told not
    // to plan vec/hyde sub-queries when embeddings are missing.
    expect(instructions).toMatch(/lex-only mode/i);
    expect(instructions).toMatch(/do not (call|use)\s+`?(vec|hyde)`?/i);
  });

  test("hard-caps output at 8 KB and appends the truncation marker", () => {
    // Force overflow by stuffing the layered-instructions block with a giant
    // AGENTS.md. buildInstructions calls loadLayeredInstructions with cwd=
    // process.cwd(), so write the file there and restore afterward.
    const fx = setupFixture({
      collections: { docs: { path: "/tmp/docs" } },
      seed: { docs: [{ path: "readme.md", title: "Readme", body: "hello" }] },
      withVectorIndex: true,
    });
    fixtures.push(fx);

    const giantWorkDir = mkdtempSync(join(tmpdir(), `kindx-instr-cwd-`));
    const giantAgents = join(giantWorkDir, "AGENTS.md");
    writeFileSync(giantAgents, "A".repeat(32 * 1024)); // 32 KB — well over the 8 KB cap

    const prevCwd = process.cwd();
    process.chdir(giantWorkDir);

    let instructions: string;
    try {
      instructions = buildInstructionsForTest(makeStore(fx.db));
    } finally {
      process.chdir(prevCwd);
      try { rmSync(giantWorkDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    expect(Buffer.byteLength(instructions, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(instructions).toContain("[instructions truncated — see kindx://capabilities]");
  });
});
