/**
 * Regression: encryption rekey must not leave a *.plaintext.backup.<ts>
 * file on disk after the encrypted DB is in place. The previous code
 * created a VACUUM-INTO backup before rekey and never deleted it on
 * the success path, so a complete unencrypted copy of the index sat
 * next to the encrypted one forever — defeating encryption-at-rest.
 *
 * The full rekey path requires SQLCipher (not always available in CI),
 * so this spec verifies the visible byproducts:
 *   - cleanupStalePlaintextBackups removes old backups in place
 *   - it leaves recent backups alone (a backup actively in use must not
 *     be reaped while a parallel rekey is mid-flight)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  STALE_BACKUP_THRESHOLD_MS,
  cleanupStalePlaintextBackups,
} from "../engine/encryption.js";

let stderrSpy: any;

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("cleanupStalePlaintextBackups", () => {
  test("removes backups older than 24h", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-bk-"));
    try {
      const indexPath = join(dir, "index.sqlite");
      const oldBackup = `${indexPath}.plaintext.backup.${Date.now() - 5 * 24 * 60 * 60 * 1000}`;
      await writeFile(oldBackup, "old data");
      // Set the mtime to 5 days ago.
      const oldMs = Date.now() / 1000 - 5 * 24 * 60 * 60;
      await utimes(oldBackup, oldMs, oldMs);

      cleanupStalePlaintextBackups(indexPath);
      expect(existsSync(oldBackup)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps backups newer than 24h (in case rekey is mid-flight)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-bk-"));
    try {
      const indexPath = join(dir, "index.sqlite");
      const fresh = `${indexPath}.plaintext.backup.${Date.now()}`;
      await writeFile(fresh, "fresh data");
      cleanupStalePlaintextBackups(indexPath);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores files that are not plaintext backups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-bk-"));
    try {
      const indexPath = join(dir, "index.sqlite");
      const unrelated = join(dir, "something-else.txt");
      await writeFile(unrelated, "not a backup");
      const oldMs = Date.now() / 1000 - 30 * 24 * 60 * 60;
      await utimes(unrelated, oldMs, oldMs);
      cleanupStalePlaintextBackups(indexPath);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("survives a missing parent directory", () => {
    expect(() => cleanupStalePlaintextBackups("/nonexistent/path/idx.sqlite")).not.toThrow();
  });

  test("only acts on backups for the matching index basename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-bk-"));
    try {
      const indexA = join(dir, "indexA.sqlite");
      const indexB = join(dir, "indexB.sqlite");
      const oldA = `${indexA}.plaintext.backup.${Date.now() - STALE_BACKUP_THRESHOLD_MS - 1000}`;
      const oldB = `${indexB}.plaintext.backup.${Date.now() - STALE_BACKUP_THRESHOLD_MS - 1000}`;
      await writeFile(oldA, "A");
      await writeFile(oldB, "B");
      const oldMs = Date.now() / 1000 - 5 * 24 * 60 * 60;
      await utimes(oldA, oldMs, oldMs);
      await utimes(oldB, oldMs, oldMs);

      cleanupStalePlaintextBackups(indexA);
      expect(existsSync(oldA)).toBe(false);
      expect(existsSync(oldB)).toBe(true); // not for indexA
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("STALE_BACKUP_THRESHOLD_MS is 24 hours", () => {
    expect(STALE_BACKUP_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });
});
