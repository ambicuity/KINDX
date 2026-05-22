import { describe, it, expect, vi } from "vitest";
import { RetryableLLM, type RetryConfig } from "../engine/retryable-llm.js";
import type { LLM, EmbeddingResult, EmbedOptions } from "../engine/inference.js";

function createMockLLM() {
  return {
    embed: vi.fn() as any,
    embedBatch: vi.fn() as any,
    generate: vi.fn() as any,
    modelExists: vi.fn() as any,
    expandQuery: vi.fn() as any,
    rerank: vi.fn() as any,
    dispose: vi.fn() as any,
  } satisfies LLM;
}

describe("RetryableLLM", () => {
  it("should return result on first success", async () => {
    const mock = createMockLLM();
    const expectedResult: EmbeddingResult = { embedding: [0.1, 0.2], model: "test" };
    mock.embed.mockResolvedValue(expectedResult);

    const retryable = new RetryableLLM(mock);
    const result = await retryable.embed("test");

    expect(result).toBe(expectedResult);
    expect(mock.embed).toHaveBeenCalledTimes(1);
  });

  it("should retry on retryable error", async () => {
    const mock = createMockLLM();
    const expectedResult: EmbeddingResult = { embedding: [0.1, 0.2], model: "test" };
    mock.embed
      .mockRejectedValueOnce(new Error("CUDA device lost"))
      .mockResolvedValue(expectedResult);

    const retryable = new RetryableLLM(mock, { maxRetries: 3, baseDelayMs: 10 });
    const result = await retryable.embed("test");

    expect(result).toBe(expectedResult);
    expect(mock.embed).toHaveBeenCalledTimes(2);
  });

  it("should fail after max retries", async () => {
    const mock = createMockLLM();
    mock.embed.mockRejectedValue(new Error("CUDA device lost"));

    const retryable = new RetryableLLM(mock, { maxRetries: 2, baseDelayMs: 10 });

    await expect(retryable.embed("test")).rejects.toThrow("CUDA device lost");
    expect(mock.embed).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("should not retry non-retryable errors", async () => {
    const mock = createMockLLM();
    mock.embed.mockRejectedValue(new Error("Invalid input"));

    const retryable = new RetryableLLM(mock, { maxRetries: 3, baseDelayMs: 10 });

    await expect(retryable.embed("test")).rejects.toThrow("Invalid input");
    expect(mock.embed).toHaveBeenCalledTimes(1);
  });

  it("should delegate dispose to inner LLM", async () => {
    const mock = createMockLLM();
    const retryable = new RetryableLLM(mock);

    await retryable.dispose();
    expect(mock.dispose).toHaveBeenCalledTimes(1);
  });
});
