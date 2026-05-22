import type { LLM } from "./inference.js";

export interface PreloaderDependencies {
  getLLM: () => LLM;
  models: string[];
}

export interface PreloadResult {
  loaded: number;
  failed: number;
  models: string[];
  errors: Array<{ model: string; error: string }>;
  durationMs: number;
}

export class ModelPreloader {
  private deps: PreloaderDependencies;

  constructor(deps: PreloaderDependencies) {
    this.deps = deps;
  }

  async preload(): Promise<PreloadResult> {
    const startTime = Date.now();
    const llm = this.deps.getLLM();
    const loaded: string[] = [];
    const errors: Array<{ model: string; error: string }> = [];

    for (const model of this.deps.models) {
      try {
        switch (model) {
          case "embed":
            await llm.embed("preload");
            break;
          case "generate":
            await llm.generate("preload", { maxTokens: 1 });
            break;
          case "rerank":
            await llm.rerank("preload", [{ file: "test", text: "test" }]);
            break;
        }
        loaded.push(model);
      } catch (error) {
        errors.push({
          model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      loaded: loaded.length,
      failed: errors.length,
      models: loaded,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}
