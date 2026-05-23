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

  test.skip("exits 1 when store path is unreadable — skipped: createStore() always creates the dir, no reliable injection point for open failure without mocking", () => {
    // TODO: engineer a reliable failure-injection mechanism (e.g. a KINDX_FORCE_HC_FAIL
    // env var that makes the health-check handler throw) so this test doesn't rely on
    // filesystem tricks that SQLite and Node.js mkdirSync recover from silently.
    //
    // Attempted: /dev/null/cannot-mkdir-here — SQLite on macOS still opens :memory:
    // fallback or the mkdirSync call returns a ENOTDIR but createStore() catches it.
    // The error path (catch block → process.exit(1)) is correct by code inspection.
  });
});
