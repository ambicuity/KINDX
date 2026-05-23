import { describe, it, expect } from "vitest";
import {
  renderDiagnostics,
  fromLegacyChecks,
  overallStatus,
  type DiagnosticCheck,
} from "../../../engine/cli/renderers/diagnostics.js";
import { stripAnsi } from "../../../engine/cli/output.js";

const sample: DiagnosticCheck[] = [
  { id: "sqlite_vec", severity: "ok", detail: "available" },
  { id: "models", severity: "warn", detail: "missing: qwen3-1.7b" },
  { id: "db_integrity", severity: "error", detail: "corruption detected", recommendation: "run `kindx cleanup`" },
  { id: "remote_backend", severity: "skip", detail: "no remote configured" },
];

describe("renderDiagnostics", () => {
  it("groups by severity (ok before warn before error before skip)", () => {
    const out = renderDiagnostics(sample, { color: false, env: { LANG: "C" } });
    const lines = out.split("\n").filter((l) => l.includes(":"));
    const indexes = ["sqlite_vec", "models", "db_integrity", "remote_backend"].map((id) =>
      lines.findIndex((l) => l.includes(id))
    );
    // Strictly increasing — verifies sort order.
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
  });

  it("renders recommendation lines beneath the check", () => {
    const out = renderDiagnostics(sample, { color: false, env: { LANG: "C" } });
    expect(out).toContain("kindx cleanup");
  });

  it("emits ASCII glyphs when locale is non-UTF-8", () => {
    const out = renderDiagnostics(sample, { color: false, env: { LANG: "C" } });
    expect(out).toContain("[ok]");
    expect(out).toContain("[!]");
    expect(out).toContain("[x]");
  });

  it("emits Unicode glyphs for UTF-8 locales", () => {
    const out = renderDiagnostics(sample, { color: false, env: { LANG: "en_US.UTF-8" } });
    expect(out).toContain("✓");
    expect(out).toContain("✗");
  });

  it("emits no ANSI when color is off", () => {
    const out = renderDiagnostics(sample, { color: false, env: { LANG: "C" } });
    expect(out).toBe(stripAnsi(out));
  });

  it("includes summary line by default", () => {
    const out = renderDiagnostics(sample, { color: false, env: { LANG: "C" } });
    expect(out).toMatch(/1 ok/);
    expect(out).toMatch(/1 warn/);
    expect(out).toMatch(/1 error/);
  });

  it("respects showSummary=false", () => {
    const out = renderDiagnostics(sample, { color: false, env: { LANG: "C" }, showSummary: false });
    expect(out).not.toMatch(/1 ok\s+1 warn/);
  });
});

describe("fromLegacyChecks", () => {
  it("ok=true → severity ok", () => {
    const [c] = fromLegacyChecks([{ id: "x", ok: true, detail: "fine" }]);
    expect(c.severity).toBe("ok");
  });

  it("known-fatal id with ok=false → severity error", () => {
    const [c] = fromLegacyChecks([{ id: "db_integrity", ok: false, detail: "bad" }]);
    expect(c.severity).toBe("error");
  });

  it("unknown id with ok=false → severity warn", () => {
    const [c] = fromLegacyChecks([{ id: "models", ok: false, detail: "missing" }]);
    expect(c.severity).toBe("warn");
  });
});

describe("overallStatus", () => {
  it("ok when no warn/error", () => {
    expect(overallStatus([{ id: "x", severity: "ok", detail: "" }])).toBe("ok");
  });
  it("warn when any warn but no error", () => {
    expect(overallStatus([
      { id: "x", severity: "ok", detail: "" },
      { id: "y", severity: "warn", detail: "" },
    ])).toBe("warn");
  });
  it("failed when any error present", () => {
    expect(overallStatus([
      { id: "x", severity: "warn", detail: "" },
      { id: "y", severity: "error", detail: "" },
    ])).toBe("failed");
  });
});
