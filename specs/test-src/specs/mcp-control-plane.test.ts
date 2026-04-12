import { describe, expect, test, vi } from "vitest";
import {
  McpToolListCache,
  applyToolPolicy,
  buildResolvedHttpHeaders,
  buildToolProvenanceRegistry,
  isToolEnabledByPolicy,
  loadMcpControlPlaneConfig,
  resolveMcpServerControl,
} from "../engine/mcp-control-plane.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function cacheDirFrom(cacheHome: string): string {
  return join(cacheHome, "kindx", "mcp-tool-cache");
}

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

  test("invalid runtime JSON falls back safely", () => {
    const prev = process.env.KINDX_MCP_SERVERS_JSON;
    process.env.KINDX_MCP_SERVERS_JSON = "{not-json";
    try {
      const loaded = loadMcpControlPlaneConfig();
      const resolved = resolveMcpServerControl("kindx", loaded);
      expect(resolved.source).toBe("defaults");
      expect(resolved.enabled_tools).toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.KINDX_MCP_SERVERS_JSON;
      } else {
        process.env.KINDX_MCP_SERVERS_JSON = prev;
      }
    }
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

  test("uses in-memory and disk-backed tool-list cache", async () => {
    const cache = new McpToolListCache(60_000);
    const key = cache.buildKey({
      accountId: "acct",
      workspaceId: "ws",
      projectHash: "p",
      serverFingerprint: "s",
    });
    cache.set(key, { ok: true });
    await cache.waitForIdleForTests();
    expect(cache.get(key)).toEqual({ ok: true });
  });

  test("invalidateAll clears persisted disk cache entries", async () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;

    try {
      const cacheA = new McpToolListCache(60_000);
      const key = cacheA.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      cacheA.set(key, { ok: true });
      await cacheA.waitForIdleForTests();

      const cacheB = new McpToolListCache(60_000);
      expect(cacheB.get(key)).toEqual({ ok: true });

      cacheA.invalidateAll();
      await cacheA.waitForIdleForTests();
      const cacheC = new McpToolListCache(60_000);
      expect(cacheC.get(key)).toBeNull();
    } finally {
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("ignores malformed temp artifacts and reads committed cache value", async () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      const cache = new McpToolListCache(60_000);
      const key = cache.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      cache.set(key, { ok: true });
      await cache.waitForIdleForTests();
      const dir = cacheDirFrom(cacheHome);
      writeFileSync(join(dir, `${key}.partial.tmp`), "{not-json");
      const second = new McpToolListCache(60_000);
      expect(second.get(key)).toEqual({ ok: true });
    } finally {
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("fsync failures are best-effort and still leave committed cache readable", async () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cache = new McpToolListCache(60_000) as any;
      const key = cache.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });

      cache.syncFd = async () => {
        throw new Error("synthetic-fsync-failure");
      };

      expect(() => cache.set(key, { ok: true })).not.toThrow();
      await cache.waitForIdleForTests();
      const second = new McpToolListCache(60_000);
      expect(second.get(key)).toEqual({ ok: true });

      const warningText = stderrSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(warningText).toContain("mcp_tool_cache_fsync_failed");
    } finally {
      stderrSpy.mockRestore();
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("temp artifact is cleaned up when write path errors after temp write", async () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cache = new McpToolListCache(60_000) as any;
      const key = cache.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      const dir = cacheDirFrom(cacheHome);
      const forcedTemp = join(dir, `${key}.forced.tmp`);
      cache.tempCachePath = () => forcedTemp;
      cache.fsyncPathBestEffort = async () => {
        throw new Error("synthetic-write-path-failure");
      };

      expect(() => cache.set(key, { ok: true })).not.toThrow();
      await cache.waitForIdleForTests();
      expect(existsSync(forcedTemp)).toBe(false);

      const warningText = stderrSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(warningText).toContain("mcp_tool_cache_write_failed");
    } finally {
      stderrSpy.mockRestore();
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("malformed envelope is treated as miss, removed, and warns once", () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cache = new McpToolListCache(60_000);
      const key = cache.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      const dir = cacheDirFrom(cacheHome);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${key}.json`);
      writeFileSync(path, "{not-json");

      expect(cache.get(key)).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(stderrSpy).toHaveBeenCalled();
      const warningText = stderrSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(warningText).toContain("mcp_tool_cache_read_failed");
    } finally {
      stderrSpy.mockRestore();
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("stale envelope is never returned and stale file is removed", async () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      const cache = new McpToolListCache(60_000);
      const key = cache.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      const dir = cacheDirFrom(cacheHome);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${key}.json`);
      const now = Date.now();
      writeFileSync(path, JSON.stringify({
        key,
        created_at: now - 120_000,
        expires_at: now - 60_000,
        payload: { stale: true },
      }));

      expect(cache.get(key)).toBeNull();
      await cache.waitForIdleForTests();
      expect(existsSync(path)).toBe(false);
    } finally {
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("invalid envelope with key mismatch is removed and treated as miss", () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      const cache = new McpToolListCache(60_000);
      const key = cache.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      const dir = cacheDirFrom(cacheHome);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${key}.json`);
      const now = Date.now();
      writeFileSync(path, JSON.stringify({
        key: "different-key",
        created_at: now,
        expires_at: now + 1_000,
        payload: { ok: true },
      }));

      expect(cache.get(key)).toBeNull();
      expect(existsSync(path)).toBe(false);
    } finally {
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("invalid envelope with unreasonable ttl is removed and treated as miss", () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      const cache = new McpToolListCache(60_000);
      const key = cache.buildKey({
        accountId: "acct",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      const dir = cacheDirFrom(cacheHome);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${key}.json`);
      const now = Date.now();
      writeFileSync(path, JSON.stringify({
        key,
        created_at: now,
        expires_at: now + 60_000 * 1_000, // Far beyond sanity multiplier.
        payload: { ok: true },
      }));

      expect(cache.get(key)).toBeNull();
      expect(existsSync(path)).toBe(false);
    } finally {
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("invalidateAll continues when one .json entry cannot be unlinked", async () => {
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = mkdtempSync(join(tmpdir(), "kindx-cache-"));
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      const cache = new McpToolListCache(60_000);
      const keyA = cache.buildKey({
        accountId: "acct-a",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      const keyB = cache.buildKey({
        accountId: "acct-b",
        workspaceId: "ws",
        projectHash: "p",
        serverFingerprint: "s",
      });
      cache.set(keyA, { a: true });
      cache.set(keyB, { b: true });
      await cache.waitForIdleForTests();
      const dir = cacheDirFrom(cacheHome);
      const blocked = join(dir, "blocked.json");
      mkdirSync(blocked, { recursive: true }); // unlink on this path throws EISDIR

      cache.invalidateAll();
      await cache.waitForIdleForTests();

      expect(existsSync(join(dir, `${keyA}.json`))).toBe(false);
      expect(existsSync(join(dir, `${keyB}.json`))).toBe(false);
      expect(existsSync(blocked)).toBe(true);
      const fresh = new McpToolListCache(60_000);
      expect(fresh.get(keyA)).toBeNull();
      expect(fresh.get(keyB)).toBeNull();
    } finally {
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  test("project_scoped policy blocks tools for untrusted projects", () => {
    const resolved = resolveMcpServerControl("kindx", {
      runtime: {
        mcp_servers: {
          kindx: {
            project_scoped: true,
          },
        },
      },
      project: null,
      user: null,
      trustedProject: false,
      projectHash: "p",
    });
    expect(isToolEnabledByPolicy(resolved, "query")).toBe(false);
    expect(applyToolPolicy(resolved, ["query", "get"])).toEqual([]);
  });

  test("buildResolvedHttpHeaders merges static/env and bearer token", () => {
    const prevApiKey = process.env.KINDX_TEST_API_KEY;
    const prevToken = process.env.KINDX_TEST_TOKEN;
    process.env.KINDX_TEST_API_KEY = "abc123";
    process.env.KINDX_TEST_TOKEN = "tok-xyz";
    try {
      const resolved = resolveMcpServerControl("kindx", {
        runtime: {
          mcp_servers: {
            kindx: {
              http_headers: { "x-static": "v1" },
              env_http_headers: { "x-api-key": "KINDX_TEST_API_KEY" },
              bearer_token_env_var: "KINDX_TEST_TOKEN",
            },
          },
        },
        project: null,
        user: null,
        trustedProject: true,
        projectHash: "p",
      });
      expect(buildResolvedHttpHeaders(resolved)).toEqual({
        "x-static": "v1",
        "x-api-key": "abc123",
        Authorization: "Bearer tok-xyz",
      });
    } finally {
      if (prevApiKey === undefined) {
        delete process.env.KINDX_TEST_API_KEY;
      } else {
        process.env.KINDX_TEST_API_KEY = prevApiKey;
      }
      if (prevToken === undefined) {
        delete process.env.KINDX_TEST_TOKEN;
      } else {
        process.env.KINDX_TEST_TOKEN = prevToken;
      }
    }
  });

  test("drops unsafe header names and newline-injected values", () => {
    const prevUnsafe = process.env.KINDX_TEST_UNSAFE;
    const prevSafe = process.env.KINDX_TEST_SAFE;
    process.env.KINDX_TEST_UNSAFE = "ok\r\nbad:1";
    process.env.KINDX_TEST_SAFE = "safe-value";
    try {
      const resolved = resolveMcpServerControl("kindx", {
        runtime: {
          mcp_servers: {
            kindx: {
              http_headers: {
                "x-valid": "value",
                "x-bad\nname": "ignored",
                "x-bad-value": "oops\r\ninjected",
              },
              env_http_headers: {
                "x-safe-env": "KINDX_TEST_SAFE",
                "x-env-unsafe": "KINDX_TEST_UNSAFE",
                "x-bad\nenv": "KINDX_TEST_SAFE",
              },
              bearer_token_env_var: "KINDX_TEST_UNSAFE",
            },
          },
        },
        project: null,
        user: null,
        trustedProject: true,
        projectHash: "p",
      });
      expect(buildResolvedHttpHeaders(resolved)).toEqual({
        "x-valid": "value",
        "x-safe-env": "safe-value",
      });
    } finally {
      if (prevUnsafe === undefined) {
        delete process.env.KINDX_TEST_UNSAFE;
      } else {
        process.env.KINDX_TEST_UNSAFE = prevUnsafe;
      }
      if (prevSafe === undefined) {
        delete process.env.KINDX_TEST_SAFE;
      } else {
        process.env.KINDX_TEST_SAFE = prevSafe;
      }
    }
  });
});
