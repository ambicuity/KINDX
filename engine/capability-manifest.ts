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

/**
 * Local copy of protocol.ts's env-gate helper.
 *
 * Duplicated here intentionally to break a circular import:
 * protocol.ts already imports buildCapabilityManifest from this module, so
 * importing back into it would create a cycle. The check is a 3-line env
 * lookup; keep both in sync if the gate semantics ever change.
 */
function isAutoInvokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.KINDX_AUTO_INVOKE ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

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
  /**
   * Auto-invocation observability.
   * - `contractEmitted`: true when the auto-invocation contract is active
   *   (env gate on) AND there is at least one collection to search. MCP
   *   clients can read this to verify the contract is in force.
   * - `lastTurnTrigger`: trigger source of the most recent recorded tool
   *   call ("agent-auto" | "user-explicit" | "unknown"), if any.
   */
  autoInvocation: {
    contractEmitted: boolean;
    lastTurnTrigger?: string;
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
    autoInvocation: {
      contractEmitted: false,
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
    manifest.autoInvocation.contractEmitted =
      isAutoInvokeEnabled() && status.collections.length > 0;
    // Best-effort lookup of the most recent recorded trigger. Wrapped in
    // try/catch because the `mcp_query_log` table is created lazily by
    // initializeCoreSchema, and we want this to be a no-op on older indexes.
    try {
      const row = store.db
        .prepare(`SELECT trigger FROM mcp_query_log ORDER BY id DESC LIMIT 1`)
        .get() as { trigger: string | null } | undefined;
      if (row?.trigger) {
        manifest.autoInvocation.lastTurnTrigger = row.trigger;
      }
    } catch { /* table absent or read failed — leave lastTurnTrigger undefined */ }
  } catch (err) {
    manifest.runtime.error = err instanceof Error ? err.message : String(err);
  }

  return manifest;
}
