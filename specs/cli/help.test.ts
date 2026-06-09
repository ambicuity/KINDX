import { describe, it, expect } from "vitest";
import {
  renderRootHelp,
  renderCommandHelp,
  listCommandNames,
  renderSubcommandList,
  renderSubcommandHelp,
} from "../../engine/cli/help.js";
import { stripAnsi } from "../../engine/cli/output.js";

describe("renderSubcommandList", () => {
  it("returns undefined for commands without subcommands", () => {
    expect(renderSubcommandList("query", { color: false })).toBeUndefined();
    expect(renderSubcommandList("status", { color: false })).toBeUndefined();
    expect(renderSubcommandList("not-a-real-command", { color: false })).toBeUndefined();
  });

  it("renders a usage + subcommand table for `collection`", () => {
    const out = renderSubcommandList("collection", { color: false });
    expect(out).toBeDefined();
    expect(out!).toContain("kindx collection");
    expect(out!).toContain("Subcommands:");
    expect(out!).toContain("list");
    expect(out!).toContain("add");
    expect(out!).toContain("remove");
    expect(out!).toContain("rename");
    expect(out!).toContain("Run `kindx collection <subcommand> --help`");
  });

  it("shows aliases in the subcommand label", () => {
    const out = renderSubcommandList("collection", { color: false });
    expect(out!).toContain("remove (rm)");
    expect(out!).toContain("rename (mv)");
  });

  it("emits no ANSI when color is off", () => {
    const out = renderSubcommandList("collection", { color: false })!;
    expect(out).toBe(stripAnsi(out));
  });

  it("emits ANSI when color is on", () => {
    const out = renderSubcommandList("collection", { color: true })!;
    expect(out).not.toBe(stripAnsi(out));
  });

  it("renders for index/tenant/backup/context/memory/mcp", () => {
    for (const cmd of ["index", "tenant", "backup", "context", "memory", "mcp"] as const) {
      const out = renderSubcommandList(cmd, { color: false });
      expect(out, `no subcommand list for ${cmd}`).toBeDefined();
      expect(out!).toContain(`kindx ${cmd}`);
      expect(out!).toContain("Subcommands:");
    }
  });
});

describe("renderSubcommandHelp", () => {
  it("renders the detail block for a known subcommand", () => {
    const out = renderSubcommandHelp("collection", "add", { color: false });
    expect(out).toBeDefined();
    expect(out!).toContain("kindx collection add");
    expect(out!).toContain("Usage:");
    expect(out!).toContain("Examples:");
  });

  it("resolves subcommand aliases (`rm` → `remove`)", () => {
    const viaAlias = renderSubcommandHelp("collection", "rm", { color: false });
    const viaCanon = renderSubcommandHelp("collection", "remove", { color: false });
    expect(viaAlias).toBe(viaCanon);
  });

  it("returns undefined for an unknown subcommand", () => {
    expect(renderSubcommandHelp("collection", "nope", { color: false })).toBeUndefined();
  });

  it("returns undefined for an unknown command", () => {
    expect(renderSubcommandHelp("not-a-real-command", "x", { color: false })).toBeUndefined();
  });

  it("returns undefined for a command without subcommands", () => {
    expect(renderSubcommandHelp("query", "anything", { color: false })).toBeUndefined();
  });

  it("includes the Aliases footer when aliases exist", () => {
    const out = renderSubcommandHelp("collection", "remove", { color: false })!;
    expect(out).toContain("Aliases:");
    expect(out).toContain("rm");
  });

  it("emits no ANSI when color is off", () => {
    const out = renderSubcommandHelp("collection", "add", { color: false })!;
    expect(out).toBe(stripAnsi(out));
  });
});

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
