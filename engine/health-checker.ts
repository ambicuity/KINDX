export interface HealthCheckerDependencies {
  getModelsStatus: () => { embed: boolean; rerank: boolean; generate: boolean };
  getGpuStatus: () => { available: boolean; vramFree: number };
  getAnnStatus: () => { mode: "ann" | "exact"; state: string };
  getDatabaseStatus: () => { accessible: boolean };
}

export interface LivenessResult {
  status: "ok";
  uptime: number;
  timestamp: string;
}

export interface ReadinessResult {
  status: "ready" | "not_ready" | "degraded";
  checks: {
    models: { status: "ok" | "error"; embed: boolean; rerank: boolean; generate: boolean };
    gpu: { status: "ok" | "error"; available: boolean; vramFree: number };
    ann: { status: "ok" | "warn" | "error"; mode: string; state: string };
    database: { status: "ok" | "error"; accessible: boolean };
  };
  timestamp: string;
}

export class HealthChecker {
  private deps: HealthCheckerDependencies;
  private startTime: number;

  constructor(deps: HealthCheckerDependencies) {
    this.deps = deps;
    this.startTime = Date.now();
  }

  async checkLiveness(): Promise<LivenessResult> {
    return {
      status: "ok",
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  async checkReadiness(): Promise<ReadinessResult> {
    const models = this.deps.getModelsStatus();
    const gpu = this.deps.getGpuStatus();
    const ann = this.deps.getAnnStatus();
    const database = this.deps.getDatabaseStatus();

    const modelsOk = models.embed && models.rerank && models.generate;
    const gpuOk = gpu.available;
    const annOk = ann.state === "ready";
    const dbOk = database.accessible;

    const checks = {
      models: {
        status: (modelsOk ? "ok" : "error") as "ok" | "error",
        embed: models.embed,
        rerank: models.rerank,
        generate: models.generate,
      },
      gpu: {
        status: (gpuOk ? "ok" : "error") as "ok" | "error",
        available: gpu.available,
        vramFree: gpu.vramFree,
      },
      ann: {
        status: (annOk ? "ok" : "warn") as "ok" | "warn" | "error",
        mode: ann.mode,
        state: ann.state,
      },
      database: {
        status: (dbOk ? "ok" : "error") as "ok" | "error",
        accessible: database.accessible,
      },
    };

    let status: "ready" | "not_ready" | "degraded";
    if (!modelsOk || !gpuOk || !dbOk) {
      status = "not_ready";
    } else if (!annOk) {
      status = "degraded";
    } else {
      status = "ready";
    }

    return {
      status,
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
