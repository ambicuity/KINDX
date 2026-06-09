import { describe, it, expect } from "vitest";
import {
  renderMemorySearch,
  renderMemoryEntry,
} from "../../../engine/cli/renderers/memory.js";
import { stripAnsi } from "../../../engine/cli/output.js";

describe("renderMemorySearch", () => {
  it("renders header with scope and result count", () => {
    const out = renderMemorySearch(
      { scope: "default", mode: "semantic", query: "auth", totalResults: 2 },
      [
        { id: 7, key: "auth.flow", value: "JWT issued on login", similarity: 0.82 },
        { id: 9, key: "auth.token", value: "stored in HttpOnly cookie", similarity: 0.61 },
      ],
      { color: false },
    );
    expect(out).toContain("scope=default");
    expect(out).toContain("results=2");
    expect(out).toContain("#7");
    expect(out).toContain("auth.flow");
    expect(out).toContain("sim=0.820");
  });

  it("truncates long values for preview", () => {
    const longValue = "x".repeat(200);
    const out = renderMemorySearch(
      { scope: "default", mode: "text", query: "x", totalResults: 1 },
      [{ id: 1, key: "long", value: longValue }],
      { color: false },
    );
    expect(out).toContain("…");
    expect(out).not.toContain("x".repeat(200));
  });

  it("renders empty state", () => {
    const out = renderMemorySearch(
      { scope: "s", mode: "semantic", query: "q", totalResults: 0 },
      [],
      { color: false },
    );
    expect(out).toContain("No memories matched");
  });

  it("emits no ANSI when color off", () => {
    const out = renderMemorySearch(
      { scope: "s", mode: "semantic", query: "q", totalResults: 1 },
      [{ id: 1, key: "k", value: "v" }],
      { color: false },
    );
    expect(out).toBe(stripAnsi(out));
  });
});

describe("renderMemoryEntry", () => {
  it("renders id, key, value", () => {
    const out = renderMemoryEntry(
      { id: 42, key: "config.token", value: "abc" },
      { color: false, scope: "default" },
    );
    expect(out).toContain("Stored memory");
    expect(out).toContain("42");
    expect(out).toContain("config.token");
  });
  it("supports a custom action label", () => {
    const out = renderMemoryEntry(
      { id: 1, key: "k", value: "v" },
      { color: false, scope: "default", action: "Updated" },
    );
    expect(out).toContain("Updated memory");
  });
});
