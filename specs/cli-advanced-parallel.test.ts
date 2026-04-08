import { describe, test, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type CliEnv = {
  rootDir: string;
  workDir: string;
  dbPath: string;
  configDir: string;
  run: (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<CliResult>;
};

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const kindxBin = join(projectRoot, "bin", "kindx");

async function runCli(
  args: string[],
  options: {
    cwd: string;
    dbPath: string;
    configDir: string;
    env?: Record<string, string>;
  }
): Promise<CliResult> {
  const proc = spawn(process.execPath, [kindxBin, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      INDEX_PATH: options.dbPath,
      KINDX_CONFIG_DIR: options.configDir,
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
    proc.once("close", (code) => resolve(code ?? 1));
  });

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, exitCode };
}

async function withCliEnv(name: string, fn: (env: CliEnv) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), `kindx-advanced-${name}-`));
  const workDir = join(rootDir, "workspace");
  const configDir = join(rootDir, "config");
  const dbPath = join(rootDir, "index.sqlite");

  await mkdir(workDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n", "utf8");

  const run = (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) =>
    runCli(args, {
      cwd: opts?.cwd || workDir,
      dbPath,
      configDir,
      env: opts?.env,
    });

  try {
    await fn({ rootDir, workDir, dbPath, configDir, run });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("CLI advanced command coverage", () => {
  test("collection show/update-cmd/include/exclude round-trip", async () => {
    await withCliEnv("collection-advanced", async ({ workDir, run }) => {
      const collDir = join(workDir, "alpha");
      await mkdir(collDir, { recursive: true });
      await writeFile(join(collDir, "readme.md"), "# Alpha\ncollection show test\n", "utf8");

      const add = await run(["collection", "add", collDir, "--name", "alpha"]);
      expect(add.exitCode).toBe(0);

      const showDefault = await run(["collection", "show", "alpha"]);
      expect(showDefault.exitCode).toBe(0);
      expect(showDefault.stdout).toContain("Collection: alpha");
      expect(showDefault.stdout).toContain("Include:  yes (default)");

      const exclude = await run(["collection", "exclude", "alpha"]);
      expect(exclude.exitCode).toBe(0);
      expect(exclude.stdout).toContain("excluded from default queries");

      const showExcluded = await run(["collection", "show", "alpha"]);
      expect(showExcluded.exitCode).toBe(0);
      expect(showExcluded.stdout).toContain("Include:  no");

      const include = await run(["collection", "include", "alpha"]);
      expect(include.exitCode).toBe(0);
      expect(include.stdout).toContain("included in default queries");

      const showIncluded = await run(["collection", "show", "alpha"]);
      expect(showIncluded.exitCode).toBe(0);
      expect(showIncluded.stdout).toContain("Include:  yes (default)");

      const setCmd = await run(["collection", "update-cmd", "alpha", "echo kindx-advanced-update"]);
      expect(setCmd.exitCode).toBe(0);
      expect(setCmd.stdout).toContain("Set update command for 'alpha'");

      const showWithCmd = await run(["collection", "show", "alpha"]);
      expect(showWithCmd.exitCode).toBe(0);
      expect(showWithCmd.stdout).toContain("Update:   echo kindx-advanced-update");

      const clearCmd = await run(["collection", "update-cmd", "alpha"]);
      expect(clearCmd.exitCode).toBe(0);
      expect(clearCmd.stdout).toContain("Cleared update command for 'alpha'");

      const showCleared = await run(["collection", "show", "alpha"]);
      expect(showCleared.exitCode).toBe(0);
      expect(showCleared.stdout).not.toContain("Update:");
    });
  });

  test("memory mark-accessed/embed/help/unknown-subcommand behavior", async () => {
    await withCliEnv("memory-advanced", async ({ run }) => {
      const help = await run(["memory", "help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("Usage: kindx memory <subcommand> [options]");
      expect(help.stdout).toContain("mark-accessed");
      expect(help.stdout).toContain("embed");

      const unknown = await run(["memory", "definitely-not-a-subcommand"]);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("Unknown memory subcommand");

      const put = await run([
        "memory",
        "put",
        "--scope",
        "adv-mem",
        "--key",
        "agent:role",
        "--value",
        "reviewer",
        "--json",
      ]);
      expect(put.exitCode).toBe(0);
      const putPayload = JSON.parse(put.stdout);
      expect(putPayload.scope).toBe("adv-mem");
      expect(typeof putPayload.memory.id).toBe("number");

      const mark = await run([
        "memory",
        "mark-accessed",
        "--scope",
        "adv-mem",
        "--id",
        String(putPayload.memory.id),
        "--json",
      ]);
      expect(mark.exitCode).toBe(0);
      const markPayload = JSON.parse(mark.stdout);
      expect(markPayload).toMatchObject({
        scope: "adv-mem",
        id: putPayload.memory.id,
        marked: true,
      });

      const embed = await run(["memory", "embed", "--scope", "empty-advanced-scope", "--json"]);
      expect(embed.exitCode).toBe(0);
      const embedPayload = JSON.parse(embed.stdout);
      expect(embedPayload.scope).toBe("empty-advanced-scope");
      expect(typeof embedPayload.totalCandidates).toBe("number");
      expect(typeof embedPayload.embedded).toBe("number");
      expect(embedPayload.totalCandidates).toBe(0);
      expect(embedPayload.embedded).toBe(0);
    });
  });

  test("vsearch and vector-search alias share deterministic usage error path", async () => {
    await withCliEnv("vsearch-advanced", async ({ run }) => {
      const vsearch = await run(["vsearch"]);
      expect(vsearch.exitCode).toBe(1);
      expect(vsearch.stderr).toContain("Usage: kindx vsearch [options] <query>");

      const alias = await run(["vector-search"]);
      expect(alias.exitCode).toBe(1);
      expect(alias.stderr).toContain("Usage: kindx vsearch [options] <query>");
    });
  });

  test("query handles structured typed lines and rejects mixed invalid lines", async () => {
    await withCliEnv("query-structured", async ({ workDir, run }) => {
      const collDir = join(workDir, "docs");
      await mkdir(collDir, { recursive: true });
      await writeFile(join(collDir, "topic.md"), "# Topic\nThis document is indexed for query parsing checks.\n", "utf8");

      const add = await run(["collection", "add", collDir, "--name", "docs"]);
      expect(add.exitCode).toBe(0);

      const validStructured = await run([
        "query",
        "--json",
        "lex: token-not-present-advanced\nlex: another-token-not-present-advanced",
      ]);
      expect(validStructured.exitCode).toBe(0);
      expect(validStructured.stderr).toContain("Structured search: 2 queries");
      expect(JSON.parse(validStructured.stdout)).toEqual([]);

      const invalidMixed = await run([
        "query",
        "lex: valid-line\nthis line is invalid",
      ]);
      expect(invalidMixed.exitCode).toBe(1);
      expect(invalidMixed.stderr).toContain("missing a lex:/vec:/hyde: prefix");
    });
  });

  test("update -c filters update to the requested collection", async () => {
    await withCliEnv("update-filter", async ({ workDir, run }) => {
      const alphaDir = join(workDir, "alpha");
      const betaDir = join(workDir, "beta");
      await mkdir(alphaDir, { recursive: true });
      await mkdir(betaDir, { recursive: true });

      const alphaFile = join(alphaDir, "alpha.md");
      const betaFile = join(betaDir, "beta.md");

      await writeFile(alphaFile, "# Alpha\nalpha-version-1\n", "utf8");
      await writeFile(betaFile, "# Beta\nbeta-version-1\n", "utf8");

      const addAlpha = await run(["collection", "add", alphaDir, "--name", "alpha"]);
      expect(addAlpha.exitCode).toBe(0);
      const addBeta = await run(["collection", "add", betaDir, "--name", "beta"]);
      expect(addBeta.exitCode).toBe(0);

      await writeFile(alphaFile, "# Alpha\nalpha-version-2\n", "utf8");
      await writeFile(betaFile, "# Beta\nbeta-version-2\n", "utf8");

      const updateFiltered = await run(["update", "-c", "alpha"]);
      expect(updateFiltered.exitCode).toBe(0);
      expect(updateFiltered.stdout).toContain("Updating 1 collection(s)");

      const alphaDoc = await run(["get", "kindx://alpha/alpha.md"]);
      expect(alphaDoc.exitCode).toBe(0);
      expect(alphaDoc.stdout).toContain("alpha-version-2");

      const betaDoc = await run(["get", "kindx://beta/beta.md"]);
      expect(betaDoc.exitCode).toBe(0);
      expect(betaDoc.stdout).toContain("beta-version-1");
      expect(betaDoc.stdout).not.toContain("beta-version-2");
    });
  });
});
