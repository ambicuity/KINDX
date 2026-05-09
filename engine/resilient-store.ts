import { createStore } from "./repository.js";
import { logger } from "./utils/logger.js";
import type { Store } from "./repository.js";

/**
 * Statement methods that are safe to retry after a connection recycle.
 *
 * `get` / `all` / `pluck` / `iterate` are read operations: re-running them on
 * the recycled connection produces the same result as the original call.
 *
 * `run` is intentionally absent. The previous implementation retried `run`
 * (and full `transaction(fn)` invocations) after a recycle, so any non-
 * idempotent write — counter increment, memory insert, audit append — could
 * execute twice without the caller knowing. Tier-1 fix: writes recycle
 * once, then re-throw so the caller decides whether to retry.
 */
const READ_ONLY_STMT_METHODS = new Set(["get", "all", "pluck", "iterate", "raw", "columns", "expand", "bind", "safeIntegers"]);

export function createResilientStore(dbPath?: string): Store {
  let innerStore = createStore(dbPath);

  /**
   * Recycle the connection if the error indicates a stale/corrupt state.
   * Returns true if recycled (caller may retry idempotent reads), false
   * otherwise (caller must re-throw).
   */
  function recycleIfStale(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("disk image is malformed") || msg.includes("SQLITE_CORRUPT") || msg.includes("readonly database")) {
      logger.warn(`KINDX Recovery: Database connection stale (${msg}), recycling connection...`);
      try { innerStore.close(); } catch { /* noop */ }
      innerStore = createStore(dbPath);
      return true;
    }
    return false;
  }

  const dbProxy = new Proxy({} as any, {
    get(_target, prop) {
      if (prop === "transaction") {
        // Tier-1: never auto-retry a transaction. Recycle on stale-error so
        // the next invocation has a healthy connection, but re-throw so the
        // caller decides — a transaction body that ran a counter increment
        // before the error must NOT be silently re-executed.
        return function (fn: any) {
          return function (...tArgs: any[]) {
            try {
              return (innerStore.db.transaction(fn) as any)(...tArgs);
            } catch (e) {
              recycleIfStale(e);
              throw e;
            }
          };
        };
      }

      const dbVal = (innerStore.db as any)[prop];
      if (typeof dbVal === "function") {
        return function (...args: any[]) {
          try {
            const res = dbVal.apply(innerStore.db, args);
            if (prop === "prepare") {
              return new Proxy(res, {
                get(_sTarget, sProp) {
                  const sVal = res[sProp];
                  if (typeof sVal === "function") {
                    return function (...sArgs: any[]) {
                      try {
                        return sVal.apply(res, sArgs);
                      } catch (e) {
                        // Read methods are idempotent — safe to retry on the
                        // recycled connection. Writes (`run`, `bulkInsert`...)
                        // recycle but re-throw so callers don't double-write.
                        if (READ_ONLY_STMT_METHODS.has(String(sProp)) && recycleIfStale(e)) {
                          const newStmt = innerStore.db.prepare(args[0]);
                          return (newStmt as any)[sProp].apply(newStmt, sArgs);
                        }
                        recycleIfStale(e);
                        throw e;
                      }
                    };
                  }
                  return sVal;
                },
              });
            }
            return res;
          } catch (e) {
            recycleIfStale(e);
            throw e;
          }
        };
      }
      return dbVal;
    },
  });

  return new Proxy({} as Store, {
    get(_target, prop) {
      if (prop === "db") return dbProxy;
      const val = (innerStore as any)[prop];
      if (typeof val === "function") {
        return function (...args: any[]) {
          try {
            return val.apply(innerStore, args);
          } catch (e) {
            // Top-level Store methods include reads AND writes; we cannot
            // know which, so recycle on stale-error and re-throw. Caller
            // re-invokes if appropriate.
            recycleIfStale(e);
            throw e;
          }
        };
      }
      return val;
    },
  });
}
