import { createStore } from "./repository.js";
import { logger } from "./utils/logger.js";
import type { Store } from "./repository.js";
import type { Database } from "./runtime.js";

export function createResilientStore(dbPath?: string): Store {
  let innerStore = createStore(dbPath);

  function checkError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("disk image is malformed") || msg.includes("SQLITE_CORRUPT") || msg.includes("readonly database")) {
      logger.warn(`KINDX Recovery: Database connection stale (${msg}), recycling connection...`);
      try { innerStore.close(); } catch {}
      innerStore = createStore(dbPath);
      return true;
    }
    return false;
  }

  const dbProxy = new Proxy({} as any, {
    get(target, prop) {
      if (prop === "transaction") {
         return function(fn: any) {
           return function(...tArgs: any[]) {
              try {
                return (innerStore.db.transaction(fn) as any)(...tArgs);
              } catch (e) {
                 if (checkError(e)) {
                    return (innerStore.db.transaction(fn) as any)(...tArgs);
                 }
                 throw e;
              }
           }
         }
      }

      const dbVal = (innerStore.db as any)[prop];
      if (typeof dbVal === "function") {
        return function(...args: any[]) {
          try {
            const res = dbVal.apply(innerStore.db, args);
            if (prop === "prepare") {
               return new Proxy(res, {
                 get(sTarget, sProp) {
                   const sVal = res[sProp];
                   if (typeof sVal === "function") {
                     return function(...sArgs: any[]) {
                        try {
                          return sVal.apply(res, sArgs);
                        } catch (e) {
                          if (checkError(e)) {
                             const newStmt = innerStore.db.prepare(args[0]);
                             return (newStmt as any)[sProp].apply(newStmt, sArgs);
                          }
                          throw e;
                        }
                     }
                   }
                   return sVal;
                 }
               });
            }
            return res;
          } catch (e) {
             if (checkError(e)) {
               return (innerStore.db as any)[prop].apply(innerStore.db, args);
             }
             throw e;
          }
        };
      }
      return dbVal;
    }
  });

  return new Proxy({} as Store, {
    get(target, prop) {
      if (prop === "db") return dbProxy;
      const val = (innerStore as any)[prop];
      if (typeof val === "function") {
        return function(...args: any[]) {
          try {
            return val.apply(innerStore, args);
          } catch (e) {
            if (checkError(e)) {
               return (innerStore as any)[prop].apply(innerStore, args);
            }
            throw e;
          }
        }
      }
      return val;
    }
  });
}
