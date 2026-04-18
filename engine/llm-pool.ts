/**
 * llm-pool.ts — Bounded LLM context pool for multi-agent concurrency
 *
 * Resolves the single-context serialization bottleneck identified in the
 * principal audit (P2 Gap #3). Provides a bounded pool of LLM sessions
 * that allows N concurrent operations before queueing, removing the
 * global serialization lock from withLLMScope.
 *
 * Design decisions:
 * - Pool size defaults to 1 (backward-compatible; single-process safe).
 * - KINDX_LLM_POOL_SIZE=N allows operators to allocate N concurrent contexts.
 *   Each context consumes ~300-600 MB depending on model size and GPU offload.
 * - Bounded queue prevents unbounded memory growth under burst load.
 * - FIFO fairness: waiters are served in arrival order.
 * - Timeout prevents indefinite waiting under contention.
 */

export interface PooledLease {
  /** Unique lease ID for diagnostics. */
  id: number;
  /** Release the lease back to the pool. Must be called in finally blocks. */
  release: () => void;
}

export interface LLMPoolMetrics {
  size: number;
  available: number;
  active: number;
  waiting: number;
  totalAcquired: number;
  totalTimedOut: number;
}

/**
 * Bounded semaphore pool for serializing access to LLM contexts.
 *
 * Usage:
 * ```ts
 * const pool = new LLMPool(2); // 2 concurrent contexts
 * const lease = await pool.acquire(5000); // 5s timeout
 * try {
 *   await doEmbedding();
 * } finally {
 *   lease.release();
 * }
 * ```
 */
export class LLMPool {
  private readonly size: number;
  private available: number;
  private leaseCounter = 0;
  private totalAcquired = 0;
  private totalTimedOut = 0;
  private waitQueue: Array<{
    resolve: (lease: PooledLease) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  constructor(size?: number) {
    const envSize = parseInt(process.env.KINDX_LLM_POOL_SIZE ?? "", 10);
    this.size = Number.isFinite(envSize) && envSize > 0
      ? envSize
      : (size ?? 1);
    this.available = this.size;
  }

  /**
   * Acquire a lease from the pool. Blocks until a slot is available
   * or the timeout expires.
   *
   * @param timeoutMs Maximum wait time in ms. 0 = fail immediately if none available.
   *                  Default: 30000 (30s).
   * @returns A lease that MUST be released in a finally block.
   */
  acquire(timeoutMs: number = 30_000): Promise<PooledLease> {
    if (this.available > 0) {
      this.available--;
      this.totalAcquired++;
      return Promise.resolve(this.createLease());
    }

    if (timeoutMs <= 0) {
      return Promise.reject(
        new LLMPoolExhaustedError(
          `LLM pool exhausted: all ${this.size} contexts in use, ${this.waitQueue.length} waiting`
        )
      );
    }

    return new Promise<PooledLease>((resolve, reject) => {
      const entry: typeof this.waitQueue[number] = {
        resolve,
        reject,
        timer: null,
      };

      entry.timer = setTimeout(() => {
        const idx = this.waitQueue.indexOf(entry);
        if (idx >= 0) {
          this.waitQueue.splice(idx, 1);
          this.totalTimedOut++;
          reject(
            new LLMPoolTimeoutError(
              `LLM pool acquire timed out after ${timeoutMs}ms ` +
              `(pool=${this.size}, active=${this.size - this.available}, waiting=${this.waitQueue.length})`
            )
          );
        }
      }, timeoutMs);

      this.waitQueue.push(entry);
    });
  }

  /**
   * Execute a function with a pooled lease, releasing automatically on completion.
   */
  async withLease<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const lease = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      lease.release();
    }
  }

  /**
   * Current pool state for observability.
   */
  getMetrics(): LLMPoolMetrics {
    return {
      size: this.size,
      available: this.available,
      active: this.size - this.available,
      waiting: this.waitQueue.length,
      totalAcquired: this.totalAcquired,
      totalTimedOut: this.totalTimedOut,
    };
  }

  private createLease(): PooledLease {
    const id = ++this.leaseCounter;
    let released = false;
    return {
      id,
      release: () => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  private release(): void {
    // Serve the next waiter in FIFO order
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      if (next.timer) clearTimeout(next.timer);
      this.totalAcquired++;
      next.resolve(this.createLease());
    } else {
      this.available++;
    }
  }
}

export class LLMPoolExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMPoolExhaustedError";
  }
}

export class LLMPoolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMPoolTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Singleton pool instance — shared across the process
// ---------------------------------------------------------------------------

let _defaultPool: LLMPool | null = null;

/**
 * Get the process-global LLM pool. Pool size is determined by
 * KINDX_LLM_POOL_SIZE env var (default: 1 for backward compatibility).
 */
export function getDefaultLLMPool(): LLMPool {
  if (!_defaultPool) {
    _defaultPool = new LLMPool();
  }
  return _defaultPool;
}

/**
 * Replace the default pool (for testing).
 */
export function setDefaultLLMPool(pool: LLMPool | null): void {
  _defaultPool = pool;
}
