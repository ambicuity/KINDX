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
import { buildOperationalStatus } from "./diagnostics.js";

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

export const SERVER_VERSION = "1.3.4";

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
    const ops = buildOperationalStatus(store.db, store.dbPath, status.hasVectorIndex);
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
      modelsReady: ops.models_ready,
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
