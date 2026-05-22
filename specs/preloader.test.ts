import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelPreloader, type PreloadResult } from "../engine/preloader.js";
import type { LLM } from "../engine/inference.js";

function createMockLLM(overrides: Partial<LLM> = {}): LLM {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1], model: "test" }),
    embedBatch: vi.fn().mockResolvedValue([]),
    generate: vi.fn().mockResolvedValue({ text: "test", model: "test", done: true }),
    modelExists: vi.fn().mockResolvedValue({ name: "test", exists: true }),
    expandQuery: vi.fn().mockResolvedValue([]),
    rerank: vi.fn().mockResolvedValue({ results: [], model: "test" }),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ModelPreloader", () => {
  it("should preload all models", async () => {
    const mockLLM = createMockLLM();

    const preloader = new ModelPreloader({
      getLLM: () => mockLLM,
      models: ["embed", "rerank", "generate"],
    });

    const result = await preloader.preload();

    expect(result.loaded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.models).toEqual(["embed", "rerank", "generate"]);
  });

  it("should report failed models", async () => {
    const mockLLM = createMockLLM({
      embed: vi.fn().mockRejectedValue(new Error("GPU error")),
    });

    const preloader = new ModelPreloader({
      getLLM: () => mockLLM,
      models: ["embed", "rerank", "generate"],
    });

    const result = await preloader.preload();

    expect(result.loaded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});
