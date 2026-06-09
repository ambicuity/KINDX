import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLikelyEncryptedSqlite, isRuntimeEncryptionEnabled, syncParentDirectoryAfterRename } from "../engine/encryption.js";

describe("encryption helpers", () => {
  describe("isLikelyEncryptedSqlite", () => {
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

    test("returns false for non-existent file", () => {
      expect(isLikelyEncryptedSqlite("/nonexistent/file.sqlite")).toBe(false);
    });
  });

  describe("isRuntimeEncryptionEnabled", () => {
    test("returns false when KINDX_ENCRYPTION_KEY is not set", () => {
      const original = process.env.KINDX_ENCRYPTION_KEY;
      delete process.env.KINDX_ENCRYPTION_KEY;

      expect(isRuntimeEncryptionEnabled()).toBe(false);

      if (original !== undefined) {
        process.env.KINDX_ENCRYPTION_KEY = original;
      }
    });

    test("returns true when KINDX_ENCRYPTION_KEY is set", () => {
      const original = process.env.KINDX_ENCRYPTION_KEY;
      process.env.KINDX_ENCRYPTION_KEY = "test-key-16chars-long";

      expect(isRuntimeEncryptionEnabled()).toBe(true);

      if (original !== undefined) {
        process.env.KINDX_ENCRYPTION_KEY = original;
      } else {
        delete process.env.KINDX_ENCRYPTION_KEY;
      }
    });

    test("returns false for empty key", () => {
      const original = process.env.KINDX_ENCRYPTION_KEY;
      process.env.KINDX_ENCRYPTION_KEY = "   ";

      expect(isRuntimeEncryptionEnabled()).toBe(false);

      if (original !== undefined) {
        process.env.KINDX_ENCRYPTION_KEY = original;
      } else {
        delete process.env.KINDX_ENCRYPTION_KEY;
      }
    });
  });

  describe("syncParentDirectoryAfterRename", () => {
    test("executes open -> fsync -> close in order", async () => {
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

    test("swallows fsync failures but still closes fd", async () => {
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
});
