/**
 * specs/protocol-initialize-smoke.test.ts
 *
 * End-to-end smoke test for the MCP `initialize` flow.
 *
 * Spins up a real KINDX McpServer in-process, pairs it with a Client via
 * InMemoryTransport, and asserts that:
 *   1. The `instructions` field from the initialize result contains the
 *      auto-invocation contract text (reaching the client side).
 *   2. The `query` tool description leads with "Call this first".
 *
 * Mirrors the setup pattern from specs/protocol-instructions.test.ts using
 * real on-disk SQLite + YAML catalog (no mocks) so getStatus() reflects a
 * real collection, which is required for the contract to be emitted.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import YAML from "yaml";
import { openDatabase } from "../engine/runtime.js";
import { setConfigIndexName, type CollectionConfig } from "../engine/catalogs.js";
import { startMcpServerForTest } from "../engine/protocol.js";
import { initTestDatabase, seedCollection } from "./helpers/db-helpers.js";

// =============================================================================
// Fixture helpers (mirrors protocol-instructions.test.ts)
// =============================================================================

interface Fixture {
  dbPath: string;
  configDir: string;
  indexName: string;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const configDir = mkdtempSync(join(tmpdir(), `kindx-smoke-cfg-${stamp}-`));
  const indexName = `smoke-${stamp}`;
  const dbPath = join(tmpdir(), `kindx-smoke-${stamp}.sqlite`);

  process.env.KINDX_CONFIG_DIR = configDir;
  setConfigIndexName(indexName);

  // Write a minimal catalog with one collection
  const docsDir = join(configDir, "notes");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "a.md"), "# A\nhello world\n");

  const cfg: CollectionConfig = {
    collections: {
      notes: { path: docsDir, pattern: "**/*.md" } as any,
    },
  };
  writeFileSync(join(configDir, `${indexName}.yml`), YAML.stringify(cfg));

  // Initialise the on-disk database and seed the collection
  const db = openDatabase(dbPath);
  initTestDatabase(db);
  seedCollection(db, "notes", [{ path: "a.md", title: "A", body: "hello world" }]);
  db.close();

  return {
    dbPath,
    configDir,
    indexName,
    cleanup: () => {
      try { unlinkSync(dbPath); } catch { /* ignore */ }
      try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("MCP initialize smoke — contract is delivered", () => {
  let fixture: Fixture;
  let prevEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot env so we can fully restore it (including deletions)
    prevEnv = { ...process.env };
    fixture = setupFixture();
  });

  afterEach(() => {
    // Restore all env variables
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setConfigIndexName(""); // reset catalog index name cache
    fixture.cleanup();
  });

  test("initialize result contains auto-invocation contract and query tool leads with WHEN / Call this first", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const server = startMcpServerForTest({
      dbPath: fixture.dbPath,
      indexName: fixture.indexName,
    });
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    // --- Assert auto-invocation contract is present in initialize instructions ---
    const instructions: string = client.getInstructions() ?? "";

    expect(
      instructions,
      "instructions should be non-empty (auto-invocation contract suppressed?)",
    ).not.toBe("");

    expect(
      instructions,
      "missing auto-invocation contract section header",
    ).toContain("When to call KINDX (auto-invocation contract)");

    expect(
      instructions,
      "missing Decision table reference",
    ).toContain("Decision table");

    expect(
      instructions,
      'missing collection name "notes" in contract',
    ).toContain('"notes"');

    // --- Assert query tool description leads with "Call this first" ---
    const { tools } = await client.listTools();
    const query = tools.find((t) => t.name === "query");

    expect(query, "query tool not listed by server").toBeDefined();
    expect(
      query!.description!.split("\n")[0],
      'query tool description first line should contain "Call this first"',
    ).toContain("Call this first");

    await client.close();
    await server.close();
  });
});
