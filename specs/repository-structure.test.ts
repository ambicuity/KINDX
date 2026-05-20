/**
 * repository-structure.test.ts — W1 decomposition structural guardrails.
 *
 * Ensures that engine/repository/ stays decomposed: no single file in the
 * directory grows past the agreed-upon ceiling, and the average size stays
 * within the design target. If a file legitimately needs to exceed the cap,
 * bump the constant and document why in the commit message.
 *
 * Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5
 */

import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_DIR = new URL("../engine/repository/", import.meta.url).pathname;
const MAX_LINES_PER_FILE = 800;
const MAX_AVERAGE_LINES = 750;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("repository decomposition structure", () => {
  test("no file exceeds the per-file line cap", () => {
    const offenders: Array<{ file: string; lines: number }> = [];
    for (const file of walk(REPO_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines > MAX_LINES_PER_FILE) {
        offenders.push({ file: file.replace(REPO_DIR, ""), lines });
      }
    }
    expect(offenders, `files over ${MAX_LINES_PER_FILE} lines: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  test("average file size stays within the design target", () => {
    const files = [...walk(REPO_DIR)];
    expect(files.length).toBeGreaterThan(0);
    const totalLines = files.reduce(
      (sum, file) => sum + readFileSync(file, "utf8").split("\n").length,
      0
    );
    const average = totalLines / files.length;
    expect(
      average,
      `average ${average.toFixed(0)} loc across ${files.length} files exceeds ${MAX_AVERAGE_LINES}`
    ).toBeLessThanOrEqual(MAX_AVERAGE_LINES);
  });
});
