/**
 * Regression: PR2-E security fixes.
 *
 *  - link-extractor: paths with `..` segments must not poison the link
 *    graph with out-of-collection targets (e.g. `../../../etc/passwd`).
 *  - encryption.isLikelyEncryptedSqlite: must read only the first 16
 *    bytes via open+read, not slurp the whole file.
 */

import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInternalLinks } from "../engine/link-extractor.js";
import { isLikelyEncryptedSqlite } from "../engine/encryption.js";

describe("link-extractor path traversal guard", () => {
  test("drops out-of-collection link targets via ..", () => {
    const md = "[evil](../../../etc/passwd) and [ok](sibling.md)";
    const targets = extractInternalLinks(md, "docs/guide.md");
    // sibling.md is under docs/, ../../../etc/passwd escapes -> dropped.
    expect(targets).toContain("docs/sibling.md");
    expect(targets.find(t => t.includes("etc/passwd"))).toBeUndefined();
  });

  test("drops absolute filesystem-style escapes", () => {
    // After leading-slash stripping our resolver makes it relative; ensure
    // a path that would normalize to absolute or `..`-escape is dropped.
    const md = "[evil](//evil-host/x) [ok](./sibling.md)";
    const targets = extractInternalLinks(md, "docs/guide.md");
    expect(targets).toContain("docs/sibling.md");
    expect(targets.find(t => t.includes("evil-host"))).toBeUndefined();
  });

  test("normalizes intermediate .. that stays inside the collection", () => {
    const md = "[ok](../shared/api.md)";
    const targets = extractInternalLinks(md, "docs/guide.md");
    // docs/guide.md is in docs/, so ../shared/api.md resolves to shared/api.md (still in repo).
    expect(targets).toContain("shared/api.md");
  });
});

describe("isLikelyEncryptedSqlite reads bounded bytes", () => {
  test("returns false for plaintext sqlite header without loading the whole file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-enc-bytes-"));
    try {
      const file = join(dir, "plain.sqlite");
      // Write a 5 MiB file with a valid sqlite header at the start. The
      // helper must NOT have to allocate 5 MiB to inspect the header.
      const header = Buffer.concat([Buffer.from("SQLite format 3", "ascii"), Buffer.from([0])])
      const filler = Buffer.alloc(5 * 1024 * 1024);
      await writeFile(file, Buffer.concat([header, filler]));
      // Just call it — if this OOMs/blocks abnormally the test will fail.
      const start = Date.now();
      const result = isLikelyEncryptedSqlite(file);
      const elapsed = Date.now() - start;
      expect(result).toBe(false);
      // Should be fast — bounded by a single 16-byte read, not a 5 MiB read.
      expect(elapsed).toBeLessThan(500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns true for a non-sqlite header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-enc-bytes-"));
    try {
      const file = join(dir, "enc.sqlite");
      await writeFile(file, Buffer.from("ENCRYPTED-LIKELY-OPAQUE-BYTES__", "ascii"));
      expect(isLikelyEncryptedSqlite(file)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns true for files smaller than 16 bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-enc-bytes-"));
    try {
      const file = join(dir, "tiny");
      await writeFile(file, Buffer.from("short", "ascii"));
      expect(isLikelyEncryptedSqlite(file)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
