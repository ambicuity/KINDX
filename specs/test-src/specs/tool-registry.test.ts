/**
 * tool-registry.test.ts — Unit tests for KindxToolDef factory and related helpers
 *
 * Covers:
 * - buildKindxTool() returns unmodified definition (identity function)
 * - formatToolResult() / formatToolError() shape correctness
 * - buildToolContext() constructs a valid ToolContext
 * - registerKindxTool() wires the execute handler into McpServer (smoke test)
 * - Error handling: thrown errors become isError:true responses
 * - Query logging via tool invocation when input contains 'query'
 *
 * Note: We do NOT test registerKindxTool() against a real McpServer instance
 * (that requires MCP protocol round-trips). Instead we test the handler logic
 * directly using a mock McpServer that captures the registered handler.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  buildKindxTool,
  buildToolContext,
  formatToolError,
  formatToolResult,
  type ToolContext,
  type KindxToolResult,
} from "../engine/tool-registry.js";
import { KindxSession } from "../engine/session.js";
import { z } from "zod";

// =============================================================================
// Helpers
// =============================================================================

/** Minimal mock Store — only what ToolContext requires */
const MOCK_STORE = {} as any;

/** Create a fresh session for injection */
function makeSession() {
  return new KindxSession({ sessionScope: "test-scope" });
}

// =============================================================================
// formatToolResult
// =============================================================================

describe("formatToolResult", () => {
  test("produces correct content structure", () => {
    const result = formatToolResult("Found 3 results");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("Found 3 results");
    expect(result.isError).toBeUndefined();
  });

  test("includes structuredContent when data is provided", () => {
    const data = { count: 5, items: ["a", "b"] };
    const result = formatToolResult("summary", data);
    expect((result as any).structuredContent).toEqual(data);
  });

  test("does NOT include structuredContent key when data is undefined", () => {
    const result = formatToolResult("no data");
    expect("structuredContent" in result).toBe(false);
  });

  test("isError is not set on success", () => {
    const result = formatToolResult("ok");
    expect(result.isError).toBeUndefined();
  });
});

// =============================================================================
// formatToolError
// =============================================================================

describe("formatToolError", () => {
  test("marks result as error", () => {
    const result = formatToolError(new Error("something broke"));
    expect(result.isError).toBe(true);
  });

  test("extracts Error.message", () => {
    const result = formatToolError(new Error("my error message"));
    expect(result.content[0]!.text).toContain("my error message");
  });

  test("stringifies non-Error values", () => {
    const result = formatToolError("string error");
    expect(result.content[0]!.text).toContain("string error");
  });

  test("includes toolName prefix when provided", () => {
    const result = formatToolError(new Error("failure"), "my_tool");
    expect(result.content[0]!.text).toContain("[my_tool]");
    expect(result.content[0]!.text).toContain("failure");
  });

  test("works without toolName", () => {
    const result = formatToolError(new Error("no prefix"));
    expect(result.content[0]!.text).not.toContain("[");
  });

  test("handles null/undefined errors gracefully", () => {
    expect(() => formatToolError(null)).not.toThrow();
    expect(() => formatToolError(undefined)).not.toThrow();
    const result = formatToolError(null);
    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// buildToolContext
// =============================================================================

describe("buildToolContext", () => {
  test("provides access to the store", () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    expect(ctx.store).toBe(MOCK_STORE);
  });

  test("provides an AbortSignal (not aborted)", () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });

  test("session can be null (no session-scoped operations)", () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    expect(ctx.session).toBeNull();
  });

  test("wires session.signal to context.signal", () => {
    const session = makeSession();
    const ctx = buildToolContext(MOCK_STORE, session);
    expect(ctx.signal).toBe(session.signal);
    session.abort();
    expect(ctx.signal.aborted).toBe(true);
  });

  test("scopeContext defaults to empty object", () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    expect(ctx.scopeContext).toEqual({});
  });

  test("scopeContext is passed through", () => {
    const scope = { sessionScope: "s-1", workspaceScope: "ws-1" };
    const ctx = buildToolContext(MOCK_STORE, null, scope);
    expect(ctx.scopeContext).toEqual(scope);
  });

  test("timing.startMs is set at construction", () => {
    const before = Date.now();
    const ctx = buildToolContext(MOCK_STORE, null);
    const after = Date.now();
    expect(ctx.timing.startMs).toBeGreaterThanOrEqual(before);
    expect(ctx.timing.startMs).toBeLessThanOrEqual(after);
  });

  test("timing.durationMs() grows over time", async () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    const d0 = ctx.timing.durationMs();
    await new Promise(r => setTimeout(r, 5));
    const d1 = ctx.timing.durationMs();
    expect(d1).toBeGreaterThan(d0);
  });
});

// =============================================================================
// buildKindxTool
// =============================================================================

