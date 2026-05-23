/**
 * specs/protocol-tool-descriptions.test.ts
 *
 * Asserts that every KINDX tool description leads with an agreed WHEN-TO-USE
 * sentence, and that the `query` tool's schema defaults match the tightened
 * values shipped in Phase A Task 4.
 *
 * Task 4 makes the `query` row pass. Tasks 5 and 6 will make the remaining
 * rows pass. The "each tool leads" test is intentionally left to fail on
 * non-query tools until those tasks complete — that's by design.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { listRegisteredToolsForTest } from "../engine/protocol.js";

const expectedLeads: Record<string, string> = {
  query: "Call this first whenever the user asks a question",
  get: "Call after `query` to read the full body",
  multi_get: "Call when you need multiple related docs at once",
  status: "Call once per session if `instructions` did not list collections",
  memory_search: 'Call at the start of any turn that says "we"',
  memory_put: "Call after the user states a preference, decision, or fact",
};

describe("tool descriptions lead with WHEN-TO-USE", () => {
  // Save and restore env around each test so KINDX_ENABLE_MAINTENANCE_TOOLS
  // does not leak between test runs.
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv.KINDX_ENABLE_MAINTENANCE_TOOLS = process.env.KINDX_ENABLE_MAINTENANCE_TOOLS;
    // Enable maintenance tools so status/memory_* are registered and inspectable.
    process.env.KINDX_ENABLE_MAINTENANCE_TOOLS = "1";
  });
  afterEach(() => {
    if (savedEnv.KINDX_ENABLE_MAINTENANCE_TOOLS === undefined) {
      delete process.env.KINDX_ENABLE_MAINTENANCE_TOOLS;
    } else {
      process.env.KINDX_ENABLE_MAINTENANCE_TOOLS = savedEnv.KINDX_ENABLE_MAINTENANCE_TOOLS;
    }
  });

  test("query tool description leads with the agreed WHEN-TO-USE sentence", () => {
    const tools = listRegisteredToolsForTest();
    const query = tools.find((t) => t.name === "query");
    expect(query, "missing tool query").toBeDefined();
    expect(query!.description.split("\n")[0]).toContain(
      "Call this first whenever the user asks a question",
    );
    // TODO(Tasks 7+): extend coverage to remaining tools as their descriptions are rewritten.
  });

  test("get/multi_get/status descriptions lead with the agreed WHEN-TO-USE sentence", () => {
    const tools = listRegisteredToolsForTest();
    const expectedLeads: Record<string, string> = {
      get: "Call after `query` to read the full body",
      multi_get: "Call when you need multiple related docs at once",
      status: "Call once per session if `instructions` did not list collections",
    };
    for (const [name, lead] of Object.entries(expectedLeads)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(
        tool!.description.split("\n")[0],
        `tool ${name} should lead with: ${lead}`,
      ).toContain(lead);
    }
  });

  test("memory_search/memory_put descriptions lead with the agreed WHEN-TO-USE sentence", () => {
    const tools = listRegisteredToolsForTest();
    const expectedLeads: Record<string, string> = {
      memory_search: 'Call at the start of any turn that says "we"',
      memory_put: "Call after the user states a preference, decision, or fact",
    };
    for (const [name, lead] of Object.entries(expectedLeads)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(
        tool!.description.split("\n")[0],
        `tool ${name} should lead with: ${lead}`,
      ).toContain(lead);
    }
  });

  test("diagnostic memory tools are tagged as 'only call when the user asks about memory itself'", () => {
    const tools = listRegisteredToolsForTest();
    const diagnostics = ["memory_history", "memory_stats", "memory_mark_accessed", "memory_delete", "memory_bulk", "memory_feedback"];
    for (const name of diagnostics) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(tool!.description).toContain(
        "Diagnostic — only call when the user asks about memory itself",
      );
    }
  });

  test("query.limit defaults to 3 (tight triage)", () => {
    const tools = listRegisteredToolsForTest();
    const query = tools.find((t) => t.name === "query")!;
    const schema: any = query.inputSchema.limit ?? query.inputSchema.shape?.limit;
    // zod stores defaults on `_def.defaultValue`; older zod versions use a
    // factory function, newer versions store the raw value directly.
    const rawDefault = schema?._def?.defaultValue;
    const def = typeof rawDefault === "function" ? rawDefault() : rawDefault;
    expect(def).toBe(3);
  });

  test("query has maxSnippetLines default of 4", () => {
    const tools = listRegisteredToolsForTest();
    const query = tools.find((t) => t.name === "query")!;
    const schema: any = query.inputSchema.maxSnippetLines ?? query.inputSchema.shape?.maxSnippetLines;
    const rawDefault = schema?._def?.defaultValue;
    const def = typeof rawDefault === "function" ? rawDefault() : rawDefault;
    expect(def).toBe(4);
  });
});
