import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalHome: string | undefined;
let fakeHome: string;
let projectDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), "kindx-init-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "kindx-init-proj-"));
  process.env.HOME = fakeHome;
  vi.resetModules(); // make sure adapters.ts re-evaluates with the new HOME
});
afterEach(() => {
  process.env.HOME = originalHome;
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

describe("runInit orchestrator", () => {
  test("--client all wires every adapter and writes project file", async () => {
    const { runInit } = await import("../engine/init/index.js");
    const result = runInit({
      clients: ["all"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true,
    });
    expect(result.clientResults.length).toBeGreaterThanOrEqual(8);
    for (const r of result.clientResults) {
      expect(existsSync(r.configPath)).toBe(true);
    }
    expect(result.projectFile?.outcome).toBe("created");
    const agents = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- kindx:auto-invocation:start v=1 -->");
    expect(agents).toContain("auto-invocation contract");
  });

  test("--dry-run touches no disk", async () => {
    const { runInit } = await import("../engine/init/index.js");
    runInit({ clients: ["all"], projectPath: projectDir, globalOnly: false, dryRun: true, force: true });
    expect(existsSync(join(fakeHome, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);
  });

  test("re-running with same args produces no diff (idempotent)", async () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "# Header\n");
    const { runInit } = await import("../engine/init/index.js");
    runInit({ clients: ["claude-code"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true });
    const once = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    runInit({ clients: ["claude-code"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true });
    const twice = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    expect(twice).toBe(once);
  });

  test("--client auto only wires detected clients", async () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude", "settings.json"), "{}");
    const { runInit } = await import("../engine/init/index.js");
    const result = runInit({
      clients: ["auto"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true,
    });
    const names = result.clientResults.map((r) => r.name);
    expect(names).toContain("claude-code");
    expect(names).not.toContain("cursor");
  });
});
