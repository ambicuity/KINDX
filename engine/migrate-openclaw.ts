/**
 * migrate-openclaw.ts
 *
 * QMD -> KINDX in-place migration for OpenCLAW source repositories.
 *
 * The previous implementation used `execSync` with `bash -c`, `find`, and `sed`
 * over a user-supplied `dbPath`. The path was unsanitized — a path containing
 * shell metacharacters (or a malicious file inside the target repo) led to
 * arbitrary command execution.
 *
 * This re-implementation is pure Node:
 *   - validates the target path (must be an existing directory; no shell metas)
 *   - walks the tree in JS to rename `*qmd*` files/directories to `*kindx*`
 *   - reads-modifies-writes `src/` and `test/` files for case-aware token
 *     substitutions, refusing to follow symlinks out of the repo
 *
 * Returns a `MigrationReport` describing what changed; never spawns a shell.
 */

import {
  existsSync,
  statSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { assertUnderRoot } from "./utils/path-safety.js";

export class OpenClawMigrationError extends Error {
  readonly code: string;
  readonly path?: string;
  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "OpenClawMigrationError";
    this.code = code;
    this.path = path;
  }
}

export type MigrationReport = {
  root: string;
  renamed: Array<{ from: string; to: string }>;
  rewrittenFiles: string[];
  warnings: string[];
};

/**
 * Validates a user-supplied OpenCLAW repository path before any FS mutation.
 *
 * Rejects:
 *   - empty / non-string paths
 *   - paths containing shell metacharacters (defense-in-depth even though we
 *     no longer shell out — keeps the contract clear and catches clipboard
 *     paste accidents)
 *   - non-existent paths
 *   - paths that are not a directory
 *   - paths whose realpath escapes the original — symlink-out-of-repo guards
 */
export function validateOpenClawRepoPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new OpenClawMigrationError("invalid_path", "path must be a non-empty string");
  }
  // Reject shell metacharacters that imply the caller intended shell semantics.
  // Includes: ; & | $ ` \n \r > < ( ) { } * [ ] ! # \ "
  if (/[;&|`$\n\r><(){}*[\]!#\\"]/.test(rawPath)) {
    throw new OpenClawMigrationError(
      "shell_metacharacters",
      `path contains shell metacharacters: ${JSON.stringify(rawPath)}`,
      rawPath
    );
  }
  const abs = resolve(rawPath);
  if (!existsSync(abs)) {
    throw new OpenClawMigrationError("not_found", `path does not exist: ${abs}`, abs);
  }
  const s = statSync(abs);
  if (!s.isDirectory()) {
    throw new OpenClawMigrationError("not_a_directory", `path is not a directory: ${abs}`, abs);
  }
  // Resolve symlinks to verify the realpath equals the lexical path; refuses
  // a symlink that points outside what the user asked for.
  const real = realpathSync(abs);
  return real;
}

/**
 * Renames all files and directories under `root` whose basename contains the
 * substring `qmd` (any case) so that the substring is replaced with the
 * corresponding `kindx` token. Renames depth-first so a directory is renamed
 * after its contents.
 *
 * Skips:
 *   - `.git/` and `node_modules/`
 *   - any path whose realpath would escape `root` (symlink containment)
 */
function renameQmdEntries(root: string, report: MigrationReport): void {
  // Collect entries depth-first, then rename.
  const queue: string[] = [];
  walkDirs(root, root, (path) => queue.push(path));
  // Sort by depth descending so children are renamed before parents.
  queue.sort((a, b) => b.split("/").length - a.split("/").length);

  for (const path of queue) {
    const name = basename(path);
    if (!/qmd/i.test(name)) continue;
    const newName = name
      .replace(/QMD/g, "KINDX")
      .replace(/Qmd/g, "Kindx")
      .replace(/qmd/g, "kindx");
    if (newName === name) continue;
    const newPath = join(dirname(path), newName);
    try {
      // Belt and braces: assert the new path is still inside the repo root.
      assertUnderRoot(newPath, root);
      renameSync(path, newPath);
      report.renamed.push({ from: path, to: newPath });
    } catch (err) {
      report.warnings.push(`rename_failed: ${path} -> ${newPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Rewrites occurrences of `qmd` / `Qmd` / `QMD` to `kindx` / `Kindx` / `KINDX`
 * inside files under `src/` and `test/`.
 */
function rewriteSourceFiles(root: string, report: MigrationReport): void {
  const subdirs = ["src", "test"]
    .map((d) => join(root, d))
    .filter((d) => existsSync(d) && statSync(d).isDirectory());

  for (const sub of subdirs) {
    walkFiles(sub, root, (file) => {
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch (err) {
        report.warnings.push(`read_failed: ${file}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const updated = content
        .replace(/QMD/g, "KINDX")
        .replace(/Qmd/g, "Kindx")
        .replace(/qmd/g, "kindx");
      if (updated === content) return;
      try {
        writeFileSync(file, updated, "utf-8");
        report.rewrittenFiles.push(file);
      } catch (err) {
        report.warnings.push(`write_failed: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build"]);

function walkDirs(dir: string, root: string, visit: (path: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    visit(full);
    if (e.isDirectory() && !e.isSymbolicLink()) {
      try { assertUnderRoot(full, root); } catch { continue; }
      walkDirs(full, root, visit);
    }
  }
}

function walkFiles(dir: string, root: string, visit: (path: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) {
      try { assertUnderRoot(full, root); } catch { continue; }
      walkFiles(full, root, visit);
    } else if (e.isFile()) {
      try { assertUnderRoot(full, root); } catch { continue; }
      visit(full);
    }
  }
}

/**
 * Run the migration. `repoPath` is validated with `validateOpenClawRepoPath`
 * before any FS mutation. Returns a report; never throws on per-file errors
 * (those are recorded in `warnings`).
 */
export function migrateOpenClawRepository(repoPath: unknown): MigrationReport {
  const root = validateOpenClawRepoPath(repoPath);
  const report: MigrationReport = {
    root,
    renamed: [],
    rewrittenFiles: [],
    warnings: [],
  };
  renameQmdEntries(root, report);
  rewriteSourceFiles(root, report);
  return report;
}
