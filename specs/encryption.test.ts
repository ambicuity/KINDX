import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLikelyEncryptedSqlite, syncParentDirectoryAfterRename } from "../engine/encryption.js";

describe("encryption helpers", () => {
  test("detects plaintext sqlite header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-enc-"));
    try {
      const file = join(dir, "plain.sqlite");
      const header = Buffer.from("SQLite format 3\u0000", "ascii");
      await writeFile(file, Buffer.concat([header, Buffer.alloc(64)]));
      expect(isLikelyEncryptedSqlite(file)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("treats non-sqlite header as likely encrypted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-enc-"));
    try {
      const file = join(dir, "enc.sqlite");
      await writeFile(file, Buffer.from("not-a-sqlite-header", "utf-8"));
      expect(isLikelyEncryptedSqlite(file)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("syncParentDirectoryAfterRename executes open -> fsync -> close in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-enc-"));
    try {
      const targetDbFile = join(dir, "target.sqlite");
      await writeFile(targetDbFile, Buffer.from("SQLite format 3\u0000", "ascii"));
      const calls: string[] = [];

      syncParentDirectoryAfterRename(targetDbFile, {
        openSync: (path, flags) => {
          calls.push(`open:${path}:${flags}`);
          return 99;
        },
        fsyncSync: (fd) => {
          calls.push(`fsync:${fd}`);
        },
        closeSync: (fd) => {
          calls.push(`close:${fd}`);
        },
      });

      expect(calls).toEqual([`open:${dir}:r`, "fsync:99", "close:99"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("syncParentDirectoryAfterRename swallows fsync failures but still closes fd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-enc-"));
    try {
      const targetDbFile = join(dir, "target.sqlite");
      await writeFile(targetDbFile, Buffer.from("SQLite format 3\u0000", "ascii"));
      const calls: string[] = [];

      expect(() =>
        syncParentDirectoryAfterRename(targetDbFile, {
          openSync: () => 7,
          fsyncSync: () => {
            calls.push("fsync");
            throw new Error("unsupported");
          },
          closeSync: (fd) => {
            calls.push(`close:${fd}`);
          },
        })
      ).not.toThrow();

      expect(calls).toEqual(["fsync", "close:7"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
