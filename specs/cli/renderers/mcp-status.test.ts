import { describe, it, expect } from "vitest";
import {
  maskSecret,
  redactedMcpStatus,
  renderMcpStatus,
} from "../../../engine/cli/renderers/mcp-status.js";
import { stripAnsi } from "../../../engine/cli/output.js";

describe("maskSecret", () => {
  it("returns <unset> for empty input", () => {
    expect(maskSecret(undefined)).toBe("<unset>");
    expect(maskSecret("")).toBe("<unset>");
    expect(maskSecret(null)).toBe("<unset>");
  });
  it("returns all asterisks for strings ≤ 4 chars", () => {
    expect(maskSecret("abc")).toBe("***");
    expect(maskSecret("abcd")).toBe("****");
  });
  it("shows only last 4 chars for longer tokens", () => {
    const masked = maskSecret("super-secret-token-123456");
    expect(masked.endsWith("3456")).toBe(true);
    expect(masked).not.toContain("super");
    expect(masked).not.toContain("secret");
  });
  it("caps the asterisk run at 12 characters", () => {
    const masked = maskSecret("a".repeat(200) + "WXYZ");
    expect(masked).toBe("************WXYZ");
  });
});

describe("redactedMcpStatus", () => {
  it("never includes the raw token in the redacted output", () => {
    const json = JSON.stringify(redactedMcpStatus({
      transport: "daemon",
      port: 8181,
      token: "super-secret",
      authMode: "bearer",
      pid: 4242,
    }));
    expect(json).not.toContain("super-secret");
  });
  it("reports tokenConfigured and tokenLast4", () => {
    const out = redactedMcpStatus({
      transport: "daemon",
      port: 8181,
      token: "super-secret-WXYZ",
      authMode: "bearer",
    });
    expect(out.tokenConfigured).toBe(true);
    expect(out.tokenLast4).toBe("WXYZ");
  });
  it("omits tokenLast4 when no token configured", () => {
    const out = redactedMcpStatus({ transport: "stdio" });
    expect(out.tokenConfigured).toBe(false);
    expect(out.tokenLast4).toBeUndefined();
  });
});

describe("renderMcpStatus", () => {
  it("renders transport and endpoints", () => {
    const out = renderMcpStatus({
      transport: "daemon",
      port: 8181,
      pid: 4242,
      pidPath: "/cache/kindx/mcp.pid",
      logPath: "/cache/kindx/mcp.log",
      mcpEndpoint: "http://localhost:8181/mcp",
      healthEndpoint: "http://localhost:8181/health",
      metricsEndpoint: "http://localhost:8181/metrics",
      stopCommand: "kindx mcp stop",
    }, { color: false });
    expect(out).toContain("daemon");
    expect(out).toContain("4242");
    expect(out).toContain("http://localhost:8181/mcp");
    expect(out).toContain("/health");
    expect(out).toContain("/metrics");
    expect(out).toContain("kindx mcp stop");
  });
  it("does not include the raw token even when present", () => {
    const out = renderMcpStatus({
      transport: "daemon",
      port: 8181,
      authMode: "bearer",
      token: "super-secret-XYZW",
      mcpEndpoint: "http://localhost:8181/mcp",
    }, { color: false });
    expect(out).not.toContain("super-secret");
    expect(out).toContain("XYZW"); // masked last-4 fragment is fine
  });
  it("emits no ANSI when color is off", () => {
    const out = renderMcpStatus({ transport: "stdio" }, { color: false });
    expect(out).toBe(stripAnsi(out));
  });
});
