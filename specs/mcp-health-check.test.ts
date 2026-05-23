import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = resolve(__dirname, "..", "engine", "kindx.ts");

describe("kindx mcp --health-check", () => {
  test("exits 0 with JSON ok payload when store opens cleanly", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kindx-hc-"));
    try {
      const out = execFileSync(
        "npx",
        ["tsx", cli, "mcp", "--health-check"],
        {
          encoding: "utf-8",
          env: { ...process.env, XDG_CACHE_HOME: tmpDir },
        },
      );
      const parsed = JSON.parse(out.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed).toHaveProperty("totalDocuments");
      expect(parsed).toHaveProperty("collections");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.todo("exits 1 when store path is unreadable (needs reliable failure-injection mechanism)");
});
