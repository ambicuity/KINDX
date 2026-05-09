/**
 * Regression: LLMPool acquire must not leak abort listeners on the caller's
 * AbortSignal. The previous code wrapped only `entry.resolve` to remove the
 * listener — exits via timeout or via the slot-loss `release()` path left
 * the listener attached, eventually triggering MaxListenersExceededWarning
 * on long-lived signals (session-scoped controllers).
 *
 * Also exercises the slot-recovery path: a release() that encounters an
 * already-settled waiter at the head of the queue must drain past it and
 * find a live waiter rather than silently losing the slot.
 */

import { describe, expect, test } from "vitest";
import { LLMPool, LLMPoolTimeoutError } from "../engine/llm-pool.js";

function listenerCount(signal: AbortSignal): number {
  // Node exposes per-target listener counts via this internal helper on AbortSignal.
  const anySig = signal as any;
  if (typeof anySig.eventNames === "function") {
    return anySig.listenerCount?.("abort") ?? 0;
  }
  return 0;
}

describe("LLMPool abort-listener cleanup", () => {
  test("resolve path detaches abort listener", async () => {
    const pool = new LLMPool(1);
    const ac = new AbortController();
    const before = listenerCount(ac.signal);

    const lease = await pool.acquire(1000, ac.signal);
    lease.release();

    // No new listeners should remain.
    expect(listenerCount(ac.signal)).toBe(before);
  });

  test("timeout path detaches abort listener (was leaking)", async () => {
    const pool = new LLMPool(1);
    // Hold the only slot.
    const held = await pool.acquire(1000);

    const ac = new AbortController();
    const before = listenerCount(ac.signal);

    await expect(pool.acquire(50, ac.signal)).rejects.toBeInstanceOf(LLMPoolTimeoutError);
    expect(listenerCount(ac.signal)).toBe(before);

    held.release();
  });

  test("abort path detaches its own listener", async () => {
    const pool = new LLMPool(1);
    const held = await pool.acquire(1000);

    const ac = new AbortController();
    const before = listenerCount(ac.signal);

    const acquirePromise = pool.acquire(5000, ac.signal);
    ac.abort(new Error("user-cancelled"));
    await expect(acquirePromise).rejects.toThrow(/user-cancelled/);

    expect(listenerCount(ac.signal)).toBe(before);
    held.release();
  });

  test("repeated acquire+timeout on a shared signal does not accumulate listeners", async () => {
    const pool = new LLMPool(1);
    const held = await pool.acquire(1000);

    const ac = new AbortController();
    const before = listenerCount(ac.signal);

    for (let i = 0; i < 50; i++) {
      await expect(pool.acquire(5, ac.signal)).rejects.toBeInstanceOf(LLMPoolTimeoutError);
    }

    expect(listenerCount(ac.signal)).toBe(before);
    held.release();
  });

  test("release() drains past a settled waiter and serves the next live one", async () => {
    const pool = new LLMPool(1);
    const held = await pool.acquire(1000);

    // Two waiters: the first will time out, the second is patient.
    const fast = pool.acquire(50);
    const slow = pool.acquire(2000);

    await expect(fast).rejects.toBeInstanceOf(LLMPoolTimeoutError);
    held.release();
    // Slow must receive the released slot.
    const slowLease = await slow;
    expect(slowLease.id).toBeGreaterThan(0);
    slowLease.release();

    // Pool is now fully available again.
    expect(pool.getMetrics().available).toBe(1);
  });
});
