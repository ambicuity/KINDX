import type {
  LLM,
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  RerankDocument,
  RerankOptions,
  RerankResult,
  ModelInfo,
  Queryable,
} from "./inference.js";

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  retryableErrors: [
    "cuda",
    "metal",
    "device lost",
    "out of memory",
    "insufficient",
    "allocation",
    "vram",
    "ggml",
    "gpu",
    "read",
    "file",
    "epipe",
    "EACCES",
    "ECONNRESET",
    "ENOENT",
    "EIO",
  ],
};

export class RetryableLLM implements LLM {
  private inner: LLM;
  private config: RetryConfig;

  constructor(inner: LLM, config?: Partial<RetryConfig>) {
    this.inner = inner;
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.withRetry(() => this.inner.embed(text, options));
  }

  async embedBatch(texts: string[], options?: { signal?: AbortSignal }): Promise<(EmbeddingResult | null)[]> {
    return this.withRetry(() => this.inner.embedBatch(texts, options));
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null> {
    return this.withRetry(() => this.inner.generate(prompt, options));
  }

  async modelExists(model: string): Promise<ModelInfo> {
    return this.withRetry(() => this.inner.modelExists(model));
  }

  async expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    return this.withRetry(() => this.inner.expandQuery(query, options));
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    return this.withRetry(() => this.inner.rerank(query, documents, options));
  }

  async tokenize?(text: string): Promise<readonly any[]> {
    return this.inner.tokenize!(text);
  }

  async detokenize?(tokens: readonly any[]): Promise<string> {
    return this.inner.detokenize!(tokens);
  }

  async getDeviceInfo?(): Promise<{
    gpu: string | false;
    gpuOffloading: boolean;
    gpuDevices: string[];
    vram?: { total: number; used: number; free: number };
    cpuCores: number;
  }> {
    return this.inner.getDeviceInfo!();
  }

  async dispose(): Promise<void> {
    return this.inner.dispose();
  }

  async disposeSensitiveContexts?(): Promise<void> {
    return this.inner.disposeSensitiveContexts!();
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryableError(lastError) || attempt >= this.config.maxRetries) {
          throw lastError;
        }

        const delay = this.calculateDelay(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return this.config.retryableErrors.some((pattern) => message.includes(pattern.toLowerCase()));
  }

  private calculateDelay(attempt: number): number {
    const baseDelay = this.config.baseDelayMs * Math.pow(2, attempt);
    const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
    return Math.min(baseDelay + jitter, this.config.maxDelayMs);
  }
}
