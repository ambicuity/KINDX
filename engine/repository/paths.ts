// Extracted from engine/repository.ts as part of W1 decomposition (C2).
// Pure path utilities — no dependencies on storage or retrieval modules.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5
//
// Note: virtual-path utilities (VirtualPath, parseVirtualPath, resolveVirtualPath, etc.)
// remain in engine/repository.ts for now because resolveVirtualPath depends on
// getCollectionByName, which has not been extracted yet. They will move with
// the collections cluster.

import { mkdirSync, realpathSync } from "node:fs";

const HOME = process.env.HOME || "/tmp";

export function homedir(): string {
  return HOME;
}

/**
 * Check if a path is absolute.
 * Supports:
 * - Unix paths: /path/to/file
 * - Windows native: C:\path or C:/path
 * - Git Bash: /c/path or /C/path (C-Z drives, excluding A/B floppy drives)
 *
 * Note: /c without trailing slash is treated as Unix path (directory named "c"),
 * while /c/ or /c/path are treated as Git Bash paths (C: drive).
 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false;

  // Unix absolute path
  if (path.startsWith('/')) {
    // Check if it's a Git Bash style path like /c/ or /c/Users (C-Z only, not A or B)
    // Requires path[2] === '/' to distinguish from Unix paths like /c or /cache
    if (path.length >= 3 && path[2] === '/') {
      const driveLetter = path[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        return true;
      }
    }
    // Any other path starting with / is Unix absolute
    return true;
  }

  // Windows native path: C:\ or C:/ (any letter A-Z)
  if (path.length >= 2 && /[a-zA-Z]/.test(path[0]!) && path[1] === ':') {
    return true;
  }

  return false;
}

/**
 * Normalize path separators to forward slashes.
 * Converts Windows backslashes to forward slashes.
 */
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Get the relative path from a prefix.
 * Returns null if path is not under prefix.
 * Returns empty string if path equals prefix.
 */
export function getRelativePathFromPrefix(path: string, prefix: string): string | null {
  if (!prefix) {
    return null;
  }

  const normalizedPath = normalizePathSeparators(path);
  const normalizedPrefix = normalizePathSeparators(prefix);

  const prefixWithSlash = !normalizedPrefix.endsWith('/')
    ? normalizedPrefix + '/'
    : normalizedPrefix;

  if (normalizedPath === normalizedPrefix) {
    return '';
  }

  if (normalizedPath.startsWith(prefixWithSlash)) {
    return normalizedPath.slice(prefixWithSlash.length);
  }

  return null;
}

export function resolve(...paths: string[]): string {
  if (paths.length === 0) {
    throw new Error("resolve: at least one path segment is required");
  }

  const normalizedPaths = paths.map(normalizePathSeparators);

  let result = '';
  let windowsDrive = '';

  const firstPath = normalizedPaths[0]!;
  if (isAbsolutePath(firstPath)) {
    result = firstPath;

    if (firstPath.length >= 2 && /[a-zA-Z]/.test(firstPath[0]!) && firstPath[1] === ':') {
      windowsDrive = firstPath.slice(0, 2);
      result = firstPath.slice(2);
    } else if (firstPath.startsWith('/') && firstPath.length >= 3 && firstPath[2] === '/') {
      const driveLetter = firstPath[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        windowsDrive = driveLetter.toUpperCase() + ':';
        result = firstPath.slice(2);
      }
    }
  } else {
    const pwd = normalizePathSeparators(process.env.PWD || process.cwd());

    if (pwd.length >= 2 && /[a-zA-Z]/.test(pwd[0]!) && pwd[1] === ':') {
      windowsDrive = pwd.slice(0, 2);
      result = pwd.slice(2) + '/' + firstPath;
    } else {
      result = pwd + '/' + firstPath;
    }
  }

  for (let i = 1; i < normalizedPaths.length; i++) {
    const p = normalizedPaths[i]!;
    if (isAbsolutePath(p)) {
      result = p;

      if (p.length >= 2 && /[a-zA-Z]/.test(p[0]!) && p[1] === ':') {
        windowsDrive = p.slice(0, 2);
        result = p.slice(2);
      } else if (p.startsWith('/') && p.length >= 3 && p[2] === '/') {
        const driveLetter = p[1];
        if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
          windowsDrive = driveLetter.toUpperCase() + ':';
          result = p.slice(2);
        } else {
          windowsDrive = '';
        }
      } else {
        windowsDrive = '';
      }
    } else {
      result = result + '/' + p;
    }
  }

  const parts = result.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.') {
      normalized.push(part);
    }
  }

  const finalPath = '/' + normalized.join('/');

  if (windowsDrive) {
    return windowsDrive + finalPath;
  }

  return finalPath;
}

// Flag to indicate production mode (set by kindx.ts at startup).
// Module-level state intentionally co-located with the only function that reads it.
let _productionMode = false;

export function enableProductionMode(): void {
  _productionMode = true;
}

export function getDefaultDbPath(indexName: string = "index"): string {
  if (process.env.INDEX_PATH) {
    return process.env.INDEX_PATH;
  }

  if (!_productionMode) {
    throw new Error(
      "Database path not set. Tests must set INDEX_PATH env var or use createStore() with explicit path. " +
      "This prevents tests from accidentally writing to the global index."
    );
  }

  const cacheDir = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const qmdCacheDir = resolve(cacheDir, "kindx");
  try { mkdirSync(qmdCacheDir, { recursive: true }); } catch { }
  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}

export function getPwd(): string {
  return process.env.PWD || process.cwd();
}

export function getRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
