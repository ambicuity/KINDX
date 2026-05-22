# Capability Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kindx://capabilities` MCP resource that returns a machine-readable JSON manifest of available tools, query types, collections, and runtime state.

**Architecture:** A new `engine/capability-manifest.ts` module exports a `buildCapabilityManifest()` function. `engine/protocol.ts` registers the resource and tracks tool definitions during registration.

**Tech Stack:** TypeScript, Zod (for schema types), MCP SDK (`@modelcontextprotocol/sdk`), Vitest

---

## File Structure

| File | Responsibility |
|------|----------------|
| `engine/capability-manifest.ts` | **New.** Types (`CapabilityManifest`, `ToolRegistration`) + `buildCapabilityManifest()` function |
| `engine/protocol.ts` | **Modify.** Track tool defs in `createMcpServer()`, register `kindx://capabilities` resource |
| `engine/capability-manifest.test.ts` | **New.** Unit tests for manifest builder |

---

### Task 1: Create capability-manifest.ts with types and builder function

**Files:**
- Create: `engine/capability-manifest.ts`

- [ ] **Step 1: Create the module with types and buildCapabilityManifest function**

```typescript
/**
 * capability-manifest.ts - Machine-readable capability manifest for KINDX MCP server
 *
 * Exposes a structured JSON manifest describing:
 * - Available MCP tools and their input schemas
 * - Supported query types (lex/vec/hyde) and auto-classification strategies
 * - Indexed collections with document counts
 * - Runtime state (vector index, models, encryption, total documents)
 *
 * The manifest is built fresh on each read from current runtime state.
 * Designed for agents to discover KINDX capabilities at session start.
 */

import type { Store } from "./repository.js";

// =============================================================================
// Types
// =============================================================================

export type ToolRegistration = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
};

export type CapabilityManifest = {
  version: "1.0";
  server: {
    name: string;
    version: string;
    protocol: string;
  };
  tools: Array<{
    name: string;
    description: string;
    readOnly: boolean;
    inputSchema: Record<string, unknown>;
  }>;
  queryTypes: {
    supported: string[];
    autoClassify: boolean;
    strategies: string[];
  };
  collections: Array<{
    name: string;
    documents: number;
    path: string;
  }>;
  runtime: {
    vectorIndex: {
      available: boolean;
      state: string;
    };
    modelsReady: boolean;
    encryption: {
      enabled: boolean;
      keyConfigured: boolean;
    };
    totalDocuments: number;
    error?: string;
  };
};

// =============================================================================
// Builder
// =============================================================================

const SERVER_VERSION = "1.3.4";

export function buildCapabilityManifest(
  store: Store,
  tools: ToolRegistration[]
): CapabilityManifest {
  const manifest: CapabilityManifest = {
    version: "1.0",
    server: {
      name: "kindx",
      version: SERVER_VERSION,
      protocol: "mcp/2025-06-18",
    },
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      inputSchema: t.inputSchema,
    })),
    queryTypes: {
      supported: ["lex", "vec", "hyde"],
      autoClassify: true,
      strategies: ["exact", "question", "analytical"],
    },
    collections: [],
    runtime: {
      vectorIndex: { available: false, state: "unknown" },
      modelsReady: false,
      encryption: { enabled: false, keyConfigured: false },
      totalDocuments: 0,
    },
  };

  try {
    const status = store.getStatus();
    manifest.collections = status.collections.map((c) => ({
      name: c.name,
      documents: c.documents,
      path: c.path,
    }));
    manifest.runtime = {
      vectorIndex: {
        available: status.hasVectorIndex,
        state: status.ann?.state ?? "unknown",
      },
      modelsReady: status.models_ready ?? false,
      encryption: {
        enabled: status.encryption?.encrypted ?? false,
        keyConfigured: status.encryption?.keyConfigured ?? false,
      },
      totalDocuments: status.totalDocuments,
    };
  } catch (err) {
    manifest.runtime.error = err instanceof Error ? err.message : String(err);
  }

  return manifest;
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit engine/capability-manifest.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add engine/capability-manifest.ts
git commit -m "feat: add capability manifest module with types and builder"
```

---

### Task 2: Register kindx://capabilities resource in protocol.ts

**Files:**
- Modify: `engine/protocol.ts`

- [ ] **Step 1: Import the capability manifest module**

At the top of `engine/protocol.ts`, after the existing imports (around line 27), add:

```typescript
import { buildCapabilityManifest, type ToolRegistration } from "./capability-manifest.js";
```

- [ ] **Step 2: Add tool tracking array in createMcpServer**

Inside the `createMcpServer` function (around line 715, after `const mcpControl = options?.mcpControl;`), add:

```typescript
const registeredToolDefs: ToolRegistration[] = [];
```

- [ ] **Step 3: Track tool definitions in maybeRegisterTool**

Modify the `maybeRegisterTool` function (around line 720) to capture tool metadata. After the existing early-return checks and before `server.registerTool(name, def, handler);`, add:

```typescript
registeredToolDefs.push({
  name,
  description: def.description,
  readOnly: def.annotations?.readOnlyHint ?? false,
  inputSchema: def.inputSchema ?? {},
});
```

- [ ] **Step 4: Register the kindx://capabilities resource**

After the existing `kindx://{path}` resource registration (after line 825), add the capabilities resource registration:

```typescript
// ---------------------------------------------------------------------------
// Resource: kindx://capabilities - machine-readable capability manifest
// ---------------------------------------------------------------------------

server.registerResource(
  "capabilities",
  "kindx://capabilities",
  {
    title: "KINDX Capabilities",
    description: "Machine-readable manifest of available tools, query types, collections, and runtime state.",
    mimeType: "application/json",
  },
  async (uri: any) => {
    try {
      const manifest = buildCapabilityManifest(store, registeredToolDefs);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(manifest, null, 2),
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            version: "1.0",
            error: err instanceof Error ? err.message : String(err),
          }, null, 2),
        }],
      };
    }
  }
);
```

- [ ] **Step 5: Verify the file compiles**

Run: `npx tsc --noEmit engine/protocol.ts`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add engine/protocol.ts
git commit -m "feat: register kindx://capabilities MCP resource"
```

---

### Task 3: Write unit tests for capability manifest

**Files:**
- Create: `engine/capability-manifest.test.ts`

- [ ] **Step 1: Create the test file with basic tests**

```typescript
import { describe, it, expect } from "vitest";
import { buildCapabilityManifest, type ToolRegistration } from "./capability-manifest.js";

function mockStore(overrides: Record<string, unknown> = {}) {
  return {
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
  });

  it("includes runtime state", () => {
    const manifest = buildCapabilityManifest(mockStore(), []);
    expect(manifest.runtime.totalDocuments).toBe(42);
    expect(manifest.runtime.vectorIndex.available).toBe(true);
    expect(manifest.runtime.vectorIndex.state).toBe("ready");
    expect(manifest.runtime.modelsReady).toBe(true);
    expect(manifest.runtime.encryption.enabled).toBe(false);
  });

  it("handles store.getStatus() throwing", () => {
    const brokenStore = {
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
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run engine/capability-manifest.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add engine/capability-manifest.test.ts
git commit -m "test: add unit tests for capability manifest builder"
```

---

### Task 4: Verify end-to-end and run full test suite

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full test suite to ensure no regressions**

Run: `npx vitest run`
Expected: All tests pass (no regressions from protocol.ts changes)

- [ ] **Step 2: Run type checking on modified files**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Final commit with any fixes**

```bash
git add -A
git commit -m "feat: complete capability manifest implementation"
```
