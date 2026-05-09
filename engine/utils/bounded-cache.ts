/**
 * bounded-cache.ts
 *
 * Generic LRU cache with optional TTL and idle-reaper. Replaces the ad-hoc
 * `Map + size cap` pattern that the audit found in 8+ places (session
 * embeddings, query expansion, truncation cache, MCP sessions, in-flight maps,
 * tool registry log, label cardinality cap, mcp-control-plane warn dedupe).
 *
 * Design notes:
 *   - LRU recency tracked via Map insertion order (delete + re-set on touch).
 *   - Optional TTL enforced lazily on get + actively by an idle reaper.
 *   - `onEvict` lets callers run cleanup (e.g. dispose() native resources).
 *   - All writes are O(1); the eviction loop runs at most `maxItems`-sized,
 *     amortized O(1) under steady state.
 */

export type BoundedCacheOptions<V> = {
  /** Hard cap on entry count. Required. */
  maxItems: number;
  /** Optional TTL in milliseconds. 0 / undefined = no expiry. */
  ttlMs?: number;
  /** Optional idle-reaper interval. 0 / undefined = lazy expiry only. */
  reaperMs?: number;
  /** Called when an entry is evicted (LRU or TTL). Errors are swallowed. */
  onEvict?: (key: string, value: V, reason: "lru" | "ttl" | "manual") => void;
};

type Entry<V> = {
  value: V;
  expiresAt: number; // 0 = no expiry
};

export class BoundedCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly maxItems: number;
  private readonly ttlMs: number;
  private readonly onEvict?: (key: string, value: V, reason: "lru" | "ttl" | "manual") => void;
  private reaper: NodeJS.Timeout | null = null;

  constructor(options: BoundedCacheOptions<V>) {
    if (!Number.isInteger(options.maxItems) || options.maxItems <= 0) {
      throw new Error(`bounded-cache: maxItems must be positive integer, got ${options.maxItems}`);
    }
    this.maxItems = options.maxItems;
    this.ttlMs = options.ttlMs ?? 0;
    this.onEvict = options.onEvict;

    if (options.reaperMs && options.reaperMs > 0) {
      this.reaper = setInterval(() => this.reap(), options.reaperMs);
      // Don't keep the process alive just for the reaper.
      if (typeof this.reaper.unref === "function") this.reaper.unref();
    }
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Returns the value if present and not expired. Touches LRU recency.
   */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.fireEvict(key, entry.value, "ttl");
      return undefined;
    }
    // Touch: move to end of insertion order.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Inserts or updates. Evicts the least-recently-used entry if at capacity.
   */
  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxItems) {
      this.evictOldest();
    }
    const expiresAt = this.ttlMs > 0 ? Date.now() + this.ttlMs : 0;
    this.map.set(key, { value, expiresAt });
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.fireEvict(key, entry.value, "manual");
    return true;
  }

  clear(): void {
    for (const [key, entry] of this.map) {
      this.fireEvict(key, entry.value, "manual");
    }
    this.map.clear();
  }

  /**
   * Stops the idle reaper if one was scheduled. After dispose, the cache still
   * works for set/get but TTL is enforced lazily only.
   */
  dispose(): void {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    this.clear();
  }

  /**
   * Iterate live (non-expired) entries. Does NOT touch LRU.
   */
  *entries(): IterableIterator<[string, V]> {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) continue;
      yield [key, entry.value];
    }
  }

  private evictOldest(): void {
    const first = this.map.keys().next();
    if (first.done) return;
    const key = first.value;
    const entry = this.map.get(key)!;
    this.map.delete(key);
    this.fireEvict(key, entry.value, "lru");
  }

  private reap(): void {
    if (this.ttlMs <= 0) return;
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.map.delete(key);
        this.fireEvict(key, entry.value, "ttl");
      }
    }
  }

  private fireEvict(key: string, value: V, reason: "lru" | "ttl" | "manual"): void {
    if (!this.onEvict) return;
    try { this.onEvict(key, value, reason); } catch { /* never let onEvict crash the cache */ }
  }
}
