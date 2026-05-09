import { describe, expect, test, vi } from "vitest";
import { BoundedCache } from "../engine/utils/bounded-cache.js";

describe("BoundedCache", () => {
  test("stores and retrieves values", () => {
    const c = new BoundedCache<number>({ maxItems: 10 });
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
    expect(c.size).toBe(2);
  });

  test("evicts least-recently-used when full", () => {
    const evicted: Array<[string, number, string]> = [];
    const c = new BoundedCache<number>({
      maxItems: 3,
      onEvict: (k, v, reason) => evicted.push([k, v, reason]),
    });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.get("a"); // a is now most-recently-used
    c.set("d", 4); // should evict b (LRU)
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
    expect(c.has("d")).toBe(true);
    expect(evicted).toEqual([["b", 2, "lru"]]);
  });

  test("touches LRU on get", () => {
    const c = new BoundedCache<number>({ maxItems: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // touch a; b is now oldest
    c.set("c", 3); // should evict b
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
  });

  test("expires entries after TTL", () => {
    vi.useFakeTimers();
    try {
      const c = new BoundedCache<string>({ maxItems: 10, ttlMs: 1000 });
      c.set("a", "v");
      expect(c.get("a")).toBe("v");
      vi.advanceTimersByTime(500);
      expect(c.get("a")).toBe("v");
      vi.advanceTimersByTime(1000);
      expect(c.get("a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reaper actively expires entries", () => {
    vi.useFakeTimers();
    try {
      const evicted: string[] = [];
      const c = new BoundedCache<string>({
        maxItems: 10,
        ttlMs: 100,
        reaperMs: 50,
        onEvict: (k, _v, reason) => evicted.push(`${k}:${reason}`),
      });
      c.set("x", "1");
      vi.advanceTimersByTime(200); // past TTL + reaper tick
      expect(evicted).toContain("x:ttl");
      expect(c.size).toBe(0);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("delete removes entry and fires evict with reason 'manual'", () => {
    const evicted: string[] = [];
    const c = new BoundedCache<number>({
      maxItems: 5,
      onEvict: (k, _v, r) => evicted.push(`${k}:${r}`),
    });
    c.set("a", 1);
    expect(c.delete("a")).toBe(true);
    expect(c.delete("missing")).toBe(false);
    expect(evicted).toEqual(["a:manual"]);
  });

  test("clear empties the cache and fires evict for every entry", () => {
    const evicted: string[] = [];
    const c = new BoundedCache<number>({
      maxItems: 5,
      onEvict: (k) => evicted.push(k),
    });
    c.set("a", 1);
    c.set("b", 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(evicted.sort()).toEqual(["a", "b"]);
  });

  test("entries() skips expired and does not touch LRU", () => {
    vi.useFakeTimers();
    try {
      const c = new BoundedCache<number>({ maxItems: 5, ttlMs: 1000 });
      c.set("old", 1);
      vi.advanceTimersByTime(500);
      c.set("new", 2);
      vi.advanceTimersByTime(600); // old is now expired (1100ms), new is not (600ms)
      const live = [...c.entries()];
      expect(live).toEqual([["new", 2]]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("onEvict errors do not crash the cache", () => {
    const c = new BoundedCache<number>({
      maxItems: 1,
      onEvict: () => { throw new Error("oops"); },
    });
    c.set("a", 1);
    expect(() => c.set("b", 2)).not.toThrow();
    expect(c.has("b")).toBe(true);
  });

  test("rejects non-positive maxItems", () => {
    expect(() => new BoundedCache<number>({ maxItems: 0 })).toThrow();
    expect(() => new BoundedCache<number>({ maxItems: -1 })).toThrow();
  });
});
