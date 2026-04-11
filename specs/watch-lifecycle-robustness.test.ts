import { describe, test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rename, unlink, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import Database from "better-sqlite3";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const kindxBin = join(projectRoot, "bin", "kindx");

async function runKindx(
  args: string[],
  options: {
    cwd: string;
    dbPath: string;
    configDir: string;
    cacheHome: string;
    env?: Record<string, string>;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(process.execPath, [kindxBin, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      INDEX_PATH: options.dbPath,
      KINDX_CONFIG_DIR: options.configDir,
      XDG_CACHE_HOME: options.cacheHome,
      PWD: options.cwd,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stdout?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(data));
  });
  const stderrPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stderr?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stderr?.once("end", () => resolve(data));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });

  return {
    stdout: await stdoutPromise,
    stderr: await stderrPromise,
    exitCode,
  };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 150
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function stopWatchProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  proc.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => proc.once("close", () => resolve())),
    sleep(3000).then(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }),
  ]);
}

describe("watch lifecycle robustness", () => {
  test("handles rename/delete churn without stale active documents", async () => {
    if (!existsSync(kindxBin)) {
      throw new Error(`CLI entrypoint not found: ${kindxBin}`);
    }
    if (!existsSync(join(projectRoot, "dist", "kindx.js"))) {
      throw new Error("dist/kindx.js not found. Run `npm run build` before running CLI integration tests.");
    }

    const root = await mkdtemp(join(tmpdir(), "kindx-watch-robust-"));
    const configDir = join(root, "config");
    const cacheHome = join(root, "cache");
    const watchDir = join(root, "watch");
    const dbPath = join(root, "watch.sqlite");

    let proc: ChildProcessWithoutNullStreams | null = null;
    let daemonOut = "";

    try {
      await mkdir(configDir, { recursive: true });
      await mkdir(cacheHome, { recursive: true });
      await mkdir(watchDir, { recursive: true });
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      await writeFile(join(watchDir, "initial.md"), "# Initial");

      const added = await runKindx(["collection", "add", watchDir, "--name", "watch_robust"], {
        cwd: watchDir,
        dbPath,
        configDir,
        cacheHome,
      });
      expect(added.exitCode).toBe(0);

      proc = spawn(process.execPath, [kindxBin, "watch", "watch_robust"], {
        cwd: watchDir,
        env: {
          ...process.env,
          CHOKIDAR_USEPOLLING: "1",
          CHOKIDAR_INTERVAL: "100",
          INDEX_PATH: dbPath,
          KINDX_CONFIG_DIR: configDir,
          XDG_CACHE_HOME: cacheHome,
          PWD: watchDir,
        },
        stdio: "pipe",
      });

      proc.stdout.on("data", (d) => { daemonOut += d.toString(); });
      proc.stderr.on("data", (d) => { daemonOut += d.toString(); });

      await waitFor(() => daemonOut.includes("Daemon active"), 7000);

      const oldToken = `watchold${Date.now()}`;
      const newToken = `watchnew${Date.now()}`;
      const oldPhrase = `old lifecycle marker ${oldToken}`;
      const newPhrase = `final replacement marker ${newToken}`;
      const oldPath = join(watchDir, "churn.md");
      const renamedPath = join(watchDir, "churn-renamed.md");

      await writeFile(oldPath, `# Old\n\n${oldPhrase}`);
      await sleep(900);
      await rename(oldPath, renamedPath);
      await sleep(150);
      await unlink(renamedPath);
      await sleep(150);
      await writeFile(renamedPath, `# New\n\n${newPhrase}`);

      await waitFor(() => {
        const db = new Database(dbPath, { readonly: true });
        try {
          const activeOld = db.prepare(
            `SELECT COUNT(*) AS c FROM documents WHERE path = ? AND active = 1`
          ).get("churn.md") as { c: number };
          const activeNew = db.prepare(
            `SELECT COUNT(*) AS c FROM documents WHERE path = ? AND active = 1`
          ).get("churn-renamed.md") as { c: number };
          const staleOldToken = db.prepare(
            `SELECT COUNT(*) AS c
             FROM documents d
             JOIN content c ON c.hash = d.hash
             WHERE d.active = 1 AND c.doc LIKE ?`
          ).get(`%${oldPhrase}%`) as { c: number };
          const newDocHasToken = db.prepare(
            `SELECT COUNT(*) AS c
             FROM documents d
             JOIN content c ON c.hash = d.hash
             WHERE d.path = ? AND d.active = 1 AND c.doc LIKE ?`
          ).get("churn-renamed.md", `%${newPhrase}%`) as { c: number };
          return activeOld.c === 0 && activeNew.c === 1 && staleOldToken.c === 0 && newDocHasToken.c === 1;
        } finally {
          db.close();
        }
      }, 12000);

      const search = await runKindx(["search", "final replacement marker"], {
        cwd: watchDir,
        dbPath,
        configDir,
        cacheHome,
      });
      expect(search.exitCode).toBe(0);
      expect(search.stdout).toContain("churn-renamed.md");
      expect(search.stdout).not.toContain("churn.md");
    } finally {
      if (proc) await stopWatchProcess(proc);
      await rm(root, { recursive: true, force: true });
    }
  }, 25000);
});
