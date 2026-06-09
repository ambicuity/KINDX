import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyModelIntegrity, writeModelChecksum, ModelIntegrityError } from "../engine/model-integrity.js";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

describe("ModelIntegrity", () => {
  const testDir = join(tmpdir(), "kindx-integrity-test");
  const modelPath = join(testDir, "test-model.gguf");
  const checksumPath = join(testDir, "test-model.gguf.sha256");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(modelPath, "test model content");
  });

  afterEach(() => {
    if (existsSync(modelPath)) unlinkSync(modelPath);
    if (existsSync(checksumPath)) unlinkSync(checksumPath);
  });

  it("should verify valid checksum", async () => {
    const hash = createHash("sha256").update("test model content").digest("hex");
    writeFileSync(checksumPath, hash + "\n");

    const result = await verifyModelIntegrity(modelPath);
    expect(result).toBe(true);
  });

  it("should throw ModelIntegrityError on mismatch", async () => {
    writeFileSync(checksumPath, "invalidhash\n");

    await expect(verifyModelIntegrity(modelPath)).rejects.toThrow(ModelIntegrityError);
  });

  it("should return true when no checksum file exists", async () => {
    const result = await verifyModelIntegrity(modelPath);
    expect(result).toBe(true);
  });

  it("should write checksum file", async () => {
    await writeModelChecksum(modelPath);

    expect(existsSync(checksumPath)).toBe(true);
    const hash = createHash("sha256").update("test model content").digest("hex");
    expect(readFileSync(checksumPath, "utf-8").trim()).toBe(hash);
  });

  it("streams hash correctly for a file larger than the read-stream chunk size", async () => {
    // computeFileHash() uses createReadStream + hash.update per chunk; the default
    // highWaterMark is 64 KB. Pick a payload larger than any reasonable chunk
    // boundary so the streaming path is exercised end-to-end.
    const payload = Buffer.alloc(2 * 1024 * 1024); // 2 MB
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i & 0xff; // deterministic non-uniform content
    }
    writeFileSync(modelPath, payload);

    const expected = createHash("sha256").update(payload).digest("hex");
    writeFileSync(checksumPath, expected + "\n");

    await expect(verifyModelIntegrity(modelPath)).resolves.toBe(true);

    // And the reverse path: writeModelChecksum should produce the same digest.
    unlinkSync(checksumPath);
    await writeModelChecksum(modelPath);
    expect(readFileSync(checksumPath, "utf-8").trim()).toBe(expected);
  });
});
