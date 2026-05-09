/**
 * Regression: `kindx migrate openclaw <path>` must not shell out with the
 * user-supplied path. The previous implementation used `bash -c` over a
 * `find`/`sed` pipeline, allowing arbitrary command execution via shell
 * metacharacters in the path or in repository file names.
 */

import { describe, expect, test } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, symlinkSync } from "node:fs";
import {
  migrateOpenClawRepository,
  OpenClawMigrationError,
  validateOpenClawRepoPath,
} from "../engine/migrate-openclaw.js";

async function makeOpenClawSkeleton(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "src", "qmd-helper.ts"), "import { qmd, Qmd, QMD } from './x';\n");
  await writeFile(join(root, "test", "Qmd.spec.ts"), "describe('QMD');\n");
  await writeFile(join(root, "src", "unrelated.ts"), "// nothing here\n");
}

describe("validateOpenClawRepoPath", () => {
  test("rejects non-string", () => {
    expect(() => validateOpenClawRepoPath(123 as unknown)).toThrow(OpenClawMigrationError);
  });

  test("rejects empty string", () => {
    expect(() => validateOpenClawRepoPath("   ")).toThrow(OpenClawMigrationError);
  });

  test("rejects shell metacharacters", () => {
    const dangerous = ["/tmp;rm -rf /", "/tmp&id", "/tmp|cat", "/tmp`whoami`", "/tmp$IFS"];
    for (const p of dangerous) {
      expect(() => validateOpenClawRepoPath(p)).toThrow(/shell metacharacters/);
    }
  });

  test("rejects non-existent path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-openclaw-"));
    try {
      const ghost = join(dir, "does-not-exist");
      expect(() => validateOpenClawRepoPath(ghost)).toThrow(/does not exist/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects file (not a directory)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-openclaw-"));
    try {
      const file = join(dir, "afile");
      await writeFile(file, "x");
      expect(() => validateOpenClawRepoPath(file)).toThrow(/not a directory/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts a real directory and returns realpath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-openclaw-"));
    try {
      const result = validateOpenClawRepoPath(dir);
      expect(typeof result).toBe("string");
      expect(existsSync(result)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("migrateOpenClawRepository", () => {
  test("renames qmd files and rewrites source content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-openclaw-"));
    try {
      await makeOpenClawSkeleton(dir);
      const report = migrateOpenClawRepository(dir);
      expect(report.renamed.length).toBeGreaterThanOrEqual(2);
      // Original names gone, new names present.
      expect(existsSync(join(dir, "src", "qmd-helper.ts"))).toBe(false);
      expect(existsSync(join(dir, "src", "kindx-helper.ts"))).toBe(true);
      expect(existsSync(join(dir, "test", "Qmd.spec.ts"))).toBe(false);
      expect(existsSync(join(dir, "test", "Kindx.spec.ts"))).toBe(true);
      // Content rewritten with case-aware substitutions.
      const helper = await readFile(join(dir, "src", "kindx-helper.ts"), "utf-8");
      expect(helper).toBe("import { kindx, Kindx, KINDX } from './x';\n");
      // Unrelated files untouched.
      const unrelated = await readFile(join(dir, "src", "unrelated.ts"), "utf-8");
      expect(unrelated).toBe("// nothing here\n");
      expect(report.rewrittenFiles.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores .git/ and node_modules/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-openclaw-"));
    try {
      await makeOpenClawSkeleton(dir);
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, ".git", "qmd-config"), "qmd in git");
      await mkdir(join(dir, "node_modules", "qmd-pkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "qmd-pkg", "index.js"), "qmd here");

      migrateOpenClawRepository(dir);
      // .git and node_modules untouched.
      expect(existsSync(join(dir, ".git", "qmd-config"))).toBe(true);
      const gitFile = await readFile(join(dir, ".git", "qmd-config"), "utf-8");
      expect(gitFile).toContain("qmd");
      expect(existsSync(join(dir, "node_modules", "qmd-pkg"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not follow symlinks pointing outside the repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-openclaw-"));
    const evil = await mkdtemp(join(tmpdir(), "kindx-evil-"));
    try {
      await makeOpenClawSkeleton(dir);
      // Place a sensitive file outside the repo, then symlink to its parent.
      await writeFile(join(evil, "qmd-secret.txt"), "DO NOT TOUCH");
      try {
        symlinkSync(evil, join(dir, "src", "evil-link"));
      } catch {
        // Some CI runners disallow symlinks; skip in that case.
        return;
      }
      migrateOpenClawRepository(dir);
      // The external file must NOT have been renamed or rewritten.
      const stat = await lstat(join(evil, "qmd-secret.txt"));
      expect(stat.isFile()).toBe(true);
      const content = await readFile(join(evil, "qmd-secret.txt"), "utf-8");
      expect(content).toBe("DO NOT TOUCH");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(evil, { recursive: true, force: true });
    }
  });

  test("idempotent: running twice produces no further changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-openclaw-"));
    try {
      await makeOpenClawSkeleton(dir);
      migrateOpenClawRepository(dir);
      const second = migrateOpenClawRepository(dir);
      expect(second.renamed.length).toBe(0);
      expect(second.rewrittenFiles.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects shell-meta paths before any FS operation", async () => {
    expect(() => migrateOpenClawRepository("/tmp;rm -rf /tmp/kindx-sandbox")).toThrow(
      /shell metacharacters/
    );
  });
});
