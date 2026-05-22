import { describe, it, expect, vi } from "vitest";
import { buildCapabilityManifest, type ToolRegistration, SERVER_VERSION } from "../engine/capability-manifest.js";

vi.mock("../engine/diagnostics.js", () => ({
  buildOperationalStatus: vi.fn(() => ({
    models_ready: true,
    warnings: [],
  })),
}));

function mockStore(overrides: Record<string, unknown> = {}) {
  return {
    db: {},
    dbPath: "/tmp/test.db",
    getStatus: () => ({
      totalDocuments: 42,
      needsEmbedding: 3,
      hasVectorIndex: true,
      models_ready: true,
      ann: { state: "ready", mode: "ann" },
      encryption: { encrypted: false, keyConfigured: false },
      collections: [
        { name: "docs", path: "/tmp/docs", documents: 30, pattern: "**/*.md", lastUpdated: "2026-01-01" },
        { name: "notes", path: "/tmp/notes", documents: 12, pattern: "**/*.md", lastUpdated: "2026-01-01" },
      ],
      ...overrides,
    }),
  } as any;
}

const sampleTools: ToolRegistration[] = [
  {
    name: "query",
    description: "Search the knowledge base",
    readOnly: true,
    inputSchema: { searches: { type: "array" } },
  },
  {
    name: "get",
    description: "Retrieve a document",
    readOnly: true,
    inputSchema: { file: { type: "string" } },
  },
];

describe("buildCapabilityManifest", () => {
  it("returns correct version and server info", () => {
    const manifest = buildCapabilityManifest(mockStore(), []);
    expect(manifest.version).toBe("1.0");
    expect(manifest.server.name).toBe("kindx");
    expect(manifest.server.protocol).toBe("mcp/2025-06-18");
    expect(manifest.server.version).toBe(SERVER_VERSION);
  });

  it("includes registered tools", () => {
    const manifest = buildCapabilityManifest(mockStore(), sampleTools);
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools[0].name).toBe("query");
    expect(manifest.tools[0].readOnly).toBe(true);
    expect(manifest.tools[1].name).toBe("get");
  });

  it("includes query types", () => {
    const manifest = buildCapabilityManifest(mockStore(), []);
    expect(manifest.queryTypes.supported).toEqual(["lex", "vec", "hyde"]);
    expect(manifest.queryTypes.autoClassify).toBe(true);
    expect(manifest.queryTypes.strategies).toEqual(["exact", "question", "analytical"]);
  });

  it("includes collections from store", () => {
    const manifest = buildCapabilityManifest(mockStore(), []);
    expect(manifest.collections).toHaveLength(2);
    expect(manifest.collections[0].name).toBe("docs");
    expect(manifest.collections[0].documents).toBe(30);
    expect(manifest.collections[0].path).toBe("/tmp/docs");
  });

  it("includes runtime state", () => {
    const manifest = buildCapabilityManifest(mockStore(), []);
    expect(manifest.runtime.totalDocuments).toBe(42);
    expect(manifest.runtime.vectorIndex.available).toBe(true);
    expect(manifest.runtime.vectorIndex.state).toBe("ready");
    expect(manifest.runtime.encryption.enabled).toBe(false);
    expect(manifest.runtime.encryption.keyConfigured).toBe(false);
    expect(manifest.runtime.modelsReady).toBe(true);
  });

  it("handles store.getStatus() throwing", () => {
    const brokenStore = {
      db: {},
      dbPath: "/tmp/test.db",
      getStatus: () => { throw new Error("database locked"); },
    } as any;
    const manifest = buildCapabilityManifest(brokenStore, []);
    expect(manifest.runtime.error).toBe("database locked");
    expect(manifest.runtime.totalDocuments).toBe(0);
  });

  it("handles empty tools list", () => {
    const manifest = buildCapabilityManifest(mockStore(), []);
    expect(manifest.tools).toEqual([]);
  });

  it("handles empty collections", () => {
    const store = mockStore({ collections: [] });
    const manifest = buildCapabilityManifest(store, []);
    expect(manifest.collections).toEqual([]);
  });

  it("handles missing ann state gracefully", () => {
    const store = mockStore({ ann: undefined });
    const manifest = buildCapabilityManifest(store, []);
    expect(manifest.runtime.vectorIndex.state).toBe("unknown");
  });

  it("handles missing encryption gracefully", () => {
    const store = mockStore({ encryption: undefined });
    const manifest = buildCapabilityManifest(store, []);
    expect(manifest.runtime.encryption.enabled).toBe(false);
    expect(manifest.runtime.encryption.keyConfigured).toBe(false);
  });

  it("preserves tool inputSchema", () => {
    const manifest = buildCapabilityManifest(mockStore(), sampleTools);
    expect(manifest.tools[0].inputSchema).toEqual({ searches: { type: "array" } });
    expect(manifest.tools[1].inputSchema).toEqual({ file: { type: "string" } });
  });
});
