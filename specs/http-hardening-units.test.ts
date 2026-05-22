import { describe, expect, test } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { collectBody, BodyTooLargeError } from "../engine/http/body.js";

function makeReq(body: Buffer | string): IncomingMessage {
  const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  // Readable.from over a single chunk; IncomingMessage extends Readable so the
  // duck-typed shape is enough for collectBody.
  return Readable.from([buf]) as unknown as IncomingMessage;
}

describe("collectBody", () => {
  test("returns body smaller than cap", async () => {
    const out = await collectBody(makeReq("hello"), 1024);
    expect(out).toBe("hello");
  });

  test("accepts body exactly at cap", async () => {
    const body = "x".repeat(1024);
    const out = await collectBody(makeReq(body), 1024);
    expect(out).toBe(body);
  });

  test("rejects body cap + 1", async () => {
    const body = "x".repeat(1025);
    await expect(collectBody(makeReq(body), 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  test("rejects body well over cap and exposes limit", async () => {
    const body = "x".repeat(2048);
    try {
      await collectBody(makeReq(body), 1024);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError);
      expect((err as BodyTooLargeError).limitBytes).toBe(1024);
    }
  });

  test("preserves UTF-8 multi-byte content under cap", async () => {
    const body = "ümlaut – ✓ — 🌱";
    const bytes = Buffer.byteLength(body, "utf-8");
    const out = await collectBody(makeReq(body), bytes);
    expect(out).toBe(body);
  });
});
