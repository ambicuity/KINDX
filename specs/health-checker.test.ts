import { describe, it, expect } from "vitest";
import { HealthChecker } from "../engine/health-checker.js";

describe("HealthChecker", () => {
  it("should return liveness status", async () => {
    const checker = new HealthChecker({
      getModelsStatus: () => ({ embed: true, rerank: true, generate: true }),
      getGpuStatus: () => ({ available: true, vramFree: 1000000 }),
      getAnnStatus: () => ({ mode: "ann", state: "ready" }),
      getDatabaseStatus: () => ({ accessible: true }),
    });

    const result = await checker.checkLiveness();
    expect(result.status).toBe("ok");
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it("should return readiness when all checks pass", async () => {
    const checker = new HealthChecker({
      getModelsStatus: () => ({ embed: true, rerank: true, generate: true }),
      getGpuStatus: () => ({ available: true, vramFree: 1000000 }),
      getAnnStatus: () => ({ mode: "ann", state: "ready" }),
      getDatabaseStatus: () => ({ accessible: true }),
    });

    const result = await checker.checkReadiness();
    expect(result.status).toBe("ready");
    expect(result.checks.models.status).toBe("ok");
    expect(result.checks.gpu.status).toBe("ok");
    expect(result.checks.ann.status).toBe("ok");
    expect(result.checks.database.status).toBe("ok");
  });

  it("should return not_ready when models not loaded", async () => {
    const checker = new HealthChecker({
      getModelsStatus: () => ({ embed: false, rerank: true, generate: true }),
      getGpuStatus: () => ({ available: true, vramFree: 1000000 }),
      getAnnStatus: () => ({ mode: "ann", state: "ready" }),
      getDatabaseStatus: () => ({ accessible: true }),
    });

    const result = await checker.checkReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.checks.models.status).toBe("error");
  });

  it("should return degraded when ANN not ready", async () => {
    const checker = new HealthChecker({
      getModelsStatus: () => ({ embed: true, rerank: true, generate: true }),
      getGpuStatus: () => ({ available: true, vramFree: 1000000 }),
      getAnnStatus: () => ({ mode: "exact", state: "missing" }),
      getDatabaseStatus: () => ({ accessible: true }),
    });

    const result = await checker.checkReadiness();
    expect(result.status).toBe("degraded");
    expect(result.checks.ann.status).toBe("warn");
  });
});
