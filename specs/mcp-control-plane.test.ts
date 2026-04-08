import { describe, expect, test } from "vitest";
import {
  McpToolListCache,
  applyToolPolicy,
  buildToolProvenanceRegistry,
  isToolEnabledByPolicy,
  resolveMcpServerControl,
} from "../engine/mcp-control-plane.js";

describe("mcp control plane", () => {
  test("resolves defaults", () => {
    const resolved = resolveMcpServerControl("kindx", {
      runtime: null,
      project: null,
      user: null,
      trustedProject: false,
      projectHash: "p",
    });
    expect(resolved.startup_timeout_sec).toBe(20);
    expect(resolved.tool_timeout_sec).toBe(60);
    expect(resolved.source).toBe("defaults");
  });

  test("applies enabled then disabled policy", () => {
    const resolved = resolveMcpServerControl("kindx", {
      runtime: {
        mcp_servers: {
          kindx: {
            enabled_tools: ["query", "get", "status"],
            disabled_tools: ["status"],
          },
        },
      },
      project: null,
      user: null,
      trustedProject: true,
      projectHash: "p",
    });
    expect(isToolEnabledByPolicy(resolved, "query")).toBe(true);
    expect(isToolEnabledByPolicy(resolved, "status")).toBe(false);
    expect(applyToolPolicy(resolved, ["query", "get", "status"])).toEqual(["query", "get"]);
  });

  test("builds provenance registry with qualified tool names", () => {
    const registry = buildToolProvenanceRegistry("kindx", ["query"]);
    expect(registry.query.qualified_name).toBe("mcp:kindx/query");
  });

  test("uses in-memory and disk-backed tool-list cache", () => {
    const cache = new McpToolListCache(60_000);
    const key = cache.buildKey({
      accountId: "acct",
      workspaceId: "ws",
      projectHash: "p",
      serverFingerprint: "s",
    });
    cache.set(key, { ok: true });
    expect(cache.get(key)).toEqual({ ok: true });
  });
});

