/**
 * path-safety.ts
 *
 * Path-traversal guard. Used by:
 *   - repository.ts:resolveVirtualPath — prevents `../` in virtual paths from
 *     reading documents outside the collection root in shared-collection setups.
 *   - link-extractor.ts — prevents `[click](../../../etc/passwd)` from poisoning
 *     the link graph with paths outside the collection.
 *
 * Throws PathTraversalError on a violation rather than returning null/false so
 * callers cannot silently fall through to unsafe behavior.
 */

import { resolve, relative, isAbsolute, sep } from "node:path";

export class PathTraversalError extends Error {
  readonly child: string;
  readonly root: string;
  constructor(child: string, root: string) {
    super(`path traversal blocked: ${child} is not under ${root}`);
    this.name = "PathTraversalError";
    this.child = child;
    this.root = root;
  }
}

/**
 * Returns the normalized absolute path of `child` if and only if it resolves
 * inside `root`. Throws PathTraversalError otherwise.
 *
 * `child` may be relative (resolved against `root`) or absolute.
 * `root` must be absolute; relative roots throw.
 *
 * Notes:
 *   - Symlinks are NOT resolved here (we don't want fs I/O on the hot path).
 *     If you need realpath, do it before calling and pass the realpath as both
 *     root and child base.
 *   - Comparison uses path.relative + sep check, which is correct on both
 *     POSIX and Windows.
 */
export function assertUnderRoot(child: string, root: string): string {
  if (!isAbsolute(root)) {
    throw new Error(`assertUnderRoot: root must be absolute, got ${root}`);
  }
  const absChild = isAbsolute(child) ? resolve(child) : resolve(root, child);
  const absRoot = resolve(root);
  // Same path counts as inside.
  if (absChild === absRoot) return absChild;
  const rel = relative(absRoot, absChild);
  // If `rel` starts with `..` or is absolute, the child escapes the root.
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
    if (rel === "") return absChild;
    throw new PathTraversalError(absChild, absRoot);
  }
  // Belt-and-braces: ensure first component is not "..", which can hide on
  // some Windows drive boundaries.
  const first = rel.split(sep)[0];
  if (first === "..") {
    throw new PathTraversalError(absChild, absRoot);
  }
  return absChild;
}

/**
 * Boolean variant for callers that prefer not to handle exceptions.
 */
export function isUnderRoot(child: string, root: string): boolean {
  try { assertUnderRoot(child, root); return true; }
  catch { return false; }
}
