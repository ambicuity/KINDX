/**
 * schema-version.ts
 *
 * Wraps SQLite's `PRAGMA user_version` for forward-only schema versioning.
 *
 * Required by the Tier 0 fix that gates the unconditional `DROP TABLE` calls
 * in schema.ts behind a version check. Previously, `initializeCoreSchema` was
 * called on every store open and dropped legacy tables (`path_contexts`,
 * `collections`) regardless of whether they held user data.
 *
 * Usage:
 *   const v = getUserVersion(db);
 *   if (v < 1) {
 *     // perform v0 -> v1 migration
 *     setUserVersion(db, 1);
 *   }
 *
 * `PRAGMA user_version` is a 32-bit signed integer slot in the SQLite header.
 * Default value is 0 for newly created databases.
 */

export interface PragmaCapableDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): unknown;
}

export const KINDX_SCHEMA_VERSION = 1;

/**
 * Read the current schema version from SQLite's user_version pragma.
 * Returns 0 for fresh databases.
 */
export function getUserVersion(db: PragmaCapableDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const v = row?.user_version;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Persist the schema version. The value must fit in a 32-bit signed integer
 * (PRAGMA user_version's storage); we use small monotonic integers, so this
 * is enforced as a sanity check.
 */
export function setUserVersion(db: PragmaCapableDatabase, version: number): void {
  if (!Number.isInteger(version) || version < 0 || version > 0x7fff_ffff) {
    throw new Error(`setUserVersion: invalid version ${version}`);
  }
  // PRAGMA does not support parameter binding, so version is interpolated.
  // Validated above to be a small non-negative integer; safe.
  db.exec(`PRAGMA user_version = ${version}`);
}
