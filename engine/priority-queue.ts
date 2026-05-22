export type Priority = "critical" | "high" | "normal" | "low";

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface PriorityQueueConfig {
  maxSize: number;
}

export interface PriorityQueueMetrics {
  size: number;
  maxSize: number;
  shedCount: number;
  totalEnqueued: number;
  totalDequeued: number;
  waitTimePercentiles: {
    p50: number;
    p90: number;
    p99: number;
  };
}

export class QueueExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueExhaustedError";
  }
}

interface QueueEntry<T> {
  item: T;
  priority: Priority;
  enqueuedAt: number;
}

export class PriorityQueue<T> {
  private queue: QueueEntry<T>[] = [];
  private readonly maxSize: number;
  private shedCount = 0;
  private totalEnqueued = 0;
  private totalDequeued = 0;

  constructor(config?: Partial<PriorityQueueConfig>) {
    const envMax = process.env.KINDX_QUEUE_MAX_DEPTH;
    const envSize = envMax ? parseInt(envMax, 10) : undefined;
    this.maxSize = config?.maxSize ?? envSize ?? 100;
  }

  get size(): number {
    return this.queue.length;
  }

  enqueue(item: T, priority: Priority): void {
    if (this.queue.length >= this.maxSize) {
      const lowestIdx = this.findLowestPriorityIndex();
      if (
        lowestIdx >= 0 &&
        PRIORITY_ORDER[this.queue[lowestIdx].priority] >
          PRIORITY_ORDER[priority]
      ) {
        this.queue.splice(lowestIdx, 1);
        this.shedCount++;
      } else {
        throw new QueueExhaustedError(
          `Queue full (${this.maxSize}), cannot enqueue ${priority} priority`,
        );
      }
    }

    const entry: QueueEntry<T> = { item, priority, enqueuedAt: Date.now() };
    const insertIdx = this.findInsertIndex(priority);
    this.queue.splice(insertIdx, 0, entry);
    this.totalEnqueued++;
  }

  dequeue(): T {
    if (this.queue.length === 0) {
      throw new Error("Queue is empty");
    }
    const entry = this.queue.shift()!;
    this.totalDequeued++;
    return entry.item;
  }

  getMetrics(): PriorityQueueMetrics {
    const now = Date.now();
    const waitTimes = this.queue
      .map((e) => now - e.enqueuedAt)
      .sort((a, b) => a - b);

    const percentile = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, idx)];
    };

    return {
      size: this.queue.length,
      maxSize: this.maxSize,
      shedCount: this.shedCount,
      totalEnqueued: this.totalEnqueued,
      totalDequeued: this.totalDequeued,
      waitTimePercentiles: {
        p50: percentile(waitTimes, 50),
        p90: percentile(waitTimes, 90),
        p99: percentile(waitTimes, 99),
      },
    };
  }

  private findInsertIndex(priority: Priority): number {
    const order = PRIORITY_ORDER[priority];
    for (let i = 0; i < this.queue.length; i++) {
      if (PRIORITY_ORDER[this.queue[i].priority] > order) {
        return i;
      }
    }
    return this.queue.length;
  }

  private findLowestPriorityIndex(): number {
    if (this.queue.length === 0) return -1;
    let lowestIdx = 0;
    let lowestOrder = PRIORITY_ORDER[this.queue[0].priority];
    for (let i = 1; i < this.queue.length; i++) {
      const order = PRIORITY_ORDER[this.queue[i].priority];
      if (order > lowestOrder) {
        lowestOrder = order;
        lowestIdx = i;
      }
    }
    return lowestIdx;
  }
}
