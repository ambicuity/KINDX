/**
 * repository-barrel.test.ts — W1 decomposition public-surface lock.
 *
 * Loads the public symbol baseline captured before the decomposition began and
 * asserts every name in it is still resolvable on engine/repository.js — the
 * file consumers import from. The barrel re-exports the new ./repository/
 * cluster modules, so any accidental drop becomes a test failure rather than
 * a downstream runtime error.
 *
 * Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as repository from "../engine/repository.js";

const BASELINE_PATH = fileURLToPath(
  new URL("../tooling/artifacts/baseline-repository-functions.txt", import.meta.url)
);

describe("repository public surface", () => {
  test("every baselined export resolves on the barrel", () => {
    const baseline = readFileSync(BASELINE_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(baseline.length).toBeGreaterThan(0);

    const surface = repository as unknown as Record<string, unknown>;
    const missing = baseline.filter((name) => surface[name] === undefined);
    expect(missing, `missing exports on engine/repository.js: ${missing.join(", ")}`).toEqual([]);
  });
});
