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
      const out = await ingestFile(path);
      expect(out.metadata.extractor).toBe("native_utf8");
      expect(out.text).toContain("ok = true");
      expect(out.warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ingests CSV with schema-aware chunking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "sample.csv");
      const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA\nCharlie,35,Chicago\n";
      await writeFile(path, csv);
      const out = await ingestFile(path);
      expect(out.metadata.format).toBe("csv");
      expect(out.metadata.extractor).toBe("csv_parser");
      expect(out.text).toContain("Schema: name: string, age: string, city: string");
      expect(out.text).toContain("Alice, 30, NYC");
      expect(out.warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles empty CSV gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "empty.csv");
      await writeFile(path, "");
      const out = await ingestFile(path);
      expect(out.metadata.format).toBe("csv");
      expect(out.text).toBe("");
      expect(out.warnings).toContain("extractor_failed:csv_empty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ingests JSON array of objects with schema-aware chunking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "sample.json");
      const json = JSON.stringify([
        { name: "Alice", age: 30, city: "NYC" },
        { name: "Bob", age: 25, city: "LA" },
      ]);
      await writeFile(path, json);
      const out = await ingestFile(path);
      expect(out.metadata.format).toBe("json");
      expect(out.metadata.extractor).toBe("json_parser");
      expect(out.text).toContain("Schema: name: string, age: number, city: string");
      expect(out.text).toContain("Items 1-2:");
      expect(out.warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ingests JSON single object by flattening to array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "single.json");
      const json = JSON.stringify({ key: "value", count: 42 });
      await writeFile(path, json);
      const out = await ingestFile(path);
      expect(out.metadata.format).toBe("json");
      expect(out.metadata.extractor).toBe("json_parser");
      expect(out.text).toContain("Schema: key: string, count: number");
      expect(out.text).toContain("Items 1-1:");
      expect(out.warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ingests JSON object with array value by extracting array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "nested.json");
      const json = JSON.stringify({
        users: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      });
      await writeFile(path, json);
      const out = await ingestFile(path);
      expect(out.metadata.format).toBe("json");
      expect(out.metadata.extractor).toBe("json_parser");
      expect(out.text).toContain("Schema: id: number, name: string");
      expect(out.warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles invalid JSON gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "bad.json");
      await writeFile(path, "{invalid json");
      const out = await ingestFile(path);
      expect(out.metadata.format).toBe("json");
      expect(out.metadata.extractor).toBe("json_parser_error");
      expect(out.text).toBe("");
      expect(out.warnings.length).toBe(1);
      expect(out.warnings[0]).toMatch(/^extractor_failed:json_error:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks unsupported extensions with deterministic warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-ingest-"));
    try {
      const path = join(dir, "blob.bin");
      await writeFile(path, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      const out = await ingestFile(path);
      expect(out.text).toBe("");
      expect(out.metadata.extractor).toBe("unsupported");
      expect(out.warnings.some((w) => w.startsWith("extractor_unsupported_extension:"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
