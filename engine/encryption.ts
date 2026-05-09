import { copyFileSync, existsSync, readFileSync, readSync, writeSync, renameSync, statSync, unlinkSync, readdirSync, openSync, closeSync, fsyncSync } from "node:fs";
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
  // Tier-1: read only the first 16 bytes via open+read so we don't slurp
  // multi-GB shard DBs into memory just to inspect the header. The previous
  // readFileSync allocated a Buffer the size of the whole file, then threw
  // 99.999% of it away. ensureEncryptedShardIndexesReady calls this in a
  // walk over every shard — at scale this OOMed the process.
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const bytesRead = readSync(fd, buf, 0, 16, 0);
    if (bytesRead < 16) return true; // too small to be a valid plaintext sqlite db
    return buf.toString("ascii") !== "SQLite format 3\u0000";
  } finally {
    try { closeSync(fd); } catch { /* noop */ }
  }
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

  // Sweep stale plaintext backups left by aborted prior runs (older than 24h).
  cleanupStalePlaintextBackups(path);

  let backupPath: string | null = null;
  try {
    backupPath = `${path}.plaintext.backup.${Date.now()}`;
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

    if (isLikelyEncryptedSqlite(path)) {
      // Rekey succeeded — the backup is now an unencrypted COPY of the index
      // sitting next to the encrypted file. Defeats encryption-at-rest if
      // left in place. Delete it (best-effort).
      removePlaintextBackup(backupPath);
      backupPath = null;
      return;
    }

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

    // Export-fallback path also succeeds here — drop the plaintext backup.
    if (backupPath) {
      removePlaintextBackup(backupPath);
      backupPath = null;
    }
  } finally {
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
  }
}

/**
 * Removes a plaintext backup created during the rekey flow. Best-effort: a
 * failure to unlink (e.g. file held open on Windows) is logged via quietWarn
 * so the operator can find and shred it manually rather than discovering it
 * months later.
 */
function removePlaintextBackup(backupPath: string): void {
  try {
    if (existsSync(backupPath)) unlinkSync(backupPath);
  } catch (err) {
    process.stderr.write(
      `KINDX Warning: failed to delete plaintext backup ${backupPath}: ${
        err instanceof Error ? err.message : String(err)
      }. Encryption-at-rest is compromised until this file is removed manually.\n`
    );
  }
}

/**
 * Sweeps `*.plaintext.backup.<ts>` files older than 24h next to `path`.
 * Defends against operators who upgraded across the fix and still have stale
 * backups from before the deletion logic existed, or who hit a crash after
 * the backup was created but before the rekey completed.
 */
export const STALE_BACKUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function cleanupStalePlaintextBackups(indexPath: string): void {
  const dir = dirname(indexPath);
  const prefix = `${indexPath}.plaintext.backup.`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  const baseName = indexPath.split("/").pop() ?? indexPath;
  const wanted = `${baseName}.plaintext.backup.`;
  for (const name of entries) {
    if (!name.startsWith(wanted)) continue;
    const full = `${dir}/${name}`;
    void prefix; // (silence unused warning if linter is picky)
    try {
      const s = statSync(full);
      if (now - s.mtimeMs < STALE_BACKUP_THRESHOLD_MS) continue;
      unlinkSync(full);
      process.stderr.write(`KINDX Cleanup: removed stale plaintext backup ${full}\n`);
    } catch {
      // Ignore; the operator will see it on next sweep.
    }
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
