import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const kindxBin = join(projectRoot, "bin", "kindx");

async function runKindx(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [kindxBin, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  return { code, stdout, stderr };
}

describe("arch CLI commands", () => {
  test("arch help renders detailed usage, flags, and env guidance", async () => {
    const res = await runKindx(["arch", "help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage: kindx arch <status|build|import|refresh>");
    expect(res.stdout).toContain("status");
    expect(res.stdout).toContain("build");
    expect(res.stdout).toContain("import");
    expect(res.stdout).toContain("refresh");
    expect(res.stdout).toContain("--arch-root <path>");
    expect(res.stdout).toContain("--arch-hints");
    expect(res.stdout).toContain("--arch-refresh");
    expect(res.stdout).toContain("KINDX_ARCH_ENABLED=1");
    expect(res.stdout).toContain("KINDX_ARCH_REPO_PATH");
    expect(res.stdout).toContain("KINDX_ARCH_ARTIFACT_DIR");
    expect(res.stdout).toContain("KINDX_ARCH_COLLECTION");
  });

  test("arch build requires feature flag", async () => {
    const res = await runKindx(["arch", "build"], {
      KINDX_ARCH_ENABLED: "0",
    });
    expect(res.code).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toContain("Arch integration is disabled");
  });
});
