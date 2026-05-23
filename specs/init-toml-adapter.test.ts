import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { createTomlAdapter } from "../engine/init/toml-adapter.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kindx-toml-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createTomlAdapter (Codex CLI)", () => {
  test("creates file with [mcp_servers.kindx] when missing", () => {
    const cfg = join(dir, "config.toml");
    const a = createTomlAdapter({ name: "codex", label: "Codex", configPath: cfg, key: "mcp_servers.kindx" });
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("created");
    const parsed: any = TOML.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.mcp_servers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("preserves unrelated keys in existing file", () => {
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n`);
    const a = createTomlAdapter({ name: "codex", label: "Codex", configPath: cfg, key: "mcp_servers.kindx" });
    a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    const parsed: any = TOML.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.mcp_servers.other.command).toBe("x");
    expect(parsed.mcp_servers.kindx.command).toBe("kindx");
  });

  test("detect.alreadyWired true when entry exists", () => {
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, `[mcp_servers.kindx]\ncommand = "kindx"\nargs = ["mcp"]\n`);
    const a = createTomlAdapter({ name: "codex", label: "Codex", configPath: cfg, key: "mcp_servers.kindx" });
    expect(a.detect().alreadyWired).toBe(true);
  });
});
