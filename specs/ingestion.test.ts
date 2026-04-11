import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFile } from "../engine/ingestion.js";

describe("ingestion adapter", () => {
  test("ingests UTF-8 text/code natively", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "sample.ts");
      await writeFile(path, "export const ok = true;\n");
      const out = ingestFile(path);
      expect(out.metadata.extractor).toBe("native_utf8");
      expect(out.text).toContain("ok = true");
      expect(out.warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks unsupported extensions with deterministic warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "blob.bin");
      await writeFile(path, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      const out = ingestFile(path);
      expect(out.text).toBe("");
      expect(out.metadata.extractor).toBe("unsupported");
      expect(out.warnings.some((w) => w.startsWith("extractor_unsupported_extension:"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
