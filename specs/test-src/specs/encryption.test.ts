import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLikelyEncryptedSqlite } from "../engine/encryption.js";

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
});
