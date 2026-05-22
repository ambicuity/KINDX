import { describe, it, expect, beforeEach } from "vitest";
import { PriorityQueue, QueueExhaustedError } from "../engine/priority-queue.js";

describe("PriorityQueue", () => {
  beforeEach(() => {
    delete process.env.KINDX_QUEUE_MAX_DEPTH;
  });

  it("should dequeue items in priority order", () => {
    const queue = new PriorityQueue<string>({ maxSize: 10 });
    queue.enqueue("low", "low");
    queue.enqueue("high", "high");
    queue.enqueue("normal", "normal");
    queue.enqueue("critical", "critical");

    expect(queue.dequeue()).toBe("critical");
    expect(queue.dequeue()).toBe("high");
    expect(queue.dequeue()).toBe("normal");
    expect(queue.dequeue()).toBe("low");
  });

  it("should shed lowest priority when full", () => {
    const queue = new PriorityQueue<string>({ maxSize: 2 });
    queue.enqueue("first", "normal");
    queue.enqueue("second", "normal");

    expect(() => queue.enqueue("third", "low")).toThrow(QueueExhaustedError);
    expect(queue.size).toBe(2);
  });

  it("should shed lower priority to make room for higher", () => {
    const queue = new PriorityQueue<string>({ maxSize: 2 });
    queue.enqueue("low1", "low");
    queue.enqueue("low2", "low");

    queue.enqueue("high", "high");
    expect(queue.size).toBe(2);
    expect(queue.dequeue()).toBe("high");
  });

  it("should never shed critical priority", () => {
    const queue = new PriorityQueue<string>({ maxSize: 2 });
    queue.enqueue("crit1", "critical");
    queue.enqueue("crit2", "critical");

    expect(() => queue.enqueue("crit3", "critical")).toThrow(QueueExhaustedError);
  });

  it("should report metrics", () => {
    const queue = new PriorityQueue<string>({ maxSize: 10 });
    queue.enqueue("a", "normal");
    queue.enqueue("b", "low");

    const metrics = queue.getMetrics();
    expect(metrics.size).toBe(2);
    expect(metrics.maxSize).toBe(10);
    expect(metrics.shedCount).toBe(0);
  });

  it("should use default maxSize of 100", () => {
    const queue = new PriorityQueue<string>();
    expect(queue.getMetrics().maxSize).toBe(100);
  });

  it("should read maxSize from KINDX_QUEUE_MAX_DEPTH env var", () => {
    process.env.KINDX_QUEUE_MAX_DEPTH = "50";
    const queue = new PriorityQueue<string>();
    expect(queue.getMetrics().maxSize).toBe(50);
  });

  it("should prefer explicit config over env var", () => {
    process.env.KINDX_QUEUE_MAX_DEPTH = "50";
    const queue = new PriorityQueue<string>({ maxSize: 25 });
    expect(queue.getMetrics().maxSize).toBe(25);
  });

  it("should report wait time percentiles in metrics", () => {
    const queue = new PriorityQueue<string>({ maxSize: 10 });
    queue.enqueue("a", "normal");

    const metrics = queue.getMetrics();
    expect(metrics.waitTimePercentiles).toBeDefined();
    expect(metrics.waitTimePercentiles.p50).toBeGreaterThanOrEqual(0);
    expect(metrics.waitTimePercentiles.p90).toBeGreaterThanOrEqual(0);
    expect(metrics.waitTimePercentiles.p99).toBeGreaterThanOrEqual(0);
  });

  it("should return zero percentiles for empty queue", () => {
    const queue = new PriorityQueue<string>({ maxSize: 10 });
    const metrics = queue.getMetrics();
    expect(metrics.waitTimePercentiles.p50).toBe(0);
    expect(metrics.waitTimePercentiles.p90).toBe(0);
    expect(metrics.waitTimePercentiles.p99).toBe(0);
  });
});
