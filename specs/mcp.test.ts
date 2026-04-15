/**
 * MCP Server Tests
 *
 * Tests all MCP tools, resources, and prompts.
 * Uses mocked Ollama responses and a test database.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { openDatabase, loadSqliteVec } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDefaultLLM, disposeDefaultLLM } from "../engine/inference.js";
import { unlinkSync } from "node:fs";
import { mkdtemp, writeFile, readdir, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import type { CollectionConfig } from "../engine/catalogs.js";
import { setConfigIndexName } from "../engine/catalogs.js";

// =============================================================================
// Test Database Setup
// =============================================================================

let testDb: Database;
let testDbPath: string;
let testConfigDir: string;

afterAll(async () => {
  // Ensure native resources are released to avoid ggml-metal asserts on process exit.
  await disposeDefaultLLM();
});

function initTestDatabase(db: Database): void {
  loadSqliteVec(db);
  db.exec("PRAGMA journal_mode = WAL");

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in YAML config
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
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

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

  // Create vector table
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine)`);
}

function seedTestData(db: Database): void {
  const now = new Date().toISOString();

  // Note: Collections are now managed in YAML config, not in database
  // For tests, we'll use a collection name "docs"

  // Add test documents
  const docs = [
    {
      path: "readme.md",
      title: "Project README",
      hash: "hash1",
      body: "# Project README\n\nThis is the main readme file for the project.\n\nIt contains important information about setup and usage.",
    },
    {
      path: "api.md",
      title: "API Documentation",
      hash: "hash2",
      body: "# API Documentation\n\nThis document describes the REST API endpoints.\n\n## Authentication\n\nUse Bearer tokens for auth.",
    },
    {
      path: "meetings/meeting-2024-01.md",
      title: "January Meeting Notes",
      hash: "hash3",
      body: "# January Meeting Notes\n\nDiscussed Q1 goals and roadmap.\n\n## Action Items\n\n- Review budget\n- Hire new team members",
    },
    {
      path: "meetings/meeting-2024-02.md",
      title: "February Meeting Notes",
      hash: "hash4",
      body: "# February Meeting Notes\n\nFollowed up on Q1 progress.\n\n## Updates\n\n- Budget approved\n- Two candidates interviewed",
    },
    {
      path: "large-file.md",
      title: "Large Document",
      hash: "hash5",
      body: "# Large Document\n\n" + "Lorem ipsum ".repeat(2000), // ~24KB
    },
  ];

  for (const doc of docs) {
    // Insert content first
    db.prepare(`
      INSERT OR IGNORE INTO content (hash, doc, created_at)
      VALUES (?, ?, ?)
    `).run(doc.hash, doc.body, now);

    // Then insert document metadata
    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
      VALUES ('docs', ?, ?, ?, ?, ?, 1)
    `).run(doc.path, doc.title, doc.hash, now, now);
  }

  // Add embeddings for vector search
  const embedding = new Float32Array(768);
  for (let i = 0; i < 768; i++) embedding[i] = Math.random();

  for (const doc of docs.slice(0, 4)) { // Skip large file for embeddings
    db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'embeddinggemma', ?)`).run(doc.hash, now);
    db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${doc.hash}_0`, embedding);
  }
}

// =============================================================================
// MCP Server Test Helpers
// =============================================================================

// We need to create a testable version of the MCP handlers
// Since McpServer uses internal routing, we'll test the handler functions directly

import {
  searchFTS,
  searchVec,
  expandQuery,
  rerank,
  reciprocalRankFusion,
  extractSnippet,
  getContextForFile,
  findDocument,
  getDocumentBody,
  findDocuments,
  getStatus,
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_MULTI_GET_MAX_BYTES,
  createStore,
} from "../engine/repository.js";
import type { RankedResult } from "../engine/repository.js";
// Note: searchResultsToMcpCsv no longer used in MCP - using structuredContent instead

// =============================================================================
// Tests
// =============================================================================

describe("MCP Server", () => {
  beforeAll(async () => {
    // LlamaCpp uses node-llama-cpp for local model inference (no HTTP mocking needed)
    // Use shared singleton to avoid creating multiple instances with separate GPU resources
    getDefaultLLM();

    // Reset index name in case another test file mutated it (bun test shares process)
    setConfigIndexName("index");

    // Set up test config directory
    const configPrefix = join(tmpdir(), `kindx-mcp-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testConfigDir = await mkdtemp(configPrefix);
    process.env.KINDX_CONFIG_DIR = testConfigDir;

    // Create YAML config with test collection
    const testConfig: CollectionConfig = {
      collections: {
        docs: {
          path: "/test/docs",
          pattern: "**/*.md",
          context: {
            "/meetings": "Meeting notes and transcripts"
          }
        }
      }
    };
    await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(testConfig));

    testDbPath = `/tmp/kindx-mcp-test-${Date.now()}.sqlite`;
    testDb = openDatabase(testDbPath);
    initTestDatabase(testDb);
    seedTestData(testDb);
  });

  afterAll(async () => {
    testDb.close();
    try {
      unlinkSync(testDbPath);
    } catch { }

    // Clean up test config directory
    try {
      const files = await readdir(testConfigDir);
      for (const file of files) {
        await unlink(join(testConfigDir, file));
      }
      await rmdir(testConfigDir);
    } catch { }

    delete process.env.KINDX_CONFIG_DIR;
  });

  // ===========================================================================
  // Tool: qmd_search (BM25)
  // ===========================================================================

  describe("searchFTS (BM25 keyword search)", () => {
    test("returns results for matching query", () => {
      const results = searchFTS(testDb, "readme", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.displayPath).toBe("docs/readme.md");
    });

    test("returns empty for non-matching query", () => {
      const results = searchFTS(testDb, "xyznonexistent", 10);
      expect(results.length).toBe(0);
    });

    test("respects limit parameter", () => {
      const results = searchFTS(testDb, "meeting", 1);
      expect(results.length).toBe(1);
    });

    // Note: Collection filtering tests removed - collections are now managed in YAML, not DB

    test("formats results as structured content", () => {
      const results = searchFTS(testDb, "api", 10);
      const filtered = results.map(r => ({
        file: r.displayPath,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        context: getContextForFile(testDb, r.filepath),
        snippet: extractSnippet(r.body || "", "api", 300, r.chunkPos).snippet,
      }));
      // MCP now returns structuredContent with results array
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered[0]).toHaveProperty("file");
      expect(filtered[0]).toHaveProperty("title");
      expect(filtered[0]).toHaveProperty("score");
      expect(filtered[0]).toHaveProperty("snippet");
    });
  });

  // ===========================================================================
  // searchVec (Vector similarity search)
  // ===========================================================================

  describe.skipIf(!!process.env.CI)("searchVec (vector similarity)", () => {
    test("returns results for semantic query", async () => {
      const results = await searchVec(testDb, "project documentation", DEFAULT_EMBED_MODEL, 10);
      expect(results.length).toBeGreaterThan(0);
    });

    test("respects limit parameter", async () => {
      const results = await searchVec(testDb, "documentation", DEFAULT_EMBED_MODEL, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test("returns empty when no vector table exists", async () => {
      const emptyDb = openDatabase(":memory:");
      initTestDatabase(emptyDb);
      emptyDb.exec("DROP TABLE IF EXISTS vectors_vec");

      const results = await searchVec(emptyDb, "test", DEFAULT_EMBED_MODEL, 10);
      expect(results.length).toBe(0);
      emptyDb.close();
    });
  });

  // ===========================================================================
  // hybridQuery (query expansion + reranking)
  // ===========================================================================

  describe.skipIf(!!process.env.CI)("hybridQuery (expansion + reranking)", () => {
    test("expands query with typed variations", async () => {
      const expanded = await expandQuery("api documentation for the endpoints", DEFAULT_QUERY_MODEL, testDb);
      // Returns ExpandedQuery[] — typed expansions, original excluded
      expect(expanded.length).toBeGreaterThanOrEqual(1);
      for (const q of expanded) {
        expect(['lex', 'vec', 'hyde']).toContain(q.type);
        expect(q.text.length).toBeGreaterThan(0);
      }
    }, 30000); // 30s timeout for model loading

    test("performs RRF fusion on multiple result lists", () => {
      const list1: RankedResult[] = [
        { file: "/a", displayPath: "a.md", title: "A", body: "body", score: 1 },
        { file: "/b", displayPath: "b.md", title: "B", body: "body", score: 0.8 },
      ];
      const list2: RankedResult[] = [
        { file: "/b", displayPath: "b.md", title: "B", body: "body", score: 1 },
        { file: "/c", displayPath: "c.md", title: "C", body: "body", score: 0.9 },
      ];

      const fused = reciprocalRankFusion([list1, list2]);
      expect(fused.length).toBe(3);
      // B appears in both lists, should have higher score
      const bResult = fused.find(r => r.file === "/b");
      expect(bResult).toBeDefined();
    });

    test("reranks documents with LLM", async () => {
      const docs = [
        { file: "/test/docs/readme.md", text: "Project readme" },
        { file: "/test/docs/api.md", text: "API documentation" },
      ];
      const reranked = await rerank("readme", docs, DEFAULT_RERANK_MODEL, testDb);
      expect(reranked.length).toBe(2);
      expect(reranked[0]!.score).toBeGreaterThan(0);
    });

    test("full hybrid search pipeline", async () => {
      // Simulate full qmd_deep_search flow with type-routed queries
      const query = "meeting notes";
      const expanded = await expandQuery(query, DEFAULT_QUERY_MODEL, testDb);

      const rankedLists: RankedResult[][] = [];

      // Original query → FTS (probe)
      const probeFts = searchFTS(testDb, query, 20);
      if (probeFts.length > 0) {
        rankedLists.push(probeFts.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
      }

      // Expanded queries → route by type: lex→FTS, vec/hyde skipped (no vectors in test)
      for (const q of expanded) {
        if (q.type === 'lex') {
          const ftsResults = searchFTS(testDb, q.text, 20);
          if (ftsResults.length > 0) {
            rankedLists.push(ftsResults.map(r => ({
              file: r.filepath, displayPath: r.displayPath,
              title: r.title, body: r.body || "", score: r.score,
            })));
          }
        }
        // vec/hyde would go to searchVec — not available in this unit test
      }

      expect(rankedLists.length).toBeGreaterThan(0);

      const fused = reciprocalRankFusion(rankedLists);
      expect(fused.length).toBeGreaterThan(0);

      const candidates = fused.slice(0, 10);
      const reranked = await rerank(
        query,
        candidates.map(c => ({ file: c.file, text: c.body })),
        DEFAULT_RERANK_MODEL,
        testDb
      );

      expect(reranked.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Tool: qmd_get (Get Document)
  // ===========================================================================

  describe("qmd_get tool", () => {
    test("retrieves document by display_path", () => {
      const meta = findDocument(testDb, "readme.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta) ?? "";

      expect(meta.displayPath).toBe("docs/readme.md");
      expect(body).toContain("Project README");
    });

    test("retrieves document by filepath", () => {
      const meta = findDocument(testDb, "/test/docs/api.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      expect(meta.title).toBe("API Documentation");
    });

    test("retrieves document by partial path", () => {
      const result = findDocument(testDb, "api.md", { includeBody: false });
      expect("error" in result).toBe(false);
    });

    test("returns not found for missing document", () => {
      const result = findDocument(testDb, "nonexistent.md", { includeBody: false });
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toBe("not_found");
      }
    });

    test("suggests similar files when not found", () => {
      const result = findDocument(testDb, "readm.md", { includeBody: false }); // typo
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.similarFiles.length).toBeGreaterThanOrEqual(0);
      }
    });

    test("supports line range with :line suffix", () => {
      const meta = findDocument(testDb, "readme.md:2", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta, 2, 2) ?? "";
      const lines = body.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    test("supports fromLine parameter", () => {
      const meta = findDocument(testDb, "readme.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta, 3) ?? "";
      expect(body).not.toContain("# Project README");
    });

    test("supports maxLines parameter", () => {
      const meta = findDocument(testDb, "api.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta, 1, 3) ?? "";
      const lines = body.split("\n");
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    test("includes context for documents in context path", () => {
      const result = findDocument(testDb, "meetings/meeting-2024-01.md", { includeBody: false });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.context).toBe("Meeting notes and transcripts");
    });
  });

  // ===========================================================================
  // Tool: qmd_multi_get (Multi Get)
  // ===========================================================================

  describe("qmd_multi_get tool", () => {
    test("retrieves multiple documents by glob pattern", () => {
      const { docs, errors } = findDocuments(testDb, "meetings/*.md", { includeBody: true });
      expect(errors.length).toBe(0);
      expect(docs.length).toBe(2);
      const paths = docs.map(d => d.doc.displayPath);
      expect(paths).toContain("docs/meetings/meeting-2024-01.md");
      expect(paths).toContain("docs/meetings/meeting-2024-02.md");
    });

    test("retrieves documents by comma-separated list", () => {
      const { docs, errors } = findDocuments(testDb, "readme.md, api.md", { includeBody: true });
      expect(errors.length).toBe(0);
      expect(docs.length).toBe(2);
    });

    test("returns errors for missing files in comma list", () => {
      const { docs, errors } = findDocuments(testDb, "readme.md, nonexistent.md", { includeBody: true });
      expect(docs.length).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("not found");
    });

    test("skips files larger than maxBytes", () => {
      const { docs } = findDocuments(testDb, "*.md", { includeBody: true, maxBytes: 1000 }); // 1KB limit
      const large = docs.find(d => d.doc.displayPath === "docs/large-file.md");
      expect(large).toBeDefined();
      expect(large?.skipped).toBe(true);
      if (large?.skipped) expect(large.skipReason).toContain("too large");
    });

    test("respects maxLines parameter", () => {
      const { docs } = findDocuments(testDb, "readme.md", { includeBody: true, maxBytes: DEFAULT_MULTI_GET_MAX_BYTES });
      expect(docs.length).toBe(1);
      const d = docs[0]!;
      expect(d.skipped).toBe(false);
      if (d.skipped) return;
      if (!("body" in d.doc)) {
        throw new Error("Expected body to be included in findDocuments result");
      }
      const lines = (d.doc.body || "").split("\n").slice(0, 2);
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    test("returns error for non-matching glob", () => {
      const { docs, errors } = findDocuments(testDb, "nonexistent/*.md", { includeBody: true });
      expect(docs.length).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("No files matched");
    });

    test("includes context in results", () => {
      const { docs } = findDocuments(testDb, "meetings/meeting-2024-01.md", { includeBody: true });
      expect(docs.length).toBe(1);
      const d = docs[0]!;
      expect(d.skipped).toBe(false);
      if (d.skipped) return;
      if (!("context" in d.doc)) {
        throw new Error("Expected context to be present on document result");
      }
      expect(d.doc.context).toBe("Meeting notes and transcripts");
    });
  });

  // ===========================================================================
  // Tool: qmd_status
  // ===========================================================================

  describe("qmd_status tool", () => {
    test("returns index status", () => {
      const status = getStatus(testDb);
      expect(status.totalDocuments).toBe(5);
      expect(status.hasVectorIndex).toBe(true);
      expect(status.collections.length).toBe(1);
      expect(status.collections[0]!.path).toBe("/test/docs");
    });

    test("shows documents needing embedding", () => {
      const status = getStatus(testDb);
      // large-file.md doesn't have embeddings
      expect(status.needsEmbedding).toBe(1);
    });
  });

  // ===========================================================================
  // Resource: kindx://{path}
  // ===========================================================================

  describe("kindx:// resource", () => {
    test("lists all documents", () => {
      const docs = testDb.prepare(`
        SELECT path as display_path, title
        FROM documents
        WHERE active = 1
        ORDER BY modified_at DESC
        LIMIT 1000
      `).all() as { display_path: string; title: string }[];

      expect(docs.length).toBe(5);
      expect(docs.map(d => d.display_path)).toContain("readme.md");
    });

    test("reads document by display_path", () => {
      const path = "readme.md";
      const doc = testDb.prepare(`
        SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      expect(doc?.body).toContain("Project README");
    });

    test("reads document by URL-encoded path", () => {
      // Simulate URL encoding that MCP clients may send
      const encodedPath = "meetings%2Fmeeting-2024-01.md";
      const decodedPath = decodeURIComponent(encodedPath);

      const doc = testDb.prepare(`
        SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(decodedPath) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      expect(doc?.display_path).toBe("meetings/meeting-2024-01.md");
    });

    test("reads document by suffix match", () => {
      const path = "meeting-2024-01.md"; // without meetings/ prefix
      let doc = testDb.prepare(`
        SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      if (!doc) {
        doc = testDb.prepare(`
          SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${path}`) as { filepath: string; display_path: string; body: string } | null;
      }

      expect(doc).not.toBeNull();
      expect(doc?.display_path).toBe("meetings/meeting-2024-01.md");
    });

    test("returns not found for missing document", () => {
      const path = "nonexistent.md";
      const doc = testDb.prepare(`
        SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      expect(doc == null).toBe(true); // bun:sqlite returns null, better-sqlite3 returns undefined
    });

    test("includes context in document body", () => {
      const path = "meetings/meeting-2024-01.md";
      const doc = testDb.prepare(`
        SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      const context = getContextForFile(testDb, doc!.filepath);
      expect(context).toBe("Meeting notes and transcripts");

      // Verify context would be prepended
      let text = doc!.body;
      if (context) {
        text = `<!-- Context: ${context} -->\n\n` + text;
      }
      expect(text).toContain("<!-- Context: Meeting notes and transcripts -->");
    });

    test("handles URL-encoded special characters", () => {
      // Test various URL encodings
      const testCases = [
        { encoded: "readme.md", decoded: "readme.md" },
        { encoded: "meetings%2Fmeeting-2024-01.md", decoded: "meetings/meeting-2024-01.md" },
        { encoded: "api.md%3A10", decoded: "api.md:10" }, // with line number
      ];

      for (const { encoded, decoded } of testCases) {
        expect(decodeURIComponent(encoded)).toBe(decoded);
      }
    });

    test("handles double-encoded URLs", () => {
      // Some clients may double-encode
      const doubleEncoded = "meetings%252Fmeeting-2024-01.md";
      const singleDecoded = decodeURIComponent(doubleEncoded);
      expect(singleDecoded).toBe("meetings%2Fmeeting-2024-01.md");

      const fullyDecoded = decodeURIComponent(singleDecoded);
      expect(fullyDecoded).toBe("meetings/meeting-2024-01.md");
    });

    test("handles URL-encoded paths with spaces", () => {
      // Add a document with spaces in the path
      const now = new Date().toISOString();
      const body = "# Podcast Episode\n\nInterview content here.";
      const hash = "hash_spaces";
      const path = "External Podcast/2023 April - Interview.md";

      // Insert content first
      testDb.prepare(`
        INSERT OR IGNORE INTO content (hash, doc, created_at)
        VALUES (?, ?, ?)
      `).run(hash, body, now);

      // Then insert document metadata
      testDb.prepare(`
        INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
        VALUES ('docs', ?, ?, ?, ?, ?, 1)
      `).run(path, "Podcast Episode", hash, now, now);

      // Simulate URL-encoded path from MCP client
      const encodedPath = "External%20Podcast%2F2023%20April%20-%20Interview.md";
      const decodedPath = decodeURIComponent(encodedPath);

      expect(decodedPath).toBe("External Podcast/2023 April - Interview.md");

      const doc = testDb.prepare(`
        SELECT 'kindx://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(decodedPath) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      expect(doc?.display_path).toBe("External Podcast/2023 April - Interview.md");
      expect(doc?.body).toContain("Podcast Episode");
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("edge cases", () => {
    test("handles empty query", () => {
      const results = searchFTS(testDb, "", 10);
      expect(results.length).toBe(0);
    });

    test("handles special characters in query", () => {
      const results = searchFTS(testDb, "project's", 10);
      // Should not throw
      expect(Array.isArray(results)).toBe(true);
    });

    test("handles unicode in query", () => {
      const results = searchFTS(testDb, "文档", 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test("handles very long query", () => {
      const longQuery = "documentation ".repeat(100);
      const results = searchFTS(testDb, longQuery, 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test("handles query with only stopwords", () => {
      const results = searchFTS(testDb, "the and or", 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test("extracts snippet around matching text", () => {
      const body = "Line 1\nLine 2\nThis is the important line with the keyword\nLine 4\nLine 5";
      const { line, snippet } = extractSnippet(body, "keyword", 200);
      expect(snippet).toContain("keyword");
      expect(line).toBe(3);
    });

    test("handles snippet extraction with chunkPos", () => {
      const body = "A".repeat(1000) + "KEYWORD" + "B".repeat(1000);
      const chunkPos = 1000; // Position of KEYWORD
      const { snippet } = extractSnippet(body, "keyword", 200, chunkPos);
      expect(snippet).toContain("KEYWORD");
    });
  });

  // ===========================================================================
  // MCP Spec Compliance
  // ===========================================================================

  describe("MCP spec compliance", () => {
    test("encodeQmdPath preserves slashes but encodes special chars", () => {
      // Helper function behavior (tested indirectly through resource URIs)
      const path = "External Podcast/2023 April - Interview.md";
      const segments = path.split('/').map(s => encodeURIComponent(s)).join('/');
      expect(segments).toBe("External%20Podcast/2023%20April%20-%20Interview.md");
      expect(segments).toContain("/"); // Slashes preserved
      expect(segments).toContain("%20"); // Spaces encoded
    });

    test("search results have correct structure for structuredContent", () => {
      const results = searchFTS(testDb, "readme", 5);
      const structured = results.map(r => ({
        file: r.displayPath,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        context: getContextForFile(testDb, r.filepath),
        snippet: extractSnippet(r.body || "", "readme", 300, r.chunkPos).snippet,
      }));

      expect(structured.length).toBeGreaterThan(0);
      const item = structured[0]!;
      expect(typeof item.file).toBe("string");
      expect(typeof item.title).toBe("string");
      expect(typeof item.score).toBe("number");
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
      expect(typeof item.snippet).toBe("string");
    });

    test("error responses should include isError flag", () => {
      // Simulate what MCP server returns for errors
      const errorResponse = {
        content: [{ type: "text", text: "Collection not found: nonexistent" }],
        isError: true,
      };
      expect(errorResponse.isError).toBe(true);
      expect(errorResponse.content[0]!.type).toBe("text");
    });

    test("embedded resources include name and title", () => {
      // Simulate what qmd_get returns
      const meta = findDocument(testDb, "readme.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta) ?? "";
      const resource = {
        uri: `kindx://${meta.displayPath}`,
        name: meta.displayPath,
        title: meta.title,
        mimeType: "text/markdown",
        text: body,
      };
      expect(resource.name).toBe("docs/readme.md");
      expect(resource.title).toBe("Project README");
      expect(resource.mimeType).toBe("text/markdown");
    });

    test("status response includes structuredContent", () => {
      const status = getStatus(testDb);
      // Verify structure matches StatusResult type
      expect(typeof status.totalDocuments).toBe("number");
      expect(typeof status.needsEmbedding).toBe("number");
      expect(typeof status.hasVectorIndex).toBe("boolean");
      expect(Array.isArray(status.collections)).toBe(true);
      if (status.collections.length > 0) {
        const col = status.collections[0]!;
        expect(typeof col.name).toBe("string"); // Collections now use names, not IDs
        expect(typeof col.path).toBe("string");
        expect(typeof col.pattern).toBe("string");
        expect(typeof col.documents).toBe("number");
      }
    });
  });
});

// =============================================================================
// HTTP Transport Tests
// =============================================================================

import { startMcpHttpServer, bindHttpServerWithFallback, type HttpServerHandle, buildInstructionsForTest } from "../engine/protocol.js";
import { enableProductionMode } from "../engine/repository.js";
import { EventEmitter } from "node:events";
import { SessionRegistry } from "../engine/session.js";
import { KindxSession } from "../engine/session.js";

describe("MCP HTTP bind fallback", () => {
  test("falls back to 127.0.0.1 when localhost bind fails with retryable code", async () => {
    class FakeServer extends EventEmitter {
      attempt = 0;
      listen(_port: number, host: string) {
        this.attempt += 1;
        if (host === "localhost") {
          this.emit("error", Object.assign(new Error("blocked"), { code: "EPERM" }));
        } else {
          this.emit("listening");
        }
        return this as any;
      }
    }

    const server = new FakeServer() as unknown as import("http").Server;
    const host = await bindHttpServerWithFallback(server, 8181);
    expect(host).toBe("127.0.0.1");
  });
});

describe("MCP HTTP Transport", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let httpTestDbPath: string;
  let httpTestConfigDir: string;
  // Stash original env to restore after tests
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.KINDX_CONFIG_DIR;
  const origMcpToken = process.env.KINDX_MCP_TOKEN;
  const origMcpServersJson = process.env.KINDX_MCP_SERVERS_JSON;
  const testMcpToken = "kindx-test-token";

  beforeAll(async () => {
    // Create isolated test database with seeded data
    httpTestDbPath = `/tmp/kindx-mcp-http-test-${Date.now()}.sqlite`;
    const db = openDatabase(httpTestDbPath);
    initTestDatabase(db);
    seedTestData(db);
    db.close();

    // Create isolated YAML config
    const configPrefix = join(tmpdir(), `kindx-mcp-http-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    httpTestConfigDir = await mkdtemp(configPrefix);
    const testConfig: CollectionConfig = {
      collections: {
        docs: {
          path: "/test/docs",
          pattern: "**/*.md",
        }
      }
    };
    await writeFile(join(httpTestConfigDir, "index.yml"), YAML.stringify(testConfig));

    // Point createStore() at our test DB
    process.env.INDEX_PATH = httpTestDbPath;
    process.env.KINDX_CONFIG_DIR = httpTestConfigDir;
    process.env.KINDX_MCP_TOKEN = testMcpToken;
    process.env.KINDX_MCP_SERVERS_JSON = JSON.stringify({
      mcp_servers: {
        "kindx": {
          enabled_tools: [
            "query", "get", "status", 
            "memory_put", "memory_search", "memory_history", 
            "memory_stats", "memory_mark_accessed"
          ]
        }
      }
    });

    handle = await startMcpHttpServer(0, { quiet: true }); // OS-assigned ephemeral port
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();

    // Restore env
    if (origIndexPath !== undefined) process.env.INDEX_PATH = origIndexPath;
    else delete process.env.INDEX_PATH;
    if (origConfigDir !== undefined) process.env.KINDX_CONFIG_DIR = origConfigDir;
    else delete process.env.KINDX_CONFIG_DIR;
    if (origMcpToken !== undefined) process.env.KINDX_MCP_TOKEN = origMcpToken;
    else delete process.env.KINDX_MCP_TOKEN;
    if (origMcpServersJson !== undefined) process.env.KINDX_MCP_SERVERS_JSON = origMcpServersJson;
    else delete process.env.KINDX_MCP_SERVERS_JSON;

    // Clean up test files
    try { unlinkSync(httpTestDbPath); } catch { }
    try {
      const files = await readdir(httpTestConfigDir);
      for (const f of files) await unlink(join(httpTestConfigDir, f));
      await rmdir(httpTestConfigDir);
    } catch { }
  });

  // ---------------------------------------------------------------------------
  // Health & routing
  // ---------------------------------------------------------------------------

  test("GET /health returns 200 with status and uptime", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  test("GET /other returns 404", async () => {
    const res = await fetch(`${baseUrl}/other`, {
      headers: { "Authorization": `Bearer ${testMcpToken}` },
    });
    expect(res.status).toBe(404);
  });

  test("POST /mcp without bearer token returns 401 while /health stays open", async () => {
    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "unauth", version: "1.0" },
        },
      }),
    });
    expect(unauthorized.status).toBe(401);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // MCP protocol over HTTP
  // ---------------------------------------------------------------------------

  /** Track session ID returned by initialize (MCP Streamable HTTP spec) */
  let sessionId: string | null = null;

  /** Send a JSON-RPC message to /mcp and return the parsed response.
   * MCP Streamable HTTP requires Accept header with both JSON and SSE. */
  async function mcpRequest(body: object): Promise<{ status: number; json: any; contentType: string | null }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${testMcpToken}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    // Capture session ID from initialize responses
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    const json = await res.json();
    return { status: res.status, json, contentType: res.headers.get("content-type") };
  }

  test("POST /mcp initialize returns 200 JSON (not SSE)", async () => {
    const { status, json, contentType } = await mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result.serverInfo.name).toBe("kindx");
  });

  test("POST /mcp tools/list returns registered tools", async () => {
    // Initialize first (required by MCP protocol)
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const { status, json, contentType } = await mcpRequest({
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    });
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");

    const toolNames = json.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("query");
    expect(toolNames).toContain("get");
    expect(toolNames).toContain("status");
    expect(toolNames).toContain("memory_put");
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_history");
    expect(toolNames).toContain("memory_stats");
    expect(toolNames).toContain("memory_mark_accessed");
  });

  test("POST /mcp tools/call query returns results", async () => {
    // Initialize
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const { status, json } = await mcpRequest({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "query", arguments: { searches: [{ type: "lex", query: "readme" }] } },
    });
    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    // Should have content array with text results
    expect(json.result.content.length).toBeGreaterThan(0);
    expect(json.result.content[0].type).toBe("text");
    expect(json.result.structuredContent).toBeDefined();
    expect(json.result.structuredContent.timings).toBeDefined();
    expect(typeof json.result.structuredContent.timings.total_ms).toBe("number");
  });

  test("POST /mcp tools/call status includes operational diagnostics", async () => {
    await mcpRequest({
      jsonrpc: "2.0", id: 90, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const { status, json } = await mcpRequest({
      jsonrpc: "2.0", id: 91, method: "tools/call",
      params: { name: "status", arguments: {} },
    });
    expect(status).toBe(200);
    expect(json.result.structuredContent).toBeDefined();
    expect(typeof json.result.structuredContent.vector_available).toBe("boolean");
    expect(typeof json.result.structuredContent.models_ready).toBe("boolean");
    expect(typeof json.result.structuredContent.db_integrity).toBe("string");
    expect(Array.isArray(json.result.structuredContent.warnings)).toBe(true);
    expect(json.result.structuredContent.shards).toBeDefined();
    expect(Array.isArray(json.result.structuredContent.shards.enabledCollections)).toBe(true);
    expect(typeof json.result.structuredContent.shards.checkpointPath).toBe("string");
    expect(typeof json.result.structuredContent.shards.checkpointExists).toBe("boolean");
    expect(Array.isArray(json.result.structuredContent.shards.warnings)).toBe(true);
    expect(json.result.structuredContent.scale).toBeDefined();
    expect(typeof json.result.structuredContent.scale.queueDepth).toBe("number");
    expect(typeof json.result.structuredContent.scale.rerankConcurrency).toBe("number");
    expect(json.result.structuredContent.scale.shardHealth).toBeDefined();
    expect(typeof json.result.structuredContent.scale.shardHealth.status).toBe("string");
  });

  test("POST /query includes timing metadata", async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testMcpToken}`,
      },
      body: JSON.stringify({
        searches: [{ type: "lex", query: "readme" }],
        limit: 5,
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.metadata).toBeDefined();
    expect(body.metadata.timings).toBeDefined();
    expect(typeof body.metadata.timings.total_ms).toBe("number");
    expect(Array.isArray(body.metadata.fallback_reasons)).toBe(true);
    expect(body.metadata.diagnostics).toBeDefined();
    expect(Array.isArray(body.metadata.diagnostics.scaleWarnings)).toBe(true);
    expect(typeof body.metadata.diagnostics.candidateLimit).toBe("number");
    expect(typeof body.metadata.diagnostics.rerankLimit).toBe("number");
    expect(body.metadata.diagnostics.planner).toBeDefined();
    expect(Array.isArray(body.metadata.diagnostics.planner.policy.precedence)).toBe(true);
    expect(typeof body.metadata.diagnostics.planner.appliedLimits.candidateLimit).toBe("number");
    expect(Array.isArray(body.metadata.diagnostics.planner.degradedReasons)).toBe(true);
    expect(body.metadata.diagnostics.throughput).toBeDefined();
    expect(typeof body.metadata.diagnostics.throughput.queue.depth).toBe("number");
    expect(body.metadata.diagnostics.throughput.queue.fairness).toBeDefined();
    expect(typeof body.metadata.diagnostics.throughput.queue.fairness.enqueued).toBe("number");
    expect(typeof body.metadata.diagnostics.throughput.queue.fairness.deferredServed).toBe("number");
  });

  test("query candidate clamp applies maxRerankCandidates precedence with explicit diagnostics", async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testMcpToken}`,
      },
      body: JSON.stringify({
        searches: [{ type: "lex", query: "meeting notes roadmap" }],
        candidateLimit: 50,
        maxRerankCandidates: 3,
        limit: 5,
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metadata?.diagnostics?.candidateLimit).toBe(3);
    expect(Array.isArray(body.metadata?.diagnostics?.scaleWarnings)).toBe(true);
    expect(body.metadata.diagnostics.scaleWarnings.some((w: string) => w.startsWith("candidate_limit_clamped:"))).toBe(true);
    expect(Array.isArray(body.metadata?.fallback_reasons)).toBe(true);
    expect(body.metadata.fallback_reasons).toContain("rerank_truncated");
    expect(body.metadata.diagnostics.planner.appliedLimits.candidateLimit).toBe(3);
  });

  test("query rerank timeout fallback preserves response with explicit timeout reason", async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testMcpToken}`,
      },
      body: JSON.stringify({
        searches: [{ type: "lex", query: "project readme setup usage" }],
        limit: 5,
        rerankTimeoutMs: 1,
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.metadata.fallback_reasons).toContain("rerank_timeout");
    expect(body.metadata.diagnostics.scaleWarnings.some((w: string) => w.startsWith("rerank_timeout_ms:"))).toBe(true);
    expect(body.metadata.diagnostics.planner.degradedReasons).toContain("rerank_timeout");
    expect(body.metadata.diagnostics.throughput).toBeDefined();
    expect(body.metadata.diagnostics.throughput.queue).toBeDefined();
    expect(typeof body.metadata.diagnostics.throughput.queue.depth).toBe("number");
    expect(typeof body.metadata.diagnostics.throughput.queue.active).toBe("number");
    expect(typeof body.metadata.diagnostics.throughput.queue.concurrency).toBe("number");
    expect(typeof body.metadata.diagnostics.throughput.queue.dropPolicy).toBe("string");
    expect(body.metadata.diagnostics.throughput.queue.fairness).toBeDefined();
    expect(typeof body.metadata.diagnostics.throughput.queue.fairness.enqueued).toBe("number");
  });

  test("query contention emits deterministic queue diagnostics on saturation/defer paths", async () => {
    const prevQueueLimit = process.env.KINDX_RERANK_QUEUE_LIMIT;
    const prevConcurrency = process.env.KINDX_RERANK_CONCURRENCY;
    const prevDropPolicy = process.env.KINDX_RERANK_DROP_POLICY;
    process.env.KINDX_RERANK_QUEUE_LIMIT = "1";
    process.env.KINDX_RERANK_CONCURRENCY = "1";
    process.env.KINDX_RERANK_DROP_POLICY = "timeout_fallback";

    try {
      const makeReq = (i: number) => fetch(`${baseUrl}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${testMcpToken}`,
        },
        body: JSON.stringify({
          searches: [{ type: "lex", query: `project readme setup usage q${i}` }],
          limit: 5,
          rerankTimeoutMs: 2500,
          rerankQueueLimit: 1,
          rerankConcurrency: 1,
          rerankDropPolicy: "timeout_fallback",
        }),
      });

      const responses = await Promise.all([makeReq(1), makeReq(2), makeReq(3), makeReq(4), makeReq(5), makeReq(6)]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      for (const res of responses) expect(res.status).toBe(200);
      for (const body of bodies) {
        expect(body.metadata?.diagnostics?.throughput?.queue).toBeDefined();
        expect(typeof body.metadata.diagnostics.throughput.queue.depth).toBe("number");
        expect(typeof body.metadata.diagnostics.throughput.queue.active).toBe("number");
        expect(typeof body.metadata.diagnostics.throughput.queue.concurrency).toBe("number");
        expect(Array.isArray(body.metadata?.fallback_reasons)).toBe(true);
      }

      const flattenedReasons = bodies.flatMap((b) => Array.isArray(b.metadata?.fallback_reasons) ? b.metadata.fallback_reasons : []);
      expect(Array.isArray(flattenedReasons)).toBe(true);
      expect(flattenedReasons.every((reason) => typeof reason === "string")).toBe(true);
    } finally {
      if (prevQueueLimit === undefined) delete process.env.KINDX_RERANK_QUEUE_LIMIT;
      else process.env.KINDX_RERANK_QUEUE_LIMIT = prevQueueLimit;
      if (prevConcurrency === undefined) delete process.env.KINDX_RERANK_CONCURRENCY;
      else process.env.KINDX_RERANK_CONCURRENCY = prevConcurrency;
      if (prevDropPolicy === undefined) delete process.env.KINDX_RERANK_DROP_POLICY;
      else process.env.KINDX_RERANK_DROP_POLICY = prevDropPolicy;
    }
  });

  test("POST /mcp tools/call get returns document", async () => {
    // Initialize
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const { status, json } = await mcpRequest({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "get", arguments: { file: "readme.md" } },
    });
    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    expect(json.result.content.length).toBeGreaterThan(0);
  });

  test("same session supports repeated tool calls and keeps MCP contract stable", async () => {
    sessionId = null;
    await mcpRequest({
      jsonrpc: "2.0", id: 51, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "repeat-client", version: "1.0" } },
    });
    expect(sessionId).toBeTruthy();

    const first = await mcpRequest({
      jsonrpc: "2.0", id: 52, method: "tools/call",
      params: { name: "query", arguments: { searches: [{ type: "lex", query: "meeting" }] } },
    });
    expect(first.status).toBe(200);
    expect(first.json.result.structuredContent).toBeDefined();

    const second = await mcpRequest({
      jsonrpc: "2.0", id: 53, method: "tools/call",
      params: { name: "query", arguments: { searches: [{ type: "lex", query: "meeting" }] } },
    });
    expect(second.status).toBe(200);
    expect(second.json.result.structuredContent).toBeDefined();
    expect(typeof second.json.result.structuredContent.timings.total_ms).toBe("number");
  });

  test("DELETE /mcp closes session and subsequent calls with stale session id fail", async () => {
    sessionId = null;
    await mcpRequest({
      jsonrpc: "2.0", id: 61, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "close-client", version: "1.0" } },
    });
    const closedSessionId = sessionId;
    expect(closedSessionId).toBeTruthy();

    const deleteRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${testMcpToken}`,
        "mcp-session-id": closedSessionId || "",
      },
    });
    expect(deleteRes.status).toBe(200);

    const staleRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${testMcpToken}`,
        "mcp-session-id": closedSessionId || "",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 62,
        method: "tools/list",
        params: {},
      }),
    });
    expect(staleRes.status).toBe(404);
    const staleBody = await staleRes.json();
    expect(staleBody.error.message).toContain("Session not found");
  });

  test("session registry remains bounded under create/close cycles", async () => {
    const baseline = SessionRegistry.size;

    for (let i = 0; i < 5; i++) {
      let localSid: string | null = null;
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${testMcpToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 70 + i,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "bounded-client", version: "1.0" },
          },
        }),
      });
      localSid = initRes.headers.get("mcp-session-id");
      expect(initRes.status).toBe(200);
      expect(localSid).toBeTruthy();

      const closeRes = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${testMcpToken}`,
          "mcp-session-id": localSid || "",
        },
      });
      expect(closeRes.status).toBe(200);
    }

    // Registry may still contain entries from the shared test session,
    // but it must stay bounded and not grow linearly with close cycles.
    expect(SessionRegistry.size).toBeLessThanOrEqual(baseline + 2);
  });

  test("server uses dbPath instead of default index.sqlite", async () => {
    const originalIndexPath = process.env.INDEX_PATH;
    delete process.env.INDEX_PATH;

    const testHandle = await startMcpHttpServer(0, { quiet: true, dbPath: httpTestDbPath });
    const testBaseUrl = `http://localhost:${testHandle.port}`;

    let localSessionId: string | null = null;
    try {
      const res = await fetch(`${testBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${testMcpToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        }),
      });
      localSessionId = res.headers.get("mcp-session-id");
      expect(res.status).toBe(200);

      const searchRes = await fetch(`${testBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${testMcpToken}`,
          "mcp-session-id": localSessionId || "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "query", arguments: { searches: [{ type: "lex", query: "readme" }] } },
        }),
      });

      const searchJson = await searchRes.json();
      expect(searchRes.status).toBe(200);
      expect(searchJson.result.content.length).toBeGreaterThan(0);
    } finally {
      await testHandle.stop();
      if (originalIndexPath !== undefined) process.env.INDEX_PATH = originalIndexPath;
    }
  });

  test("memory tools work end-to-end in one scoped session", async () => {
    sessionId = null;
    await mcpRequest({
      jsonrpc: "2.0",
      id: 101,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
        rootUri: "file:///tmp/workspace-alpha",
      },
    });

    const put = await mcpRequest({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "memory_put",
        arguments: {
          key: "profile:role",
          value: "engineer",
          tags: ["profile"],
          source: "test",
        },
      },
    });
    expect(put.status).toBe(200);
    const putStructured = put.json?.result?.structuredContent;
    const resolvedScope = String(putStructured?.scope ?? "");
    expect(resolvedScope.length).toBeGreaterThan(0);
    const memoryId = Number(
      putStructured?.memory?.id ?? "0"
    );
    expect(memoryId).toBeGreaterThan(0);

    const search = await mcpRequest({
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: {
          query: "engineer",
          mode: "text",
        },
      },
    });
    expect(search.status).toBe(200);
    expect(search.json.result.structuredContent.results.length).toBeGreaterThan(0);

    const history = await mcpRequest({
      jsonrpc: "2.0",
      id: 104,
      method: "tools/call",
      params: {
        name: "memory_history",
        arguments: { key: "profile:role" },
      },
    });
    expect(history.status).toBe(200);
    expect(history.json.result.structuredContent.history.length).toBeGreaterThan(0);

    const mark = await mcpRequest({
      jsonrpc: "2.0",
      id: 105,
      method: "tools/call",
      params: {
        name: "memory_mark_accessed",
        arguments: { id: memoryId },
      },
    });
    expect(mark.status).toBe(200);
    expect(mark.json.result.structuredContent.marked).toBe(true);

    const stats = await mcpRequest({
      jsonrpc: "2.0",
      id: 106,
      method: "tools/call",
      params: {
        name: "memory_stats",
        arguments: {},
      },
    });
    expect(stats.status).toBe(200);
    const statsScope = String(stats.json?.result?.structuredContent?.scope ?? "");
    expect(statsScope.length).toBeGreaterThan(0);
    const totalMemories = Number(stats.json?.result?.structuredContent?.totalMemories ?? 0);
    expect(totalMemories).toBeGreaterThan(0);
  });

  test("initialize instructions include bounded memory prefetch only when scope has entries", async () => {
    sessionId = null;
    const init = await mcpRequest({
      jsonrpc: "2.0",
      id: 401,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "prefetch-client", version: "1.0" },
        rootUri: "file:///tmp/workspace-prefetch",
      },
    });
    expect(init.status).toBe(200);
    const initialInstructions = String(init.json?.result?.instructions ?? "");
    expect(initialInstructions.includes("Workspace memory (top accessed):")).toBe(false);

    // Insert more than 3 entries; initialize should still show a bounded subset.
    let resolvedScope = "workspace-prefetch";
    for (let i = 0; i < 5; i++) {
      const put = await mcpRequest({
        jsonrpc: "2.0",
        id: 410 + i,
        method: "tools/call",
        params: {
          name: "memory_put",
          arguments: {
            key: `prefetch:key:${i}`,
            value: `value-${i} ` + "x".repeat(300),
          },
        },
      });
      expect(put.status).toBe(200);
      resolvedScope = String(put.json?.result?.structuredContent?.scope ?? resolvedScope);
    }

    // Validate the bounded memory block directly via test hook.
    const store = createStore(httpTestDbPath);
    const instructions = buildInstructionsForTest(
      store,
      new KindxSession({ workspaceScope: resolvedScope })
    );
    store.close();

    expect(resolvedScope.length).toBeGreaterThan(0);
    expect(instructions.includes("Workspace memory (top accessed):")).toBe(true);

    const memoryLines = instructions
      .split("\n")
      .filter((line) => line.trimStart().startsWith("- value-"));
    expect(memoryLines.length).toBeGreaterThan(0);
    expect(memoryLines.length).toBeLessThanOrEqual(3);
    for (const line of memoryLines) {
      expect(line.length).toBeLessThanOrEqual(130);
    }
  });

  test("memory tools reject explicit cross-scope access", async () => {
    sessionId = null;
    await mcpRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
        rootUri: "file:///tmp/workspace-alpha",
      },
    });

    const denied = await mcpRequest({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: {
        name: "memory_put",
        arguments: {
          scope: "workspace-beta",
          key: "profile:city",
          value: "Austin",
        },
      },
    });

    expect(denied.status).toBe(200);
    expect(denied.json.result.isError).toBe(true);
    expect(denied.json.result.content[0].text).toContain("cross_scope_forbidden");
  });

  test("memory tools fall back to default scope when no session scope exists", async () => {
    sessionId = null;
    await mcpRequest({
      jsonrpc: "2.0",
      id: 301,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    const put = await mcpRequest({
      jsonrpc: "2.0",
      id: 302,
      method: "tools/call",
      params: {
        name: "memory_put",
        arguments: { key: "profile:language", value: "TypeScript" },
      },
    });
    expect(put.status).toBe(200);
    const fallbackScope = String(put.json?.result?.structuredContent?.scope ?? "");
    expect(fallbackScope.length).toBeGreaterThan(0);
  });
});

describe("MCP HTTP Transport RBAC collection isolation", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let dbPath: string;
  let configDir: string;
  let viewerToken: string;

  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.KINDX_CONFIG_DIR;
  const origMcpToken = process.env.KINDX_MCP_TOKEN;
  const origMcpServersJson = process.env.KINDX_MCP_SERVERS_JSON;

  beforeAll(async () => {
    dbPath = `/tmp/kindx-mcp-rbac-test-${Date.now()}.sqlite`;
    const db = openDatabase(dbPath);
    initTestDatabase(db);
    seedTestData(db);

    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
      .run("secret-hash", "# Secret Plan\n\nclassified launch sequencing\n", now);
    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
      VALUES ('secret', ?, ?, ?, ?, ?, 1)
    `).run("plan.md", "Secret Plan", "secret-hash", now, now);
    db.close();

    configDir = await mkdtemp(join(tmpdir(), `kindx-mcp-rbac-config-${Date.now()}-`));
    const cfg: CollectionConfig = {
      collections: {
        docs: { path: "/test/docs", pattern: "**/*.md" },
        secret: { path: "/test/secret", pattern: "**/*.md" },
      },
    };
    await writeFile(join(configDir, "index.yml"), YAML.stringify(cfg));

    process.env.INDEX_PATH = dbPath;
    process.env.KINDX_CONFIG_DIR = configDir;
    delete process.env.KINDX_MCP_TOKEN;

    const rbac = await import("../engine/rbac.js");
    rbac.__resetTenantRegistryCacheForTests();
    const created = rbac.createTenant("viewer-rbac", "Viewer RBAC", "viewer", ["docs"]);
    viewerToken = created.plaintextToken;

    process.env.KINDX_MCP_SERVERS_JSON = JSON.stringify({
      mcp_servers: {
        "kindx": {
          enabled_tools: ["query", "get", "status"]
        }
      }
    });

    handle = await startMcpHttpServer(0, { quiet: true });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();

    const rbac = await import("../engine/rbac.js");
    rbac.__resetTenantRegistryCacheForTests();

    if (origIndexPath !== undefined) process.env.INDEX_PATH = origIndexPath;
    else delete process.env.INDEX_PATH;
    if (origConfigDir !== undefined) process.env.KINDX_CONFIG_DIR = origConfigDir;
    else delete process.env.KINDX_CONFIG_DIR;
    if (origMcpToken !== undefined) process.env.KINDX_MCP_TOKEN = origMcpToken;
    else delete process.env.KINDX_MCP_TOKEN;
    if (origMcpServersJson !== undefined) process.env.KINDX_MCP_SERVERS_JSON = origMcpServersJson;
    else delete process.env.KINDX_MCP_SERVERS_JSON;

    try { unlinkSync(dbPath); } catch { }
    try {
      const files = await readdir(configDir);
      for (const f of files) await unlink(join(configDir, f));
      await rmdir(configDir);
    } catch { }
  });

  test("POST /query rejects requests when all requested collections are unauthorized", async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({
        searches: [{ type: "lex", query: "classified" }],
        collections: ["secret"],
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(String(body.error || "")).toContain("has no access to the requested collections");
  });

  test("POST /query filters mixed collection requests to allowed collections only", async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({
        searches: [{ type: "lex", query: "project" }],
        collections: ["docs", "secret"],
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.some((r: any) => String(r.file || "").startsWith("secret/"))).toBe(false);
  });

  test("MCP tools/call query applies RBAC collection scope when collections are omitted", async () => {
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "rbac-test", version: "1.0.0" },
        },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(initRes.status).toBe(200);
    expect(sessionId).toBeTruthy();

    const queryRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${viewerToken}`,
        "mcp-session-id": String(sessionId),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "query",
          arguments: {
            searches: [{ type: "lex", query: "classified" }],
          },
        },
      }),
    });
    const body = await queryRes.json();
    expect(queryRes.status).toBe(200);
    const resultText = String(body?.result?.content?.[0]?.text ?? "");
    const structuredResults = body?.result?.structuredContent?.results;
    expect(Array.isArray(structuredResults)).toBe(true);
    expect(structuredResults.length).toBe(0);
    expect(resultText).not.toContain("secret/plan.md");
  });

  test("POST /query returns 429 when tenant exceeds configured rate limit", async () => {
    const origBurst = process.env.KINDX_RATE_LIMIT_BURST;
    const origRateMs = process.env.KINDX_RATE_LIMIT_MS;
    process.env.KINDX_RATE_LIMIT_BURST = "1";
    process.env.KINDX_RATE_LIMIT_MS = "60000";

    const rbac = await import("../engine/rbac.js");
    rbac.__resetRateLimitsForTests();

    try {
      const reqBody = JSON.stringify({
        searches: [{ type: "lex", query: "project" }],
        collections: ["docs"],
      });

      const first = await fetch(`${baseUrl}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${viewerToken}`,
        },
        body: reqBody,
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${baseUrl}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${viewerToken}`,
        },
        body: reqBody,
      });
      const secondBody = await second.json();
      expect(second.status).toBe(429);
      expect(String(secondBody.error || "")).toContain("Rate limit exceeded for tenant 'viewer-rbac'");
    } finally {
      rbac.__resetRateLimitsForTests();
      if (origBurst !== undefined) process.env.KINDX_RATE_LIMIT_BURST = origBurst;
      else delete process.env.KINDX_RATE_LIMIT_BURST;
      if (origRateMs !== undefined) process.env.KINDX_RATE_LIMIT_MS = origRateMs;
      else delete process.env.KINDX_RATE_LIMIT_MS;
    }
  });
});
