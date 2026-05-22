import { describe, it, expect } from "vitest";
import { PriorityQueue, QueueExhaustedError } from "../engine/priority-queue.js";

describe("PriorityQueue", () => {
  it("should dequeue items in priority order", async () => {
    const queue = new PriorityQueue<string>({ maxSize: 10 });
    queue.enqueue("low", "low");
    queue.enqueue("high", "high");
    queue.enqueue("normal", "normal");
    queue.enqueue("critical", "critical");

    expect(await queue.dequeue()).toBe("critical");
    expect(await queue.dequeue()).toBe("high");
    expect(await queue.dequeue()).toBe("normal");
    expect(await queue.dequeue()).toBe("low");
  });

  it("should shed lowest priority when full", async () => {
    const queue = new PriorityQueue<string>({ maxSize: 2 });
    queue.enqueue("first", "normal");
    queue.enqueue("second", "normal");

    expect(() => queue.enqueue("third", "low")).toThrow(QueueExhaustedError);
    expect(queue.size).toBe(2);
  });

  it("should shed lower priority to make room for higher", async () => {
    const queue = new PriorityQueue<string>({ maxSize: 2 });
    queue.enqueue("low1", "low");
    queue.enqueue("low2", "low");

    queue.enqueue("high", "high");
    expect(queue.size).toBe(2);
    expect(await queue.dequeue()).toBe("high");
  });

  it("should never shed critical priority", async () => {
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
});
