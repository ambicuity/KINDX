import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const kindxBin = join(projectRoot, "bin", "kindx");

let testDir: string;
let dbPath: string;
let configDir: string;
let fixturesDir: string;

async function runKindx(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = opts.cwd ?? fixturesDir;
  const proc = spawn(process.execPath, [kindxBin, ...args], {
    cwd,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      KINDX_CONFIG_DIR: configDir,
      XDG_CACHE_HOME: join(testDir, "cache"),
      PWD: cwd,
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutP = new Promise<string>((resolve, reject) => {
    let d = "";
    proc.stdout?.on("data", (c: Buffer) => { d += c.toString(); });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(d));
  });
  const stderrP = new Promise<string>((resolve, reject) => {
    let d = "";
    proc.stderr?.on("data", (c: Buffer) => { d += c.toString(); });
    proc.once("error", reject);
    proc.stderr?.once("end", () => resolve(d));
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });

  return { stdout: await stdoutP, stderr: await stderrP, exitCode };
}

beforeAll(async () => {
  if (!existsSync(kindxBin)) throw new Error(`Missing: ${kindxBin}`);
  if (!existsSync(join(projectRoot, "dist", "kindx.js"))) {
    throw new Error("dist/kindx.js missing — run npm run build first");
  }

  testDir = await mkdtemp(join(tmpdir(), "kindx-ops-"));
  dbPath = join(testDir, "ops.sqlite");
  configDir = join(testDir, "config");
  fixturesDir = join(testDir, "fixtures");

  await mkdir(configDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  await writeFile(join(fixturesDir, "README.md"), "# Ops test\n\nbackup and doctor checks\n");

  await runKindx(["collection", "add", fixturesDir, "--name", "ops"]);
  await runKindx(["update"]);
});

afterAll(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

describe("ops commands", () => {
  test("tenant add parses --role as string and persists role", async () => {
    const added = await runKindx(["tenant", "add", "editor-cli", "ops", "--role", "editor", "--json"]);
    expect(added.exitCode).toBe(0);
    const tenant = JSON.parse(added.stdout);
    expect(tenant.id).toBe("editor-cli");
    expect(tenant.role).toBe("editor");
    expect(tenant.allowedCollections).toContain("ops");
    expect(typeof tenant.token).toBe("string");
    expect(tenant.token.length).toBe(64);

    const shown = await runKindx(["tenant", "show", "editor-cli", "--json"]);
    expect(shown.exitCode).toBe(0);
    const stored = JSON.parse(shown.stdout);
    expect(stored.role).toBe("editor");
  });

  test("tenant add rejects invalid --role values", async () => {
    const res = await runKindx(["tenant", "add", "bad-role", "ops", "--role", "superadmin", "--json"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid role 'superadmin'");
  });

  test("doctor --json returns check list", async () => {
    const { stdout, exitCode } = await runKindx(["doctor", "--json"]);
    expect([0, 2]).toContain(exitCode);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("status");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.some((c: any) => c.id === "db_integrity")).toBe(true);
  });

  test("doctor parity sample flag is honored in shard health detail", async () => {
    const { stdout, exitCode } = await runKindx(["doctor", "--json", "--parity-sample", "8"]);
    expect([0, 2]).toContain(exitCode);
    const parsed = JSON.parse(stdout);
    const shard = parsed.checks.find((c: any) => c.id === "shard_health");
    expect(shard).toBeDefined();
    expect(String(shard.detail)).toContain("parity_sample=8");
  });

  test("repair --check-only --json returns diagnostic status", async () => {
    const { stdout, exitCode } = await runKindx(["repair", "--check-only", "--json"]);
    expect([0, 2]).toContain(exitCode);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("status");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  test("backup create + verify works", async () => {
    const backupPath = join(testDir, "backup.sqlite");
    const create = await runKindx(["backup", "create", backupPath, "--json"]);
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(create.stdout);
    expect(created.backupPath).toBe(backupPath);

    const verify = await runKindx(["backup", "verify", backupPath, "--json"]);
    expect(verify.exitCode).toBe(0);
    const verified = JSON.parse(verify.stdout);
    expect(verified.integrity).toBe("ok");
  });

  test("scheduler status returns shard/checkpoint payload", async () => {
    const { stdout, exitCode } = await runKindx(["scheduler", "status", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("shard");
    expect(parsed).toHaveProperty("checkpoint");
    expect(parsed).toHaveProperty("queue");
    expect(Array.isArray(parsed.queue)).toBe(true);
    for (const item of parsed.queue as any[]) {
      expect(typeof item.collection).toBe("string");
      expect(typeof item.total).toBe("number");
      expect(typeof item.pending).toBe("number");
      expect(typeof item.active).toBe("number");
    }
  });
});
