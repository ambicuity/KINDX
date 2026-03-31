import { LlamaCpp, disposeDefaultLLM, getDefaultLLM } from "./inference.js";

export type ModelWarmState = "idle" | "loading" | "loaded" | "error" | "unsupported";

export type PreloadStatus = {
  warmed: boolean;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  models: {
    embed: ModelWarmState;
    rerank: ModelWarmState;
    expand: ModelWarmState;
  };
};

const DEFAULT_STATUS: PreloadStatus = {
  warmed: false,
  startedAt: null,
  completedAt: null,
  lastError: null,
  models: {
    embed: "idle",
    rerank: "idle",
    expand: "idle",
  },
};

let preloadStatus: PreloadStatus = { ...DEFAULT_STATUS, models: { ...DEFAULT_STATUS.models } };
let preloadPromise: Promise<PreloadStatus> | null = null;

function setModelState(state: ModelWarmState): void {
  preloadStatus = {
    ...preloadStatus,
    models: {
      embed: state,
      rerank: state,
      expand: state,
    },
  };
}

function contextPoolSizeFromEnv(): number {
  const raw = process.env.KINDX_CONTEXT_POOL_SIZE?.trim();
  if (!raw) return 2;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  process.stderr.write(`KINDX Warning: invalid KINDX_CONTEXT_POOL_SIZE="${raw}", using 2.\n`);
  return 2;
}

async function installVitestCleanupHook(): Promise<void> {
  const isLikelyTestRuntime = !!(process.env.VITEST || process.env.BUN_TEST || process.env.NODE_ENV === "test");
  if (!isLikelyTestRuntime) return;
  try {
    const { afterAll } = await import("vitest");
    afterAll(async () => {
      await disposeDefaultLLM();
    });
  } catch {
    // Ignore in non-vitest runtimes.
  }
}

void installVitestCleanupHook();

export function getPreloadStatus(): PreloadStatus {
  return {
    ...preloadStatus,
    models: { ...preloadStatus.models },
  };
}

export async function preloadModels(options: {
  contextPoolSize?: number;
  origin?: "daemon" | "cli" | "manual";
  force?: boolean;
} = {}): Promise<PreloadStatus> {
  if (preloadPromise && !options.force) {
    return preloadPromise;
  }

  preloadStatus = {
    ...preloadStatus,
    warmed: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
    lastError: null,
  };
  setModelState("loading");

  preloadPromise = (async () => {
    try {
      const llm = getDefaultLLM();
      if (!(llm instanceof LlamaCpp)) {
        preloadStatus = {
          ...preloadStatus,
          warmed: false,
          completedAt: new Date().toISOString(),
          models: {
            embed: "unsupported",
            rerank: "unsupported",
            expand: "unsupported",
          },
        };
        return getPreloadStatus();
      }

      const contextPoolSize = options.contextPoolSize ?? contextPoolSizeFromEnv();
      const warm = await llm.warmup({ contextPoolSize });
      preloadStatus = {
        ...preloadStatus,
        warmed: warm.warmed,
        completedAt: new Date().toISOString(),
        models: {
          embed: warm.embed ? "loaded" : "idle",
          rerank: warm.rerank ? "loaded" : "idle",
          expand: warm.expand ? "loaded" : "idle",
        },
      };
      return getPreloadStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      preloadStatus = {
        ...preloadStatus,
        warmed: false,
        completedAt: new Date().toISOString(),
        lastError: message,
        models: {
          embed: "error",
          rerank: "error",
          expand: "error",
        },
      };
      return getPreloadStatus();
    } finally {
      preloadPromise = null;
    }
  })();

  return preloadPromise;
}

export function startDaemonPreload(): void {
  if (process.env.KINDX_STARTUP_PRELOAD === "0") {
    return;
  }
  if (preloadPromise || preloadStatus.startedAt) {
    return;
  }
  void preloadModels({ origin: "daemon" });
}
