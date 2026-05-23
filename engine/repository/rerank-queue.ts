// Extracted from engine/repository.ts as part of W1 decomposition (C13).
// Rerank backpressure queue with fairness metrics. Carries module-level state
// (the controllers map); kept here so the lifecycle is testable in one place.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { getCollection, type NamedCollection } from "../catalogs.js";

export type RerankDropPolicy = "timeout_fallback" | "wait";

export type RerankQueueConfig = {
  key: string;
  concurrency: number;
  queueLimit: number | null;
  dropPolicy: RerankDropPolicy;
};

export type RerankQueueSnapshot = {
  depth: number;
  active: number;
  limit: number | null;
  concurrency: number;
  dropPolicy: RerankDropPolicy;
  fairness: {
    enqueued: number;
    dequeued: number;
    immediateServed: number;
    deferredServed: number;
    timedOut: number;
    saturated: number;
    lastServedSeq: number | null;
  };
};

export type QueueWaitResult = {
  release: (() => void) | null;
  deferred: boolean;
  saturated: boolean;
  timedOut: boolean;
};

export type QueueController = {
  active: number;
  nextSeq: number;
  metrics: {
    enqueued: number;
    dequeued: number;
    immediateServed: number;
    deferredServed: number;
    timedOut: number;
    saturated: number;
    lastServedSeq: number | null;
  };
  waiting: Array<{
    seq: number;
    resolve: (value: QueueWaitResult) => void;
    timeoutHandle: NodeJS.Timeout | null;
    completed: boolean;
  }>;
};

const rerankControllers = new Map<string, QueueController>();

export function getQueueController(key: string): QueueController {
  let controller = rerankControllers.get(key);
  if (!controller) {
    controller = {
      active: 0,
      nextSeq: 1,
      metrics: {
        enqueued: 0,
        dequeued: 0,
        immediateServed: 0,
        deferredServed: 0,
        timedOut: 0,
        saturated: 0,
        lastServedSeq: null,
      },
      waiting: [],
    };
    rerankControllers.set(key, controller);
  }
  return controller;
}

/**
 * Evict idle / unused queue controllers. Long-running daemons that see
 * many transient collection names (renames, integration tests, ephemeral
 * scopes) otherwise accumulate Map entries forever.
 *
 * "Idle" means no active in-flight requests, no waiting entries, and no
 * activity since the previous call (lastServedSeq unchanged). Callers can
 * also force-evict a specific key when they know the collection was
 * removed/renamed.
 */
export function evictRerankController(key: string): boolean {
  const c = rerankControllers.get(key);
  if (!c) return false;
  if (c.active === 0 && c.waiting.length === 0) {
    rerankControllers.delete(key);
    return true;
  }
  return false;
}

export function pruneIdleRerankControllers(): number {
  let pruned = 0;
  for (const [key, c] of rerankControllers) {
    if (c.active === 0 && c.waiting.length === 0 && c.metrics.enqueued === c.metrics.dequeued) {
      rerankControllers.delete(key);
      pruned++;
    }
  }
  return pruned;
}

/** Returns the number of controllers currently tracked. Used in tests. */
export function getRerankControllerCount(): number {
  return rerankControllers.size;
}

export function makeQueueRelease(controller: QueueController, concurrency: number): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    controller.active = Math.max(0, controller.active - 1);
    while (controller.active < concurrency && controller.waiting.length > 0) {
      const next = controller.waiting.shift();
      if (!next || next.completed) continue;
      next.completed = true;
      if (next.timeoutHandle) clearTimeout(next.timeoutHandle);
      controller.active += 1;
      controller.metrics.dequeued += 1;
      controller.metrics.deferredServed += 1;
      controller.metrics.lastServedSeq = next.seq;
      const release = makeQueueRelease(controller, concurrency);
      next.resolve({ release, deferred: true, saturated: false, timedOut: false });
      break;
    }
  };
}

