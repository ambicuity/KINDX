import { copyFileSync, existsSync, readFileSync, writeSync, renameSync, statSync, unlinkSync, readdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase, supportsSqlCipherPragma } from "./runtime.js";
import { checkDatabaseIntegrity } from "./diagnostics.js";

type DirectorySyncOps = {
  openSync: (path: string, flags: string) => number;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
};

const defaultDirectorySyncOps: DirectorySyncOps = {
  openSync,
  fsyncSync,
  closeSync,
};

function sqliteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function isLikelyEncryptedSqlite(path: string): boolean {
  if (!existsSync(path)) return false;
  const header = readFileSync(path, { encoding: null }).subarray(0, 16);
  const ascii = header.toString("ascii");
  return ascii !== "SQLite format 3\u0000";
}

export function isRuntimeEncryptionEnabled(): boolean {
  const key = process.env.KINDX_ENCRYPTION_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

function openWithoutRuntimeKey(path: string) {
  const existing = process.env.KINDX_ENCRYPTION_KEY;
  try {
    delete process.env.KINDX_ENCRYPTION_KEY;
    return openDatabase(path);
  } finally {
    if (existing !== undefined) process.env.KINDX_ENCRYPTION_KEY = existing;
  }
}

export function syncParentDirectoryAfterRename(path: string, ops: DirectorySyncOps = defaultDirectorySyncOps): void {
  let dirFd: number | null = null;
  try {
    dirFd = ops.openSync(dirname(path), "r");
    ops.fsyncSync(dirFd);
  } catch {
    // Ignored for OS combinations that do not support directory fsync.
  } finally {
    if (dirFd !== null) {
      try { ops.closeSync(dirFd); } catch {}
    }
  }
}

export function ensureEncryptedIndexReady(indexPath: string): void {
  const key = process.env.KINDX_ENCRYPTION_KEY?.trim();
  if (!key) return;
  const path = resolve(indexPath);
  if (!existsSync(path)) return;
  if (isLikelyEncryptedSqlite(path)) return;

  const lockPath = `${path}.rekey.lock`;
  let lockAcquired = false;
  try {
    const fd = openSync(lockPath, 'wx');
    // F-ENC-1: Store PID in lock file for live-process detection
    try { writeSync(fd, String(process.pid)); } catch {}
    closeSync(fd);
    lockAcquired = true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      try {
        const stats = statSync(lockPath);
        // F-ENC-1: Check if the lock-holding PID is still alive before using mtime fallback
        let ownerAlive = false;
        try {
          const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
          if (Number.isFinite(lockPid) && lockPid > 0) {
            try {
              process.kill(lockPid, 0); // Signal 0: existence check, no actual signal sent
              ownerAlive = true;
            } catch {
              ownerAlive = false; // Process does not exist — stale lock
            }
          }
        } catch {
          // Can't read PID — fall through to mtime check
        }

        if (!ownerAlive && Date.now() - stats.mtimeMs > 60000) {
          unlinkSync(lockPath);
          const fd = openSync(lockPath, 'wx');
          try { writeSync(fd, String(process.pid)); } catch {}
          closeSync(fd);
          lockAcquired = true;
        }
      } catch {
        // Fall back if stat/unlink fails
      }
      if (!lockAcquired) {
        process.stderr.write(`KINDX Warning: Another process is currently encrypting the database at ${path}. Skipping and yielding to background.\n`);
        return;
      }
    } else {
      throw err;
    }
  }

  try {
    const backupPath = `${path}.plaintext.backup.${Date.now()}`;
    const tempEncrypted = `${path}.enc.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    
    // Safe backup: VACUUM INTO creates a consistent backup and handles WAL properly.
    const initialDb = openWithoutRuntimeKey(path);
    try {
      initialDb.exec(`VACUUM INTO ${sqliteLiteral(backupPath)}`);
    } finally {
      initialDb.close();
    }

    let rekeyFailed = false;
    const plainDb = openWithoutRuntimeKey(path);
    try {
      if (!supportsSqlCipherPragma(plainDb)) {
        throw new Error("sqlcipher_pragma_unavailable");
      }

      // Preferred path: in-place encryption via rekey (supported by SQLCipher and SQLite3 Multiple Ciphers).
      plainDb.exec(`PRAGMA rekey = ${sqliteLiteral(key)}`);
    } catch (err) {
      rekeyFailed = true;
      process.stderr.write(`KINDX Warning: In-place PRAGMA rekey failed (${err instanceof Error ? err.message : String(err)}). Yielding to fallback migration.\n`);
    } finally {
      plainDb.close();
    }

    if (rekeyFailed) {
      copyFileSync(backupPath, path);
    }

    if (isLikelyEncryptedSqlite(path)) return;

    // Compatibility fallback for runtimes that require export-based conversion.
    const exportDb = openWithoutRuntimeKey(path);
    try {
      // Secure an exclusive lock and flush the WAL to prevent concurrent writers
      // from committing data to a WAL that is about to be unlinked.
      exportDb.exec("PRAGMA locking_mode = EXCLUSIVE");
      exportDb.exec("BEGIN EXCLUSIVE");
      exportDb.exec("COMMIT");
      exportDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      exportDb.exec(`ATTACH DATABASE ${sqliteLiteral(tempEncrypted)} AS encrypted KEY ${sqliteLiteral(key)}`);
      try {
        exportDb.exec(`SELECT sqlcipher_export('encrypted')`);
      } catch (sqlcipherErr) {
        if (sqlcipherErr instanceof Error && sqlcipherErr.message.includes("no such function: sqlcipher_export")) {
          exportDb.exec(`SELECT sqlite3mc_export('encrypted')`);
        } else {
          throw sqlcipherErr;
        }
      }
      exportDb.exec(`DETACH DATABASE encrypted`);
    } catch (err) {
      try { exportDb.exec(`DETACH DATABASE encrypted`); } catch {}
      throw new Error(
        `Failed to auto-migrate index to encrypted storage. ` +
        `This runtime likely lacks SQLCipher support. ` +
        `Set KINDX_ENCRYPTION_KEY only on SQLCipher-enabled builds. Root cause: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      exportDb.close();
      try {
        if (existsSync(tempEncrypted) && !isLikelyEncryptedSqlite(tempEncrypted)) unlinkSync(tempEncrypted);
      } catch {}
    }

    const encryptedDb = openDatabase(tempEncrypted);
    try {
      const integrity = checkDatabaseIntegrity(encryptedDb);
      if (!integrity.ok) {
        throw new Error(`encrypted_db_integrity_failed:${integrity.result}`);
      }
    } finally {
      encryptedDb.close();
    }

    const wal = `${path}-wal`;
    const shm = `${path}-shm`;
    if (existsSync(wal)) unlinkSync(wal);
    if (existsSync(shm)) unlinkSync(shm);
    renameSync(tempEncrypted, path);

    // F-002: Ensure atomic configuration management via POSIX fsync.
    syncParentDirectoryAfterRename(path);
  } finally {
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
  }
}

export function ensureEncryptedShardIndexesReady(mainIndexPath: string): void {
  const key = process.env.KINDX_ENCRYPTION_KEY?.trim();
  if (!key) return;
  const root = resolve(dirname(mainIndexPath), "shards");
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, name.name);
      if (name.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (name.isFile() && name.name.endsWith(".sqlite")) {
        ensureEncryptedIndexReady(full);
      }
    }
  }
}

export function describeEncryptionState(path: string): {
  encrypted: boolean;
  keyConfigured: boolean;
  bytes: number;
} {
  const target = resolve(path);
  return {
    encrypted: isLikelyEncryptedSqlite(target),
    keyConfigured: isRuntimeEncryptionEnabled(),
    bytes: existsSync(target) ? statSync(target).size : 0,
  };
}
