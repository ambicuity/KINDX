import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "./runtime.js";
import { checkDatabaseIntegrity } from "./diagnostics.js";
import { describeEncryptionState, isLikelyEncryptedSqlite, isRuntimeEncryptionEnabled } from "./encryption.js";

export type BackupCreateResult = {
  backupPath: string;
  bytes: number;
  checkpointed: boolean;
  encrypted: boolean;
};

export type BackupVerifyResult = {
  backupPath: string;
  exists: boolean;
  bytes: number;
  integrity: "ok" | "failed";
  detail: string;
  encrypted: boolean;
  keyRequired: boolean;
};

export function createBackup(indexPath: string, outputPath: string): BackupCreateResult {
  const db = openDatabase(indexPath);
  let checkpointed = false;
  const target = resolve(outputPath);

  try {
    try {
      db.exec("PRAGMA wal_checkpoint(FULL)");
      checkpointed = true;
    } catch {
      checkpointed = false;
    }

    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      unlinkSync(target); // VACUUM INTO requires the target to not exist
    }
    // Safe atomic snapshot:
    const safeTargetPath = target.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safeTargetPath}'`);
  } finally {
    db.close();
  }

  const bytes = statSync(target).size;
  return { backupPath: target, bytes, checkpointed, encrypted: isLikelyEncryptedSqlite(target) };
}

export function verifyBackup(backupPath: string): BackupVerifyResult {
  const target = resolve(backupPath);
  if (!existsSync(target)) {
    return {
      backupPath: target,
      exists: false,
      bytes: 0,
      integrity: "failed",
      detail: "file_not_found",
      encrypted: false,
      keyRequired: false,
    };
  }

  const bytes = statSync(target).size;
  const encrypted = isLikelyEncryptedSqlite(target);
  if (encrypted && !isRuntimeEncryptionEnabled()) {
    return {
      backupPath: target,
      exists: true,
      bytes,
      integrity: "failed",
      detail: "encrypted_backup_requires_kindx_encryption_key",
      encrypted: true,
      keyRequired: true,
    };
  }
  const db = openDatabase(target);
  try {
    const integrity = checkDatabaseIntegrity(db);
    return {
      backupPath: target,
      exists: true,
      bytes,
      integrity: integrity.ok ? "ok" : "failed",
      detail: integrity.result,
      encrypted,
      keyRequired: encrypted,
    };
  } finally {
    db.close();
  }
}

export function restoreBackup(backupPath: string, indexPath: string, force: boolean = false): { restoredTo: string } {
  const source = resolve(backupPath);
  const target = resolve(indexPath);

  if (!existsSync(source)) {
    throw new Error(`Backup not found: ${source}`);
  }
  const sourceEncrypted = isLikelyEncryptedSqlite(source);
  const runtimeEncrypted = isRuntimeEncryptionEnabled();
  if (sourceEncrypted && !runtimeEncrypted) {
    throw new Error("Backup is encrypted. Set KINDX_ENCRYPTION_KEY before restore.");
  }
  if (!sourceEncrypted && runtimeEncrypted) {
    throw new Error(
      "Backup is plaintext but KINDX_ENCRYPTION_KEY is set. " +
      "Unset key to restore plaintext backup, then re-run migration with key."
    );
  }

  if (existsSync(target) && !force) {
    throw new Error(`Target already exists: ${target}. Pass --force to overwrite.`);
  }

  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    unlinkSync(target);
  }

  const wal = `${target}-wal`;
  const shm = `${target}-shm`;
  if (existsSync(wal)) unlinkSync(wal);
  if (existsSync(shm)) unlinkSync(shm);

  copyFileSync(source, target);
  const enc = describeEncryptionState(target);
  if (enc.encrypted && !enc.keyConfigured) {
    throw new Error("Restored encrypted backup but no KINDX_ENCRYPTION_KEY is configured.");
  }
  return { restoredTo: target };
}
