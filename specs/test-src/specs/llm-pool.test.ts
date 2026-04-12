import { describe, expect, test } from "vitest";
import { LLMPool, LLMPoolTimeoutError } from "../engine/llm-pool.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LLMPool contention", () => {
  test("times out when saturated", async () => {
    const pool = new LLMPool(1);
    const lease = await pool.acquire();
    await expect(pool.acquire(20)).rejects.toBeInstanceOf(LLMPoolTimeoutError);
    const metrics = pool.getMetrics();
    expect(metrics.totalTimedOut).toBe(1);
    expect(metrics.waiting).toBe(0);
    lease.release();
  });

  test("serves queued waiters in FIFO order", async () => {
    const pool = new LLMPool(1);
    const lease = await pool.acquire();
    const order: string[] = [];

    const p2 = pool.acquire(200).then((l) => {
      order.push("p2");
      l.release();
    });
    const p3 = pool.acquire(200).then((l) => {
      order.push("p3");
      l.release();
    });

    await sleep(5);
    lease.release();
    await Promise.all([p2, p3]);
    expect(order).toEqual(["p2", "p3"]);
  });

  test("tracks waiting and timeout metrics under congestion", async () => {
    const pool = new LLMPool(1);
    const lease = await pool.acquire();
    const p2 = pool.acquire(15);
    const p3 = pool.acquire(25);

    await sleep(5);
    expect(pool.getMetrics().waiting).toBe(2);

    await expect(p2).rejects.toBeInstanceOf(LLMPoolTimeoutError);
    await expect(p3).rejects.toBeInstanceOf(LLMPoolTimeoutError);
    const metrics = pool.getMetrics();
    expect(metrics.totalTimedOut).toBe(2);
    expect(metrics.waiting).toBe(0);
    expect(metrics.active).toBe(1);
    lease.release();
    expect(pool.getMetrics().active).toBe(0);
  });

  test("withLease releases lease when task throws", async () => {
    const pool = new LLMPool(1);
    await expect(
      pool.withLease(async () => {
        throw new Error("synthetic failure");
      }, 50)
    ).rejects.toThrow("synthetic failure");

    const lease = await pool.acquire(0);
    lease.release();
  });
});
