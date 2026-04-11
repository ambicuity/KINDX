/**
 * runtime.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under both Bun (bun:sqlite)
 * and Node.js (better-sqlite3). The APIs are nearly identical — the main
 * difference is the import path.
 */

export const isBun = typeof (globalThis as any).Bun !== "undefined";

let _Database: any;
let _sqliteVecLoad: (db: any) => void;
let _sqliteDriverName = "unknown";

if (isBun) {
  // Dynamic string prevents tsc from resolving bun:sqlite on Node.js builds
  const bunSqlite = "bun:" + "sqlite";
  _Database = (await import(/* @vite-ignore */ bunSqlite)).Database;
  _sqliteDriverName = "bun:sqlite";
  const { getLoadablePath } = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => db.loadExtension(getLoadablePath());
} else {
  const explicitDriver = String(process.env.KINDX_SQLITE_DRIVER ?? "").trim();
  const preferredDrivers = explicitDriver
    ? [explicitDriver]
    : ["better-sqlite3-multiple-ciphers", "better-sqlite3"];
  let loaded = false;
  let lastError: unknown;
  for (const driver of preferredDrivers) {
    try {
      if (driver === "better-sqlite3-multiple-ciphers") {
        const mod = "better-sqlite3" + "-multiple-ciphers";
        _Database = (await import(/* @vite-ignore */ mod)).default;
      } else if (driver === "better-sqlite3") {
        const mod = "better-sqlite3";
        _Database = (await import(/* @vite-ignore */ mod)).default;
      } else {
        _Database = (await import(driver)).default;
      }
      _sqliteDriverName = driver;
      loaded = true;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!loaded) {
    throw new Error(
      `Failed to load SQLite runtime driver. Tried: ${preferredDrivers.join(", ")}. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }
  const sqliteVec = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => sqliteVec.load(db);
}

/**
 * Open a SQLite database. Works with both bun:sqlite and better-sqlite3.
 */
export function openDatabase(path: string): Database {
  const db = new _Database(path) as Database;
  db.exec("PRAGMA busy_timeout = 15000;");
  const key = process.env.KINDX_ENCRYPTION_KEY?.trim();
  if (key) {
    const escaped = key.replace(/'/g, "''");
    try {
      if (!supportsSqlCipherPragma(db)) {
        throw new Error(
          `SQLite driver '${_sqliteDriverName}' does not expose SQLCipher PRAGMA support. ` +
          "Use a SQLCipher-enabled runtime (for example better-sqlite3-multiple-ciphers)."
        );
      }
      db.exec(`PRAGMA key = '${escaped}'`);
      // Fail fast on bad key / unsupported SQLCipher builds.
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master").get();
    } catch (err) {
      throw new Error(
        `Encrypted database open failed. Ensure SQLCipher runtime support and valid KINDX_ENCRYPTION_KEY. ` +
        `Root cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return db;
}

export function getSqliteRuntimeDriverName(): string {
  return _sqliteDriverName;
}

export function supportsSqlCipherPragma(db: Database): boolean {
  try {
    const row = db.prepare("PRAGMA cipher_version").get() as
      | { cipher_version?: string }
      | undefined;
    const version = row?.cipher_version;
    return typeof version === "string" && version.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Common subset of the Database interface used throughout KINDX.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /**
   * Wrap a callback in a SQLite transaction.
   * Both better-sqlite3 and bun:sqlite expose this with compatible signatures.
   * Returns a function that, when called, runs the callback inside BEGIN/COMMIT.
   */
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  loadExtension(path: string): void;
  close(): void;
}

export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Load the sqlite-vec extension into a database.
 */
export function loadSqliteVec(db: Database): void {
  _sqliteVecLoad(db);
}
