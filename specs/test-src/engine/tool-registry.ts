/**
 * tool-registry.ts - Standardized MCP tool registration factory for KINDX
 *
 * Motivation: Before this module, KINDX registered MCP tools via inline anonymous
 * handlers with ad-hoc error formatting, no abort propagation, and no shared context
 * injection. Adding cross-cutting concerns (timing, cancellation, unified errors)
 * required touching every handler.
 *
 * This module provides:
 * - `buildKindxTool` — factory that enforces standard tool metadata and wraps
 *   every handler with error formatting, timing injection, and abort propagation.
 * - `ToolContext` — shared context type passed to every handler.
 * - `formatToolError` / `formatToolResult` — canonical response shapes.
 *
 * Usage:
 *   const def = buildKindxTool({ name: "query", readOnly: true, schema: ..., execute });
 *   registerKindxTool(server, def, () => toolContext);
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import type { Store } from "./repository.js";
import type { KindxSession, SessionScopeContext } from "./session.js";

// =============================================================================
// ToolContext
// =============================================================================

/**
 * Shared context injected into every tool handler.
 *
 * Handlers receive this via their second parameter, providing access to:
 * - `store` — database access (search, retrieval, memory)
 * - `session` — per-connection state (embedding cache, abort signal, query log)
 * - `scopeContext` — memory namespace derived from MCP initialize
 * - `signal` — AbortSignal propagated from the session (fires on client disconnect)
 * - `timing` — mutable timing accumulator; handlers should update it
 */
export type ToolContext = {
  store: Store;
  session: KindxSession | null;
  scopeContext: SessionScopeContext;
  signal: AbortSignal;
  timing: ToolTiming;
};

export type ToolTiming = {
  startMs: number;
  durationMs: () => number;
};

function makeToolContext(
  store: Store,
  session: KindxSession | null,
  scopeContext: SessionScopeContext
): ToolContext {
  const startMs = Date.now();
  return {
    store,
    session,
    scopeContext,
    signal: session?.signal ?? new AbortController().signal,
    timing: {
      startMs,
      durationMs: () => Date.now() - startMs,
    },
  };
}

// =============================================================================
// Tool Result Types
// =============================================================================

/**
 * Canonical MCP tool result shape.
 * All handlers must return this — the factory normalizes errors into it.
 *
 * Note: structuredContent must be Record<string, unknown> to satisfy the MCP SDK.
 * Constrain TOut to that base type when using structured output.
 */
export type KindxToolResult<TOut extends Record<string, unknown> | undefined = undefined> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: TOut extends Record<string, unknown> ? TOut : never;
  isError?: boolean;
};

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * Type-safe definition of a KINDX MCP tool.
 *
 * `buildKindxTool` wraps this into a registered McpServer tool with:
 * - Standard annotations (`readOnlyHint`, `openWorldHint`)
 * - Centralized error formatting (no silent swallows)
 * - Timing metadata available in the handler
 * - AbortSignal propagation from the current session
 */
export type KindxToolDef<TInput, TOutput extends Record<string, unknown> | undefined = undefined> = {
  /** Tool name as registered with MCP server. */
  name: string;
  /** Human-readable title. */
  title: string;
  /** Tool description shown to LLM clients. */
  description: string;
  /** Whether this tool only reads state (no side effects). */
  readOnly: boolean;
  /** Zod schema for input validation. */
  schema: ZodType<TInput>;
  /**
   * Tool handler. Called with validated input and injected context.
   * Must return a KindxToolResult. Thrown errors are caught and formatted
   * as `isError: true` responses — never propagated to the SDK as unhandled.
   */
  execute: (input: TInput, ctx: ToolContext) => Promise<KindxToolResult<TOutput>>;
};

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a typed KINDX tool definition.
 *
 * This is the canonical way to define tools in KINDX. It does not register
 * the tool — call `registerKindxTool(server, def, getContext)` to register.
 *
 * @example
 * const def = buildKindxTool({
 *   name: "query",
 *   title: "Search documents",
 *   description: "...",
 *   readOnly: true,
 *   schema: z.object({ q: z.string() }),
 *   async execute({ q }, ctx) {
 *     const results = await structuredSearch(ctx.store, [{ type: "vec", query: q }]);
 *     return formatToolResult(`Found ${results.length} results`, results);
 *   },
 * });
 */
export function buildKindxTool<TInput, TOutput extends Record<string, unknown> | undefined = undefined>(
  def: KindxToolDef<TInput, TOutput>
): KindxToolDef<TInput, TOutput> {
  return def;
}

/**
 * Register a KINDX tool with an McpServer instance.
 *
 * @param server      - The McpServer instance to register with
 * @param def         - The typed tool definition from `buildKindxTool`
 * @param getContext  - Factory function called per-invocation to produce the ToolContext.
 *                      The session/scope injected here determines which session state
 *                      is available to the handler.
 */
export function registerKindxTool<TInput, TOutput extends Record<string, unknown> | undefined = undefined>(
  server: McpServer,
  def: KindxToolDef<TInput, TOutput>,
  getContext: () => ToolContext
): void {
  // Build the raw Zod shape from the ZodObject schema definition.
  // The MCP SDK's registerTool() expects a ZodRawShape (plain object of Zod types).
  // We extract it from the ZodObject, falling back to an empty schema.
  const rawSchema = def.schema as any;
  const inputSchema: Record<string, ZodType<unknown>> =
    typeof rawSchema._def?.shape === "function"
      ? rawSchema._def.shape()
      : rawSchema.shape ?? {};

  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      annotations: {
        readOnlyHint: def.readOnly,
        openWorldHint: false,
      },
      inputSchema,
    },
    async (input: unknown) => {
      const typedInput = input as TInput;
      const ctx = getContext();

      // Log query if it looks like a search operation
      if (ctx.session && typeof (input as any).query === "string") {
        ctx.session.logQuery((input as any).query as string);
      }

      try {
        return await def.execute(typedInput, ctx);
      } catch (err) {
        return formatToolError(err, def.name) as any;
      }
    }
  );
}

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Format a successful tool result.
 * The `text` is the human-readable summary; `data` is the optional structured response.
 */
export function formatToolResult<TOut extends Record<string, unknown>>(
  text: string,
  data?: TOut
): KindxToolResult<TOut> {
  const result: KindxToolResult<TOut> = {
    content: [{ type: "text" as const, text }],
  };
  if (data !== undefined) {
    (result as any).structuredContent = data;
  }
  return result;
}

/**
 * Format an error into a canonical tool error response.
 * Never propagates the error to the SDK as an unhandled rejection.
 *
 * @param err     - The caught error (can be anything)
 * @param toolName - Optional tool name for context in the error message
 */
export function formatToolError(err: unknown, toolName?: string): KindxToolResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  const prefix = toolName ? `[${toolName}] ` : "";
  process.stderr.write(`KINDX tool error ${prefix}: ${message}\n`);
  return {
    content: [{ type: "text" as const, text: `${prefix}${message}` }],
    isError: true,
  };
}

/**
 * Build a ToolContext from a store and optional session/scope.
 * Convenience for creating contexts outside of registerKindxTool.
 */
export function buildToolContext(
  store: Store,
  session: KindxSession | null,
  scopeContext: SessionScopeContext = {}
): ToolContext {
  return makeToolContext(store, session, scopeContext);
}
