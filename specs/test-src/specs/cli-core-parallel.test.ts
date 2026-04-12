import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

let tempRoot: string;
let workspaceDir: string;
let testCounter = 0;

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const kindxBin = join(projectRoot, "bin", "kindx");

type TestEnv = {
  dbPath: string;
  configDir: string;
  cacheHome: string;
};

async function createIsolatedTestEnv(prefix: string): Promise<TestEnv> {
  testCounter += 1;
  const dbPath = join(tempRoot, `${prefix}-${testCounter}.sqlite`);
  const configDir = join(tempRoot, `${prefix}-config-${testCounter}`);
  const cacheHome = join(tempRoot, `${prefix}-cache-${testCounter}`);
  await mkdir(configDir, { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  return { dbPath, configDir, cacheHome };
}

async function runKindx(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    testEnv?: TestEnv;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = options.cwd ?? workspaceDir;
  const testEnv = options.testEnv;

  const proc = spawn(process.execPath, [kindxBin, ...args], {
    cwd,
    env: {
      ...process.env,
      ...(testEnv
        ? {
            INDEX_PATH: testEnv.dbPath,
            KINDX_CONFIG_DIR: testEnv.configDir,
            XDG_CACHE_HOME: testEnv.cacheHome,
          }
        : {}),
      PWD: cwd,
      NO_COLOR: "1",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutPromise = new Promise<string>((resolve, reject) => {
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(output));
  });

  const stderrPromise = new Promise<string>((resolve, reject) => {
    let output = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.once("error", reject);
    proc.stderr?.once("end", () => resolve(output));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  });

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  if (!existsSync(kindxBin)) {
    throw new Error(`CLI entrypoint not found: ${kindxBin}`);
  }
  if (!existsSync(join(projectRoot, "dist", "kindx.js"))) {
    throw new Error("dist/kindx.js not found. Run `npm run build` before running CLI integration tests.");
  }

  tempRoot = await mkdtemp(join(tmpdir(), "kindx-cli-core-"));
  workspaceDir = join(tempRoot, "workspace");
  await mkdir(join(workspaceDir, "docs"), { recursive: true });

  await writeFile(
    join(workspaceDir, "docs", "alpha.md"),
    ["alpha line 1", "alpha line 2", "alpha line 3", "alpha line 4"].join("\n") + "\n"
  );

  await writeFile(
    join(workspaceDir, "docs", "beta.md"),
    ["beta line 1", "beta line 2"].join("\n") + "\n"
  );
});

afterAll(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("CLI core commands", () => {
  test("prints --version", async () => {
    const env = await createIsolatedTestEnv("version");
    const { stdout, exitCode } = await runKindx(["--version"], { testEnv: env });

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^kindx\s+\d+\.\d+\.\d+/);
  });

  test("scopes state by --index", async () => {
    const env = await createIsolatedTestEnv("index-scope");

    const initialBlue = await runKindx(["--index", "blue", "ls"], { testEnv: env });
    expect(initialBlue.exitCode).toBe(0);
    expect(initialBlue.stdout).toContain("No collections found");

    const addBlue = await runKindx(
      ["--index", "blue", "collection", "add", workspaceDir, "--name", "bluec", "--mask", "docs/*.md"],
      { testEnv: env }
    );
    expect(addBlue.exitCode).toBe(0);

    const blueLs = await runKindx(["--index", "blue", "ls"], { testEnv: env });
    expect(blueLs.exitCode).toBe(0);
    expect(blueLs.stdout).toContain("kindx://bluec/");

    const defaultLs = await runKindx(["ls"], { testEnv: env });
    expect(defaultLs.exitCode).toBe(0);
    expect(defaultLs.stdout).toContain("No collections found");
  });

  test("shows context add/list/remove usage errors", async () => {
    const env = await createIsolatedTestEnv("context-usage");

    const missingSubcommand = await runKindx(["context"], { testEnv: env });
    expect(missingSubcommand.exitCode).toBe(1);
    expect(missingSubcommand.stderr).toContain("Usage: kindx context <add|list|rm>");

    const addMissingText = await runKindx(["context", "add"], { testEnv: env });
    expect(addMissingText.exitCode).toBe(1);
    expect(addMissingText.stderr).toContain('Usage: kindx context add [path] "text"');

    const rmMissingPath = await runKindx(["context", "rm"], { testEnv: env });
    expect(rmMissingPath.exitCode).toBe(1);
    expect(rmMissingPath.stderr).toContain("Usage: kindx context rm <path>");

    const listEmpty = await runKindx(["context", "list"], { testEnv: env });
    expect(listEmpty.exitCode).toBe(0);
    expect(listEmpty.stdout).toContain("No contexts configured");
  });

  test("supports get with --from and --line-numbers", async () => {
    const env = await createIsolatedTestEnv("get-range");

    const add = await runKindx(
      ["collection", "add", workspaceDir, "--name", "core", "--mask", "docs/*.md"],
      { testEnv: env }
    );
    expect(add.exitCode).toBe(0);

    const result = await runKindx(
      ["get", "core/docs/alpha.md", "--from", "2", "-l", "2", "--line-numbers"],
      { testEnv: env }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2: alpha line 2");
    expect(result.stdout).toContain("3: alpha line 3");
    expect(result.stdout).not.toContain("1: alpha line 1");
    expect(result.stdout).not.toContain("4: alpha line 4");
  });

  test("supports multi-get output formats and missing-arg usage", async () => {
    const env = await createIsolatedTestEnv("multi-get");

    const add = await runKindx(
      ["collection", "add", workspaceDir, "--name", "core", "--mask", "docs/*.md"],
      { testEnv: env }
    );
    expect(add.exitCode).toBe(0);

    const target = "kindx://core/docs/alpha.md";

    const asJson = await runKindx(["multi-get", target, "--json"], { testEnv: env });
    expect(asJson.exitCode).toBe(0);
    const parsed = JSON.parse(asJson.stdout) as Array<Record<string, string>>;
    expect(parsed[0]?.file).toBe("docs/alpha.md");
    expect(parsed[0]?.body).toContain("alpha line 1");

    const asCsv = await runKindx(["multi-get", target, "--csv"], { testEnv: env });
    expect(asCsv.exitCode).toBe(0);
    expect(asCsv.stdout).toContain("file,title,context,skipped,body");
    expect(asCsv.stdout).toContain("docs/alpha.md");

    const asMd = await runKindx(["multi-get", target, "--md"], { testEnv: env });
    expect(asMd.exitCode).toBe(0);
    expect(asMd.stdout).toContain("## docs/alpha.md");
    expect(asMd.stdout).toContain("```");

    const asXml = await runKindx(["multi-get", target, "--xml"], { testEnv: env });
    expect(asXml.exitCode).toBe(0);
    expect(asXml.stdout).toContain("<documents>");
    expect(asXml.stdout).toContain("<file>docs/alpha.md</file>");

    const asFiles = await runKindx(["multi-get", target, "--files"], { testEnv: env });
    expect(asFiles.exitCode).toBe(0);
    expect(asFiles.stdout.trim()).toContain("docs/alpha.md");

    const missingPattern = await runKindx(["multi-get"], { testEnv: env });
    expect(missingPattern.exitCode).toBe(1);
    expect(missingPattern.stderr).toContain("Usage: kindx multi-get <pattern>");
  });

  test("lists collections and files via ls", async () => {
    const env = await createIsolatedTestEnv("ls");

    const add = await runKindx(
      ["collection", "add", workspaceDir, "--name", "core", "--mask", "docs/*.md"],
      { testEnv: env }
    );
    expect(add.exitCode).toBe(0);

    const rootList = await runKindx(["ls"], { testEnv: env });
    expect(rootList.exitCode).toBe(0);
    expect(rootList.stdout).toContain("Collections:");
    expect(rootList.stdout).toContain("kindx://core/");

    const fileList = await runKindx(["ls", "core"], { testEnv: env });
    expect(fileList.exitCode).toBe(0);
    expect(fileList.stdout).toContain("kindx://core/docs/alpha.md");
    expect(fileList.stdout).toContain("kindx://core/docs/beta.md");
  });
});