export async function acquireRerankSlot(config: RerankQueueConfig, timeoutMs?: number): Promise<QueueWaitResult> {
  const controller = getQueueController(config.key);
  const concurrency = Math.max(1, Math.floor(config.concurrency));
  if (controller.active < concurrency) {
    controller.active += 1;
    controller.metrics.immediateServed += 1;
    controller.metrics.lastServedSeq = 0;
    return { release: makeQueueRelease(controller, concurrency), deferred: false, saturated: false, timedOut: false };
  }

  const limit = config.queueLimit;
  if (limit !== null && controller.waiting.length >= limit) {
    controller.metrics.saturated += 1;
    return { release: null, deferred: false, saturated: true, timedOut: false };
  }

  return new Promise<QueueWaitResult>((resolve) => {
    const seq = controller.nextSeq++;
    const entry = {
      seq,
      resolve,
      timeoutHandle: null as NodeJS.Timeout | null,
      completed: false,
    };
    controller.metrics.enqueued += 1;
    if (config.dropPolicy === "timeout_fallback" && timeoutMs && timeoutMs > 0) {
      entry.timeoutHandle = setTimeout(() => {
        if (entry.completed) return;
        entry.completed = true;
        const idx = controller.waiting.indexOf(entry);
        if (idx >= 0) controller.waiting.splice(idx, 1);
        controller.metrics.timedOut += 1;
        resolve({ release: null, deferred: true, saturated: false, timedOut: true });
      }, timeoutMs);
      entry.timeoutHandle.unref?.();
    }
    controller.waiting.push(entry);
  });
}

export function getRerankQueueSnapshot(config: RerankQueueConfig): RerankQueueSnapshot {
  const controller = getQueueController(config.key);
  return {
    depth: controller.waiting.length,
    active: controller.active,
    limit: config.queueLimit,
    concurrency: Math.max(1, Math.floor(config.concurrency)),
    dropPolicy: config.dropPolicy,
    fairness: {
      enqueued: controller.metrics.enqueued,
      dequeued: controller.metrics.dequeued,
      immediateServed: controller.metrics.immediateServed,
      deferredServed: controller.metrics.deferredServed,
      timedOut: controller.metrics.timedOut,
      saturated: controller.metrics.saturated,
      lastServedSeq: controller.metrics.lastServedSeq,
    },
  };
}

export function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function getCollectionRerankSettings(collectionName?: string): {
  maxCandidates?: number;
  timeoutMs?: number;
  queueLimit?: number;
  concurrency?: number;
  dropPolicy?: "timeout_fallback" | "wait";
  vectorFanoutWorkers?: number;
} {
  if (!collectionName) return {};
  const cfg = getCollection(collectionName) as (NamedCollection & {
    max_rerank_candidates?: number;
    rerank_timeout_ms?: number;
    rerank_queue_limit?: number;
    rerank_concurrency?: number;
    rerank_drop_policy?: "timeout_fallback" | "wait";
    vector_fanout_workers?: number;
  }) | null;
  const maxCandidates = Number(cfg?.max_rerank_candidates);
  const timeoutMs = Number(cfg?.rerank_timeout_ms);
  const queueLimit = Number(cfg?.rerank_queue_limit);
  const concurrency = Number(cfg?.rerank_concurrency);
  const vectorFanoutWorkers = Number(cfg?.vector_fanout_workers);
  const dropPolicyRaw = String(cfg?.rerank_drop_policy ?? "").trim().toLowerCase();
  const dropPolicy = dropPolicyRaw === "wait" ? "wait" : dropPolicyRaw === "timeout_fallback" ? "timeout_fallback" : undefined;
  return {
    maxCandidates: Number.isFinite(maxCandidates) && maxCandidates > 0 ? Math.floor(maxCandidates) : undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : undefined,
    queueLimit: Number.isFinite(queueLimit) && queueLimit > 0 ? Math.floor(queueLimit) : undefined,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : undefined,
    dropPolicy,
    vectorFanoutWorkers: Number.isFinite(vectorFanoutWorkers) && vectorFanoutWorkers > 0 ? Math.floor(vectorFanoutWorkers) : undefined,
  };
}

export function getRerankThroughputSnapshot(collectionName?: string): RerankQueueSnapshot {
  const settings = getCollectionRerankSettings(collectionName);
  const envConcurrency = parsePositiveInt(process.env.KINDX_RERANK_CONCURRENCY);
  const envQueueLimit = parsePositiveInt(process.env.KINDX_RERANK_QUEUE_LIMIT);
  const envDropPolicyRaw = String(process.env.KINDX_RERANK_DROP_POLICY ?? "").trim().toLowerCase();
  const envDropPolicy = envDropPolicyRaw === "wait" ? "wait" : envDropPolicyRaw === "timeout_fallback" ? "timeout_fallback" : undefined;
  const config: RerankQueueConfig = {
    key: collectionName ?? "__global__",
    concurrency: envConcurrency ?? settings.concurrency ?? 1,
    queueLimit: envQueueLimit ?? settings.queueLimit ?? null,
    dropPolicy: envDropPolicy ?? settings.dropPolicy ?? "timeout_fallback",
  };
  return getRerankQueueSnapshot(config);
}

export async function runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  const concurrency = Math.max(1, Math.floor(limit));
  const results: T[] = new Array(tasks.length);
  let index = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= tasks.length) break;
      const task = tasks[current];
      if (!task) continue;
      results[current] = await task();
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
