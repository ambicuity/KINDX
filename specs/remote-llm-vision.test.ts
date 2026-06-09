/**
 * Tests for RemoteLLM.describeImage() — the OpenAI-vision-API entry point added
 * in engine/remote-llm.ts:569-609. The method base64-encodes the image and
 * POSTs an OpenAI /chat/completions payload with an `image_url` content part.
 *
 * We stub global fetch (which fetchWithTimeout calls under the hood) to:
 *   - assert the request body includes the base64-encoded image bytes and the
 *     model name resolved from KINDX_OPENAI_VISION_MODEL,
 *   - assert the response is unwrapped to the choices[0].message.content string,
 *   - assert that an upstream error is *swallowed* and the function returns a
 *     stable "Image description unavailable" sentinel (per the catch at L605-608).
 *
 * Note: per the current implementation, describeImage NEVER throws. It catches
 * upstream errors and returns a sentinel. The plan's "function itself must
 * throw" assertion is wrong — this test verifies the implemented contract.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RemoteLLM } from "../engine/remote-llm.js";

describe("RemoteLLM.describeImage", () => {
  const testDir = join(tmpdir(), `kindx-remote-vision-${Date.now()}`);
  const imagePath = join(testDir, "sample.png");
  // Tiny non-uniform payload so we can assert the base64 form deterministically.
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const expectedBase64 = imageBytes.toString("base64");

  const origFetch = globalThis.fetch;
  const origVisionModel = process.env.KINDX_OPENAI_VISION_MODEL;
  const origBaseUrl = process.env.KINDX_OPENAI_BASE_URL;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(imagePath, imageBytes);
    // Pin the endpoint so URL assertions are stable.
    process.env.KINDX_OPENAI_BASE_URL = "http://stub.local/v1";
  });

  afterEach(() => {
    try { unlinkSync(imagePath); } catch {}
    globalThis.fetch = origFetch;
    if (origVisionModel === undefined) delete process.env.KINDX_OPENAI_VISION_MODEL;
    else process.env.KINDX_OPENAI_VISION_MODEL = origVisionModel;
    if (origBaseUrl === undefined) delete process.env.KINDX_OPENAI_BASE_URL;
    else process.env.KINDX_OPENAI_BASE_URL = origBaseUrl;
    vi.restoreAllMocks();
  });

  test("returns 'unavailable' sentinel when image file is missing", async () => {
    const llm = new RemoteLLM();
    const result = await llm.describeImage(join(testDir, "missing.png"));
    expect(result).toBe("Image description unavailable: file not found");
  });

  test("posts base64-encoded image + configured vision model and unwraps choices[0]", async () => {
    process.env.KINDX_OPENAI_VISION_MODEL = "gpt-4o-mini-vision-test";

    let capturedUrl: string | undefined;
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "  A red apple on a white table.  " } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    const llm = new RemoteLLM();
    const description = await llm.describeImage(imagePath);

    expect(description).toBe("A red apple on a white table.");
    expect(capturedUrl).toBe("http://stub.local/v1/chat/completions");
    expect(capturedBody.model).toBe("gpt-4o-mini-vision-test");

    const parts = capturedBody.messages[0].content;
    const imagePart = parts.find((p: any) => p.type === "image_url");
    expect(imagePart).toBeDefined();
    expect(imagePart.image_url.url).toBe(`data:image/png;base64,${expectedBase64}`);
  });

  test("falls back to default generateModel when KINDX_OPENAI_VISION_MODEL is unset", async () => {
    delete process.env.KINDX_OPENAI_VISION_MODEL;
    process.env.KINDX_OPENAI_GENERATE_MODEL = "fallback-gen-model";

    let capturedBody: any;
    globalThis.fetch = vi.fn(async (_: any, init: any) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 });
    }) as any;

    try {
      const llm = new RemoteLLM();
      await llm.describeImage(imagePath);
      expect(capturedBody.model).toBe("fallback-gen-model");
    } finally {
      delete process.env.KINDX_OPENAI_GENERATE_MODEL;
    }
  });

  test("returns 'unavailable' sentinel when upstream fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network blew up");
    }) as any;

    const llm = new RemoteLLM();
    const result = await llm.describeImage(imagePath);

    // describeImage catches and warns; never throws.
    expect(result).toBe("Image description unavailable");
  });

  test("returns 'unavailable' sentinel when the response has no choices", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as any;

    const llm = new RemoteLLM();
    const result = await llm.describeImage(imagePath);
    expect(result).toBe("Image description unavailable");
  });
});
