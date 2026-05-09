/**
 * atomic-write.ts
 *
 * Crash-safe file write: temp file -> fsync -> rename -> dir fsync.
 *
 * Extracted from rbac.ts, catalogs.ts, encryption.ts, and sharding.ts which
 * each rolled the same pattern in-line. The previous duplication made it
 * easy for one site to drift (e.g. forget the dir fsync, or skip mode 0o600
 * on a credentials file) without anyone noticing.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type AtomicWriteOps = {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
};

const defaultOps: AtomicWriteOps = {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
};

export type AtomicWriteOptions = {
  /**
   * POSIX mode for the destination file. Defaults to 0o644.
   * Use 0o600 for files containing secrets (tokens, keys).
   */
  mode?: number;
  /**
   * Create the parent directory if it does not exist. Defaults to true.
   */
  ensureDir?: boolean;
  /**
   * Skip the parent-directory fsync. Defaults to false. Only set to true
   * for ephemeral / test paths where fsync would be misleading.
   */
  skipDirSync?: boolean;
  /**
   * Injected fs ops, primarily for testing. Defaults to the real syscalls.
   */
  ops?: Partial<AtomicWriteOps>;
};

/**
 * Atomically write `data` to `path`. On crash at any point, `path` is either
 * the previous content or the new content — never partial.
 *
 * Implementation: writes to `${path}.tmp.<pid>.<rand>`, fsyncs the file,
 * renames over the destination, then fsyncs the parent directory.
 *
 * Throws if the write or rename fails. Cleans up the temp file on failure.
 */
export function atomicWriteFile(
  path: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): void {
  const ops: AtomicWriteOps = { ...defaultOps, ...(options.ops ?? {}) };
  const mode = options.mode ?? 0o644;
  const ensureDir = options.ensureDir ?? true;
  const skipDirSync = options.skipDirSync ?? false;

  const dir = dirname(path);
  if (ensureDir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Random suffix prevents collisions on concurrent atomic writes to the same path.
  const tempPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;

  let fd: number | null = null;
  let renamed = false;
  try {
    fd = ops.openSync(tempPath, "w", mode);
    ops.writeSync(fd, data as any, null, "utf8" as any);
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = null;

    ops.renameSync(tempPath, path);
    renamed = true;
  } finally {
    if (fd !== null) {
      try { ops.closeSync(fd); } catch { /* noop */ }
    }
    if (!renamed) {
      try { ops.unlinkSync(tempPath); } catch { /* noop — temp may not exist */ }
    }
  }

  if (!skipDirSync) {
    syncDir(dir, ops);
  }
}

function syncDir(dir: string, ops: AtomicWriteOps): void {
  let dirFd: number | null = null;
  try {
    dirFd = ops.openSync(dir, "r");
    ops.fsyncSync(dirFd);
  } catch {
    // Some platforms / filesystems (Windows, some FUSE mounts) cannot fsync a
    // directory. Best-effort — the rename is still durable on most common
    // platforms (ext4/xfs/apfs) without it, and on the rest we have no recourse.
  } finally {
    if (dirFd !== null) {
      try { ops.closeSync(dirFd); } catch { /* noop */ }
    }
  }
}
