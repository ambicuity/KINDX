import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase, supportsSqlCipherPragma } from "./runtime.js";
import { checkDatabaseIntegrity } from "./diagnostics.js";

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

export function ensureEncryptedIndexReady(indexPath: string): void {
  const key = process.env.KINDX_ENCRYPTION_KEY?.trim();
  if (!key) return;
  const path = resolve(indexPath);
  if (!existsSync(path)) return;
  if (isLikelyEncryptedSqlite(path)) return;

  const backupPath = `${path}.plaintext.backup.${Date.now()}`;
  const tempEncrypted = `${path}.enc.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(path, backupPath);

  const plainDb = openWithoutRuntimeKey(path);
  try {
    if (!supportsSqlCipherPragma(plainDb)) {
      throw new Error("sqlcipher_pragma_unavailable");
    }

    // Preferred path: in-place encryption via rekey (supported by SQLCipher and SQLite3 Multiple Ciphers).
    plainDb.exec(`PRAGMA rekey = ${sqliteLiteral(key)}`);
  } catch (err) {
    throw new Error(
      `Failed to auto-migrate index to encrypted storage. ` +
      `This runtime likely lacks SQLCipher support. ` +
      `Set KINDX_ENCRYPTION_KEY only on SQLCipher-enabled builds. Root cause: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    plainDb.close();
  }

  if (isLikelyEncryptedSqlite(path)) return;

  // Compatibility fallback for runtimes that require export-based conversion.
  const exportDb = openWithoutRuntimeKey(path);
  try {
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
