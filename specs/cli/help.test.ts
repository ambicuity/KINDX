import { describe, it, expect } from "vitest";
import { renderRootHelp, renderCommandHelp, listCommandNames } from "../../engine/cli/help.js";
import { stripAnsi } from "../../engine/cli/output.js";

describe("renderRootHelp", () => {
  it("renders every documented domain group", () => {
    const out = stripAnsi(renderRootHelp({ color: false }));
    expect(out).toContain("Search and retrieval:");
    expect(out).toContain("Collections and indexing:");
    expect(out).toContain("Memory:");
    expect(out).toContain("MCP / server:");
    expect(out).toContain("Diagnostics and maintenance:");
    expect(out).toContain("Backup and restore:");
    expect(out).toContain("Migration:");
    expect(out).toContain("Developer / debug tooling:");
  });

  it("documents the new global flags", () => {
    const out = stripAnsi(renderRootHelp({ color: false }));
    expect(out).toContain("--format");
    expect(out).toContain("--plain");
    expect(out).toContain("--no-color");
    expect(out).toContain("--dry-run");
    expect(out).toContain("--interactive");
  });

  it("includes quickstart hints", () => {
    const out = stripAnsi(renderRootHelp({ color: false }));
    expect(out).toContain("kindx init");
    expect(out).toContain("kindx tui");
  });

  it("produces no ANSI in monochrome mode", () => {
    const out = renderRootHelp({ color: false });
    expect(out).toBe(stripAnsi(out));
  });
});

describe("renderCommandHelp", () => {
  it("returns undefined for unknown commands", () => {
    expect(renderCommandHelp("not-a-command", { color: false })).toBeUndefined();
  });

  it("renders usage + examples for query", () => {
    const out = stripAnsi(renderCommandHelp("query", { color: false })!);
    expect(out).toContain("kindx query");
    expect(out).toContain("Usage:");
    expect(out).toContain("Examples:");
    expect(out).toContain("--interactive");
  });

  it("resolves aliases (vector-search → vsearch)", () => {
    const out = renderCommandHelp("vector-search", { color: false });
    expect(out).toBeDefined();
    expect(stripAnsi(out!)).toContain("kindx vsearch");
  });
});

describe("listCommandNames", () => {
  it("includes every command we expect", () => {
    const names = listCommandNames();
    for (const expected of ["query", "search", "vsearch", "init", "mcp", "doctor", "status", "memory", "tui"]) {
      expect(names).toContain(expected);
    }
  });
});
