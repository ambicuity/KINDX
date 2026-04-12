/**
 * backup-command.ts — Extracted backup CLI handler from kindx.ts
 *
 * Dispatches backup create/verify/restore subcommands.
 */
import { dirname } from "path";
import type { OutputFormat } from "../renderer.js";
import { createBackup, restoreBackup, verifyBackup } from "../backup.js";
import { getDefaultBackupName } from "../diagnostics.js";
import { resolve } from "path";
import { c, formatBytes } from "../utils/ui.js";

export function runBackupCommand(
  args: string[],
  values: Record<string, unknown>,
  output: OutputFormat,
  dbPath: string,
): number {
  const sub = args[0];

  if (sub === "create") {
    const requested = typeof values.path === "string" ? values.path : args[1];
    const backupPath = requested || resolve(dirname(dbPath), getDefaultBackupName(dbPath));
    const result = createBackup(dbPath, backupPath);
    if (output === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${c.green}✓${c.reset} Backup created: ${result.backupPath}`);
      console.log(`  Size: ${formatBytes(result.bytes)}`);
      console.log(`  WAL checkpoint: ${result.checkpointed ? "yes" : "no"}`);
      console.log(`  Encrypted: ${result.encrypted ? "yes" : "no"}`);
    }
    return 0;
  }

  if (sub === "verify") {
    const pathArg = typeof values.path === "string" ? values.path : args[1];
    if (!pathArg) {
      console.error("Usage: kindx backup verify <backup-file>");
      return 1;
    }
    const result = verifyBackup(pathArg);
    if (output === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.integrity === "ok") {
      console.log(`${c.green}✓${c.reset} Backup verified: ${result.backupPath}`);
      console.log(`  Size: ${formatBytes(result.bytes)}`);
      console.log(`  Encrypted: ${result.encrypted ? "yes" : "no"}${result.keyRequired ? " (key required)" : ""}`);
    } else {
      console.error(`${c.yellow}!${c.reset} Backup verify failed: ${result.detail}`);
    }
    return result.integrity === "ok" ? 0 : 2;
  }

  if (sub === "restore") {
    const pathArg = typeof values.path === "string" ? values.path : args[1];
    if (!pathArg) {
      console.error("Usage: kindx backup restore <backup-file> [--force]");
      return 1;
    }
    const force = values.force === true || values.force === "true";
    const result = restoreBackup(pathArg, dbPath, Boolean(force));
    if (output === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${c.green}✓${c.reset} Restored backup to ${result.restoredTo}`);
    }
    return 0;
  }

  console.error("Usage: kindx backup <create|verify|restore> [path] [--force]");
  return 1;
}
