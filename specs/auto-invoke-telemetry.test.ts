import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { openDatabase, loadSqliteVec } from "../engine/runtime.js";
import { initTestDatabase, seedCollection } from "./helpers/db-helpers.js";

const cli = resolve(__dirname, "..", "engine", "kindx.ts");

describe("auto-invoke telemetry", () => {
  let configDir: string;
  let dbPath: string;
  let indexName: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "kindx-tel-"));
    indexName = `idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbPath = join(configDir, `${indexName}.db`);
    const docsDir = join(configDir, "notes");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "a.md"), "# A\nhello\n");
    writeFileSync(join(configDir, `${indexName}.yml`), YAML.stringify({
      collections: { notes: { path: docsDir, pattern: "**/*.md" } },
    }));
    const db = openDatabase(dbPath);
    loadSqliteVec(db);
    initTestDatabase(db);
    seedCollection(db, "notes", [{ path: "a.md", title: "A", body: "hello" }]);
    db.close();
  });
  afterEach(() => {
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
  });

  test("'kindx status --auto-invoke-rate' prints summary even with no calls recorded", () => {
    const out = execFileSync(
      "npx",
      ["tsx", cli, "status", "--auto-invoke-rate", "--format", "json"],
      { encoding: "utf-8", env: { ...process.env, KINDX_CONFIG_DIR: configDir } },
    );
    const parsed = JSON.parse(out.trim());
    const data = parsed.data ?? parsed;
    expect(data).toHaveProperty("autoInvocation");
    expect(data.autoInvocation).toHaveProperty("totalCalls");
    expect(data.autoInvocation).toHaveProperty("agentAuto");
    expect(data.autoInvocation).toHaveProperty("userExplicit");
  });

  test("capability manifest exposes autoInvocation.contractEmitted", async () => {
    const { buildCapabilityManifest } = await import("../engine/capability-manifest.js");
    const { createStore } = await import("../engine/repository.js");
    process.env.KINDX_CONFIG_DIR = configDir;
    const { setConfigIndexName } = await import("../engine/catalogs.js");
    setConfigIndexName(indexName);
    const store = createStore(dbPath, indexName);
    const m = buildCapabilityManifest(store, []);
    expect(m).toHaveProperty("autoInvocation");
    expect(typeof (m as any).autoInvocation.contractEmitted).toBe("boolean");
  });
});
