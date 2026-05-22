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
}

export class PriorityQueue<T> {
  private queue: QueueEntry<T>[] = [];
  private readonly maxSize: number;
  private shedCount = 0;
  private totalEnqueued = 0;
  private totalDequeued = 0;

  constructor(config: PriorityQueueConfig) {
    this.maxSize = config.maxSize;
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

    const entry: QueueEntry<T> = { item, priority };
    const insertIdx = this.findInsertIndex(priority);
    this.queue.splice(insertIdx, 0, entry);
    this.totalEnqueued++;
  }

  async dequeue(): Promise<T> {
    if (this.queue.length === 0) {
      throw new Error("Queue is empty");
    }
    const entry = this.queue.shift()!;
    this.totalDequeued++;
    return entry.item;
  }

  getMetrics(): PriorityQueueMetrics {
    return {
      size: this.queue.length,
      maxSize: this.maxSize,
      shedCount: this.shedCount,
      totalEnqueued: this.totalEnqueued,
      totalDequeued: this.totalDequeued,
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
