import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectArchHints } from "../engine/integrations/arch/augment.js";

describe("arch augment", () => {
  test("selects top overlapping hints", () => {
    const dir = mkdtempSync(join(tmpdir(), "kindx-arch-augment-"));
    const hintsPath = join(dir, "hints.json");
    writeFileSync(
      hintsPath,
      JSON.stringify([
        {
          id: "1",
          kind: "community",
          title: "Auth community",
          body: "authentication middleware and token validation",
          scoreSignals: ["auth", "middleware", "token"],
          sourceFiles: ["src/auth.ts"],
        },
        {
          id: "2",
          kind: "god_node",
          title: "Cache manager",
          body: "cache invalidation strategy",
          scoreSignals: ["cache", "invalidation"],
          sourceFiles: ["src/cache.ts"],
        },
      ]),
      "utf-8",
    );

    const selected = selectArchHints("how auth token validation works", hintsPath, 2);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0]?.title).toContain("Auth");
  });

  test("returns empty when hints file missing", () => {
    const selected = selectArchHints("auth", "/tmp/does-not-exist-hints.json", 3);
    expect(selected).toEqual([]);
  });

  test("handles malformed hints with missing scoreSignals, title, and body", () => {
    const dir = mkdtempSync(join(tmpdir(), "kindx-arch-augment-malformed-"));
    const hintsPath = join(dir, "hints.json");
    writeFileSync(
      hintsPath,
      JSON.stringify([
        {
          id: "1",
          kind: "community",
          // title, body, and scoreSignals intentionally missing
          sourceFiles: ["src/broken.ts"],
        },
        {
          id: "2",
          kind: "god_node",
          title: "Database layer",
          body: "handles database connections",
          // scoreSignals intentionally missing
          sourceFiles: ["src/db.ts"],
        },
      ]),
      "utf-8",
    );

    // Should not throw
    const selected = selectArchHints("database connections", hintsPath, 3);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0]?.title).toBe("Database layer");
  });

  test("returns empty for non-array JSON payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "kindx-arch-augment-obj-"));
    const hintsPath = join(dir, "hints.json");
    writeFileSync(hintsPath, JSON.stringify({ not: "an array" }), "utf-8");

    const selected = selectArchHints("anything", hintsPath, 3);
    expect(selected).toEqual([]);
  });

  test("returns empty for empty query string", () => {
    const dir = mkdtempSync(join(tmpdir(), "kindx-arch-augment-empty-"));
    const hintsPath = join(dir, "hints.json");
    writeFileSync(
      hintsPath,
      JSON.stringify([
        {
          id: "1",
          kind: "community",
          title: "Something",
          body: "detail",
          scoreSignals: ["test"],
          sourceFiles: [],
        },
      ]),
      "utf-8",
    );

    const selected = selectArchHints("", hintsPath, 3);
    expect(selected).toEqual([]);
  });
});
