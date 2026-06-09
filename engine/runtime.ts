/**
 * runtime.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under both Bun (bun:sqlite)
 * and Node.js (better-sqlite3). The APIs are nearly identical — the main
 * difference is the import path.
 */

// Detect Bun runtime without importing bun:sqlite at compile time.
// globalThis.Bun is set by the Bun runtime; checking with typeof avoids ReferenceError on Node.
export const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

let _Database: any;
let _sqliteVecLoad: (db: any) => void;
let _sqliteDriverName = "unknown";

const SQLITE_STDOUT_NOISE = "Not searching for unused variables given on the command line.";
let _sqliteStdoutNoiseFilterInstalled = false;

function withSuppressedSqliteStdoutNoise<T>(fn: () => T): T {
  const stream = process.stdout as NodeJS.WriteStream & { write: (...args: any[]) => any };
  const originalWrite = stream.write.bind(stream);
  const filteredWrite = ((chunk: any, encoding?: any, cb?: any) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString(encoding || "utf8") : null;
    if (text && text.includes(SQLITE_STDOUT_NOISE)) {
      const cleaned = text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== SQLITE_STDOUT_NOISE)
        .join("\n");
      if (!cleaned.trim()) {
        if (typeof cb === "function") cb();
        return true;
      }
      return originalWrite(cleaned, encoding, cb);
    }
    return originalWrite(chunk, encoding, cb);
  }) as typeof stream.write;
  stream.write = filteredWrite;
  try {
    return fn();
  } finally {
    stream.write = originalWrite;
  }
}

/**
 * Install (idempotent) the stdout filter that swallows the harmless SQLite
 * "extension already loaded" line printed by sqlite-vec.
 *
 * Returns an `uninstall()` callback that restores `process.stdout.write` to
 * its original implementation. Required for tests + embeddable contexts —
 * the previous implementation permanently monkey-patched stdout for the
 * lifetime of the process and provided no way to remove the filter.
 */
let _uninstallSqliteStdoutNoiseFilter: (() => void) | null = null;
export function installSqliteStdoutNoiseFilter(): () => void {
  if (_sqliteStdoutNoiseFilterInstalled) {
    return _uninstallSqliteStdoutNoiseFilter ?? (() => { /* noop */ });
  }
  const stream = process.stdout as NodeJS.WriteStream & { write: (...args: any[]) => any };
  if (!stream || typeof stream.write !== "function") return () => { /* noop */ };
  const originalWrite = stream.write.bind(stream);
  const filteredWrite = ((chunk: any, encoding?: any, cb?: any) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString(encoding || "utf8") : null;
    if (text && text.includes(SQLITE_STDOUT_NOISE)) {
      const cleaned = text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== SQLITE_STDOUT_NOISE)
        .join("\n");
      if (!cleaned.trim()) {
        if (typeof cb === "function") cb();
        return true;
      }
      return originalWrite(cleaned, encoding, cb);
    }
    return originalWrite(chunk, encoding, cb);
  }) as typeof stream.write;
  stream.write = filteredWrite;
  _sqliteStdoutNoiseFilterInstalled = true;
  _uninstallSqliteStdoutNoiseFilter = () => {
    if (stream.write === filteredWrite) {
      stream.write = originalWrite;
    }
    _sqliteStdoutNoiseFilterInstalled = false;
    _uninstallSqliteStdoutNoiseFilter = null;
  };
  return _uninstallSqliteStdoutNoiseFilter;
}

if (isBun) {
  // Dynamic string prevents tsc from resolving bun:sqlite on Node.js builds
  const bunSqlite = "bun:" + "sqlite";
  _Database = (await import(/* @vite-ignore */ bunSqlite)).Database;
  _sqliteDriverName = "bun:sqlite";
  const { getLoadablePath } = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => db.loadExtension(getLoadablePath());
} else {
  installSqliteStdoutNoiseFilter();
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
  const db = withSuppressedSqliteStdoutNoise(() => new _Database(path) as Database);
  // 30000ms matches the documented storage-layer baseline (see initializeDatabase
  // and ensureShardSchema). The previous 15000ms default left memory-only
  // callers, raw shard openers, and test helpers with half the lock-wait
  // budget of the main store — visible as flaky SQLITE_BUSY under
  // concurrent watcher writes.
  db.exec("PRAGMA busy_timeout = 30000;");
  const key = process.env.KINDX_ENCRYPTION_KEY?.trim();
  if (key) {
    // Tier-1: validate the key shape before SQL interpolation. The key is
    // injected into a raw `PRAGMA key = '<key>'` statement (no parameter
    // binding for PRAGMAs). Single quotes are doubled, but a key containing
    // a NUL byte, backslash, or control character can desync the SQLite
    // parser or produce a confusing error far from the root cause.
    // Restrict to printable ASCII (0x21-0x7E), 16..256 bytes long.
    if (!/^[\x21-\x7E]{16,256}$/.test(key)) {
      throw new Error(
        "KINDX_ENCRYPTION_KEY must be 16..256 printable ASCII characters " +
        "(no NUL, control chars, whitespace, or quotes). Use a hex/base64 string."
      );
    }
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
  const pragmaDb = db as Database & {
    pragma?: (source: string, options?: { simple?: boolean }) => unknown;
  };

  if (typeof pragmaDb.pragma === "function") {
    try {
      const cipher = pragmaDb.pragma("cipher", { simple: true });
      if (typeof cipher === "string" && cipher.trim().length > 0) return true;
    } catch {
      // Fall through to statement-based probes.
    }

    try {
      const version = pragmaDb.pragma("cipher_version", { simple: true });
      if (typeof version === "string" && version.trim().length > 0) return true;
    } catch {
      // Fall through to statement-based probes.
    }
  }

  try {
    const rows = db.prepare("PRAGMA cipher").all();
    if (!Array.isArray(rows) || rows.length === 0) return false;
    return Object.values(rows[0] as Record<string, unknown>).some(
      (value) => typeof value === "string" && value.trim().length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Common subset of the Database interface used throughout KINDX.
 *
 * `open` and `inTransaction` are exposed so callers don't have to `as any`
 * to inspect connection lifecycle (used by withTransaction reentrancy and
 * the WAL/SHM sidecar cleanup guard). Both better-sqlite3 and bun:sqlite
 * surface these properties on the instance; declared optional so future
 * drivers without them are still type-compatible.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  pragma?(source: string, options?: { simple?: boolean }): unknown;
  /**
   * Wrap a callback in a SQLite transaction.
   * Both better-sqlite3 and bun:sqlite expose this with compatible signatures.
   * Returns a function that, when called, runs the callback inside BEGIN/COMMIT.
   */
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  loadExtension(path: string): void;
  close(): void;
  readonly open?: boolean;
  readonly inTransaction?: boolean;
}

export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  iterate(...params: any[]): IterableIterator<any>;
}

/**
 * Load the sqlite-vec extension into a database.
 */
export function loadSqliteVec(db: Database): void {
  _sqliteVecLoad(db);
}
