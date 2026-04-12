import { LLMPool, LLMPoolTimeoutError } from "../engine/llm-pool.js";

type ScenarioResult = {
  poolSize: number;
  clients: number;
  successes: number;
  timeouts: number;
  failures: number;
  elapsedMs: number;
  metrics: ReturnType<LLMPool["getMetrics"]>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPoolWithSize(size: number): LLMPool {
  const prev = process.env.KINDX_LLM_POOL_SIZE;
  process.env.KINDX_LLM_POOL_SIZE = String(size);
  try {
    return new LLMPool();
  } finally {
    if (prev === undefined) {
      delete process.env.KINDX_LLM_POOL_SIZE;
    } else {
      process.env.KINDX_LLM_POOL_SIZE = prev;
    }
  }
}

async function runScenario(poolSize: number, clients: number, holdMs: number, timeoutMs: number): Promise<ScenarioResult> {
  const pool = createPoolWithSize(poolSize);
  let successes = 0;
  let timeouts = 0;
  let failures = 0;
  const started = Date.now();

  await Promise.all(
    Array.from({ length: clients }, (_, idx) =>
      pool.withLease(async () => {
        await sleep(holdMs + (idx % 3));
      }, timeoutMs)
        .then(() => { successes += 1; })
        .catch((err) => {
          if (err instanceof LLMPoolTimeoutError) {
            timeouts += 1;
          } else {
            failures += 1;
          }
        })
    )
  );

  const elapsedMs = Date.now() - started;
  return {
    poolSize,
    clients,
    successes,
    timeouts,
    failures,
    elapsedMs,
    metrics: pool.getMetrics(),
  };
}

function printScenario(result: ScenarioResult): void {
  console.log(`\nScenario pool=${result.poolSize} clients=${result.clients}`);
  console.log(`  successes=${result.successes} timeouts=${result.timeouts} failures=${result.failures}`);
  console.log(`  elapsed_ms=${result.elapsedMs}`);
  console.log(
    `  metrics active=${result.metrics.active} waiting=${result.metrics.waiting} ` +
    `acquired_total=${result.metrics.totalAcquired} timed_out_total=${result.metrics.totalTimedOut}`
  );
}

async function main(): Promise<void> {
  const clients = Number(process.env.KINDX_POOL_CONTENTION_CLIENTS ?? 20);
  const holdMs = Number(process.env.KINDX_POOL_CONTENTION_HOLD_MS ?? 40);
  const timeoutMs = Number(process.env.KINDX_POOL_CONTENTION_TIMEOUT_MS ?? 120);
  const largerPool = Number(process.env.KINDX_POOL_CONTENTION_LARGER_POOL ?? 4);

  const saturated = await runScenario(1, clients, holdMs, timeoutMs);
  const wider = await runScenario(largerPool, clients, holdMs, timeoutMs);
  printScenario(saturated);
  printScenario(wider);

  if (saturated.failures > 0 || wider.failures > 0) {
    throw new Error("Non-timeout pool failures detected");
  }
  if (saturated.metrics.waiting !== 0 || wider.metrics.waiting !== 0 || saturated.metrics.active !== 0 || wider.metrics.active !== 0) {
    throw new Error("Pool did not fully unwind active/waiting leases");
  }
  if (wider.timeouts > saturated.timeouts) {
    throw new Error("Larger pool should not produce more timeouts than pool=1 under same load");
  }
  console.log("\nPASS: contention scenarios completed without leaked leases and with non-regressing timeout behavior.");
}

void main();
