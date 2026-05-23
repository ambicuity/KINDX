import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonAdapter } from "../engine/init/json-adapter.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kindx-jsa-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createJsonAdapter", () => {
  test("creates file with mcpServers.kindx when missing", () => {
    const cfg = join(dir, "settings.json");
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    expect(a.detect().exists).toBe(false);
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("created");
    const parsed = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.mcpServers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("preserves unrelated keys", () => {
    const cfg = join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }, null, 2));
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("updated");
    const parsed = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("skips when already wired and force=false", () => {
    const cfg = join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { kindx: { command: "kindx", args: ["mcp"] } } }));
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    expect(a.detect().alreadyWired).toBe(true);
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("skipped");
  });

  test("overwrites when force=true", () => {
    const cfg = join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { kindx: { command: "old", args: [] } } }));
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    const r = a.write({ force: true, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("updated");
    expect(JSON.parse(readFileSync(cfg, "utf-8")).mcpServers.kindx.command).toBe("kindx");
    expect(r.backupPath && existsSync(r.backupPath)).toBe(true);
  });

  test("dryRun does not touch disk", () => {
    const cfg = join(dir, "settings.json");
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    const r = a.write({ force: false, dryRun: true, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("created");
    expect(existsSync(cfg)).toBe(false);
  });

  test("handles nested keyPath (e.g. ['mcp','servers','kindx'])", () => {
    const cfg = join(dir, "opencode.json");
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcp", "servers", "kindx"] });
    a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    const parsed = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.mcp.servers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("jsoncTolerant: tolerates // line comments and trailing commas in input, but writes plain JSON", () => {
    const cfg = join(dir, "cursor-mcp.json");
    writeFileSync(cfg, `// header comment\n{\n  "mcpServers": { },\n}`);
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"], jsoncTolerant: true });
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("updated");
    const parsed = JSON.parse(readFileSync(cfg, "utf-8")); // strict JSON
    expect(parsed.mcpServers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });
});
