import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FixedWindowRateLimiter, McpToolListCache, isToolEnabledByPolicy, resolveMcpServerControl } from "../engine/mcp-control-plane.js";

describe("cachePath validation", () => {
  test("rejects keys containing forward slash", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("../../../etc/passwd")).toThrow(
      "invalid cache key"
    );
  });

  test("rejects keys containing backslash", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("..\\..\\windows\\system32")).toThrow(
      "invalid cache key"
    );
  });

  test("rejects keys containing dot-dot", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("..")).toThrow("invalid cache key");
    expect(() => (cache as any).cachePath("valid/../escape")).toThrow(
      "invalid cache key"
    );
  });

  test("accepts valid hex keys", () => {
    const cache = new McpToolListCache(60_000);
    expect(() => (cache as any).cachePath("abc123def456")).not.toThrow();
  });
});

describe("isToolEnabledByPolicy audit logging", () => {
  test("logs audit on denial when tool not in allowlist", () => {
    const auditFn = vi.fn();
    const resolved = resolveMcpServerControl("kindx", {
      runtime: {
        mcp_servers: {
          kindx: {
            enabled_tools: ["query"],
          },
        },
      },
      project: null,
      user: null,
      trustedProject: true,
      projectHash: "p",
    });

    const result = isToolEnabledByPolicy(resolved, "status", { audit: auditFn });
    expect(result).toBe(false);
    expect(auditFn).toHaveBeenCalledWith({
      action: "tool_denied",
      scope: "kindx/status",
      detail: expect.stringContaining("not in allowlist"),
    });
  });

  test("does not log audit when tool is allowed", () => {
    const auditFn = vi.fn();
    const resolved = resolveMcpServerControl("kindx", {
      runtime: {
        mcp_servers: {
          kindx: {
            enabled_tools: ["query"],
          },
        },
      },
      project: null,
      user: null,
      trustedProject: true,
      projectHash: "p",
    });

    const result = isToolEnabledByPolicy(resolved, "query", { audit: auditFn });
    expect(result).toBe(true);
    expect(auditFn).not.toHaveBeenCalled();
  });

  test("logs audit on denial when tool is explicitly disabled", () => {
    const auditFn = vi.fn();
    const resolved = resolveMcpServerControl("kindx", {
      runtime: {
        mcp_servers: {
          kindx: {
            enabled_tools: ["query", "status"],
            disabled_tools: ["status"],
          },
        },
      },
      project: null,
      user: null,
      trustedProject: true,
      projectHash: "p",
    });

    const result = isToolEnabledByPolicy(resolved, "status", { audit: auditFn });
    expect(result).toBe(false);
    expect(auditFn).toHaveBeenCalledWith({
      action: "tool_denied",
      scope: "kindx/status",
      detail: expect.stringContaining("explicitly disabled"),
    });
  });

  test("logs audit on denial when project untrusted", () => {
    const auditFn = vi.fn();
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

    const result = isToolEnabledByPolicy(resolved, "query", { audit: auditFn });
    expect(result).toBe(false);
    expect(auditFn).toHaveBeenCalledWith({
      action: "tool_denied",
      scope: "kindx/query",
      detail: expect.stringContaining("trusted_project=false"),
    });
  });
});

describe("pickServerConfig config resolution logging", () => {
  test("logs defaults tier when no config provided", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      resolveMcpServerControl("kindx", {
        runtime: null,
        project: null,
        user: null,
        trustedProject: true,
        projectHash: "p",
      });
      const call = stderrSpy.mock.calls.find((c) => String(c[0]).includes("config_resolved"));
      expect(call).toBeDefined();
      const log = JSON.parse(String(call![0]));
      expect(log.tier).toBe("defaults");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("logs runtime tier when runtime config matches", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      resolveMcpServerControl("kindx", {
        runtime: { mcp_servers: { kindx: { enabled_tools: ["query"] } } },
        project: null,
        user: null,
        trustedProject: true,
        projectHash: "p",
      });
      const call = stderrSpy.mock.calls.find((c) => String(c[0]).includes("config_resolved"));
      expect(call).toBeDefined();
      const log = JSON.parse(String(call![0]));
      expect(log.tier).toBe("runtime");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("logs project tier when only project config matches", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      resolveMcpServerControl("kindx", {
        runtime: null,
        project: { mcp_servers: { kindx: { enabled_tools: ["query"] } } },
        user: null,
        trustedProject: true,
        projectHash: "p",
      });
      const call = stderrSpy.mock.calls.find((c) => String(c[0]).includes("config_resolved"));
      expect(call).toBeDefined();
      const log = JSON.parse(String(call![0]));
      expect(log.tier).toBe("project");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("logs user tier when only user config matches", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      resolveMcpServerControl("kindx", {
        runtime: null,
        project: null,
        user: { mcp_servers: { kindx: { enabled_tools: ["query"] } } },
        trustedProject: true,
        projectHash: "p",
      });
      const call = stderrSpy.mock.calls.find((c) => String(c[0]).includes("config_resolved"));
      expect(call).toBeDefined();
      const log = JSON.parse(String(call![0]));
      expect(log.tier).toBe("user");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("runtime takes precedence over project and user", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      resolveMcpServerControl("kindx", {
        runtime: { mcp_servers: { kindx: { enabled_tools: ["query"] } } },
        project: { mcp_servers: { kindx: { enabled_tools: ["status"] } } },
        user: { mcp_servers: { kindx: { enabled_tools: ["run"] } } },
        trustedProject: true,
        projectHash: "p",
      });
      const call = stderrSpy.mock.calls.find((c) => String(c[0]).includes("config_resolved"));
      const log = JSON.parse(String(call![0]));
      expect(log.tier).toBe("runtime");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("FixedWindowRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("allows requests under limit", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 10, windowMs: 1000 });
    expect(limiter.check("session1")).toBe(true);
    expect(limiter.check("session1")).toBe(true);
  });

  test("blocks requests over limit", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 2, windowMs: 1000 });
    expect(limiter.check("session1")).toBe(true);
    expect(limiter.check("session1")).toBe(true);
    expect(limiter.check("session1")).toBe(false);
  });

  test("tracks sessions independently", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.check("session1")).toBe(true);
    expect(limiter.check("session2")).toBe(true);
    expect(limiter.check("session1")).toBe(false);
  });

  test("resets after window expires", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 100 });
    expect(limiter.check("session1")).toBe(true);
    expect(limiter.check("session1")).toBe(false);
    vi.advanceTimersByTime(150);
    expect(limiter.check("session1")).toBe(true);
  });

  test("prunes expired entries on window reset", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 100 });
    limiter.check("session1");
    limiter.check("session2");
    vi.advanceTimersByTime(150);
    limiter.check("session1");
    const size = (limiter as any).windows.size;
    expect(size).toBe(1);
  });
});