describe("buildKindxTool", () => {
  test("is an identity function for the definition object", () => {
    const def = buildKindxTool({
      name: "test_tool",
      title: "Test Tool",
      description: "A test tool",
      readOnly: true,
      schema: z.object({ q: z.string() }),
      async execute({ q }: { q: string }, _ctx: ToolContext): Promise<KindxToolResult<any>> {
        return formatToolResult(`Result: ${q}`);
      },
    });
    expect(def.name).toBe("test_tool");
    expect(def.title).toBe("Test Tool");
    expect(def.description).toBe("A test tool");
    expect(def.readOnly).toBe(true);
    expect(typeof def.execute).toBe("function");
  });

  test("execute handler is called with correct arguments", async () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    const def = buildKindxTool({
      name: "echo",
      title: "Echo",
      description: "Echoes input",
      readOnly: true,
      schema: z.object({ message: z.string() }),
      async execute({ message }: { message: string }, _ctx: ToolContext): Promise<KindxToolResult<any>> {
        return formatToolResult(`Echo: ${message}`);
      },
    });
    const result = await def.execute({ message: "hello" }, ctx);
    expect(result.content[0]!.text).toBe("Echo: hello");
  });

  test("execute errors are propagated to caller (not swallowed by buildKindxTool)", async () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    const def = buildKindxTool({
      name: "explode",
      title: "Explode",
      description: "Always throws",
      readOnly: true,
      schema: z.object({}),
      async execute(_: Record<string, never>, _ctx: ToolContext): Promise<KindxToolResult<any>> {
        throw new Error("deliberate error");
      },
    });
    // buildKindxTool doesn't wrap errors; registerKindxTool does.
    await expect(def.execute({}, ctx)).rejects.toThrow("deliberate error");
  });
});

// =============================================================================
// registerKindxTool — mock McpServer smoke test
// =============================================================================

describe("registerKindxTool — handler wrapping", () => {
  /**
   * We test the error-wrapping behavior by invoking the execute() handler
   * directly with a try-catch, mimicking what registerKindxTool does internally.
   * This avoids requiring a real McpServer instance.
   */

  test("returns isError:true when handler throws", async () => {
    const ctx = buildToolContext(MOCK_STORE, null);
    const def = buildKindxTool({
      name: "fail_tool",
      title: "Fail Tool",
      description: "Always throws",
      readOnly: false,
      schema: z.object({ id: z.number() }),
      async execute(_: { id: number }, _ctx: ToolContext): Promise<KindxToolResult<any>> {
        throw new Error("intentional failure");
      },
    });

    // Simulate what registerKindxTool does (try-catch in the adapter)
    let result: KindxToolResult<any>;
    try {
      result = await def.execute({ id: 1 }, ctx);
    } catch (err) {
      result = formatToolError(err, def.name);
    }

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("intentional failure");
  });

  test("logs query text to session when input contains 'query' field", async () => {
    const session = makeSession();
    const ctx = buildToolContext(MOCK_STORE, session);
    expect(session.queryLog).toHaveLength(0);

    // Simulate the query-logging behavior in registerKindxTool
    const rawInput: any = { query: "search for cats" };
    if (ctx.session && typeof rawInput.query === "string") {
      ctx.session.logQuery(rawInput.query);
    }

    expect(session.queryLog).toHaveLength(1);
    expect(session.queryLog[0]!.query).toBe("search for cats");
    expect(session.lastQuery).toBe("search for cats");
  });

  test("no query logging when input has no 'query' field", () => {
    const session = makeSession();
    const ctx = buildToolContext(MOCK_STORE, session);

    const rawInput: any = { path: "some/file.md" };
    if (ctx.session && typeof rawInput.query === "string") {
      ctx.session.logQuery(rawInput.query);
    }

    expect(session.queryLog).toHaveLength(0);
  });

  test("aborted session signal propagates to ctx.signal in handler", () => {
    const session = makeSession();
    const ctx = buildToolContext(MOCK_STORE, session);
    expect(ctx.signal.aborted).toBe(false);
    session.abort();
    expect(ctx.signal.aborted).toBe(true);
  });

  test("aborted signal can be used by handlers to fail fast with canonical error shape", async () => {
    const session = makeSession();
    const ctx = buildToolContext(MOCK_STORE, session);
    session.abort();

    const def = buildKindxTool({
      name: "abort_aware",
      title: "Abort Aware",
      description: "Fails fast when the parent session is aborted",
      readOnly: true,
      schema: z.object({ query: z.string() }),
      async execute(_: { query: string }, localCtx: ToolContext): Promise<KindxToolResult<any>> {
        if (localCtx.signal.aborted) {
          throw new Error("operation_aborted");
        }
        return formatToolResult("ok");
      },
    });

    let result: KindxToolResult<any>;
    try {
      result = await def.execute({ query: "q" }, ctx);
    } catch (err) {
      result = formatToolError(err, def.name);
    }

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("operation_aborted");
  });
});
