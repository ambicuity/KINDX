import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureQuietWarn,
  errString,
  getQuietWarnCount,
  quietWarn,
  resetQuietWarnForTests,
} from "../engine/utils/quiet-warn.js";
import { renderPrometheusMetrics } from "../engine/utils/metrics.js";

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetQuietWarnForTests();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("quietWarn", () => {
  test("increments per-code counter", () => {
    quietWarn("test.simple");
    quietWarn("test.simple");
    quietWarn("test.simple");
    expect(getQuietWarnCount("test.simple")).toBe(3);
  });

  test("emits a Prometheus error counter labelled by code", () => {
    quietWarn("test.metric_emit");
    quietWarn("test.metric_emit");
    const out = renderPrometheusMetrics();
    expect(out).toContain('error{code="test.metric_emit"} 2');
  });

  test("logs WARN on first occurrence", () => {
    quietWarn("test.logs");
    expect(stderrSpy).toHaveBeenCalled();
    const written = (stderrSpy.mock.calls[0]?.[0] ?? "") as string;
    expect(written).toContain("WARN");
    expect(written).toContain("test.logs");
  });

  test("rate-limits via configureQuietWarn(logEveryN)", () => {
    configureQuietWarn("test.rate", { logEveryN: 5 });
    for (let i = 0; i < 12; i++) quietWarn("test.rate");
    // Should log on the 1st, 5th, 10th occurrences (3 times).
    const logCalls = stderrSpy.mock.calls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("test.rate")
    );
    expect(logCalls.length).toBe(3);
    // Counter still tracks every occurrence.
    expect(getQuietWarnCount("test.rate")).toBe(12);
  });

  test("ctx is logged as structured metadata, Error replaced with message", () => {
    quietWarn("test.ctx", { err: new Error("boom"), tenant: "acme" });
    const written = stderrSpy.mock.calls
      .map(([m]) => (typeof m === "string" ? m : ""))
      .join("");
    expect(written).toContain('"err":"boom"');
    expect(written).toContain('"tenant":"acme"');
  });

  test("errString stringifies Error / string / object", () => {
    expect(errString(new Error("xyz"))).toBe("xyz");
    expect(errString("plain")).toBe("plain");
    expect(errString({ foo: 1 })).toBe('{"foo":1}');
  });

  test("never throws even if logger or metrics throw internally", () => {
    // Force stderr to throw and ensure quietWarn still completes.
    stderrSpy.mockImplementation(() => { throw new Error("stderr-down"); });
    expect(() => quietWarn("test.resilient")).not.toThrow();
    expect(getQuietWarnCount("test.resilient")).toBe(1);
  });
});
