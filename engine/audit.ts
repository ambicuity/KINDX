/**
 * Audit logging for sensitive operations.
 *
 * Provides a lightweight, local-first audit trail backed by SQLite.
 * Logs security-sensitive operations like authentication attempts,
 * RBAC enforcement, memory mutations, and collection modifications.
 *
 * Design constraints:
 *   - Zero external dependencies (SQLite only)
 *   - No PII stored (tenant IDs are hashed, values are not stored)
 *   - Append-only (no UPDATE/DELETE on audit records)
 *   - Auto-rotation: purges records older than retention period
 *
 * Inspired by SpiceDB audit trail and OPA decision logs.
 */

import type { Database } from "./runtime.js";

export type AuditAction =
  | "auth_success"
  | "auth_failure"
  | "rbac_deny"
  | "memory_put"
  | "memory_delete"
  | "memory_purge_expired"
  | "collection_add"
  | "collection_remove"
  | "query"
  | "embed"
  | "config_change"
  | "daemon_start"
  | "daemon_stop"
  | "memory_bulk";

export type AuditEntry = {
  id: number;
  timestamp: string;
  action: AuditAction;
  /** Hashed tenant identifier (SHA-256 prefix). NULL for single-tenant mode. */
  tenantHash: string | null;
  /** Affected scope (collection name, memory scope, etc.) */
  scope: string | null;
  /** Human-readable detail string. Must NOT contain secrets or PII. */
  detail: string | null;
  /** Duration of the operation in milliseconds, if applicable. */
  durationMs: number | null;
  /** Whether the operation succeeded. */
  success: boolean;
};

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Initialize the audit log schema.
 * Idempotent — safe to call on every startup.
 */
export function initializeAuditSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      tenant_hash TEXT,
      scope TEXT,
      detail TEXT,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_hash)`,
  );
}

/**
 * Record an audit entry.
 *
 * This is a fire-and-forget operation — audit logging should never fail
 * the parent operation. Errors are swallowed and written to stderr.
 */
export function recordAudit(
  db: Database,
  entry: {
    action: AuditAction;
    tenantHash?: string | null;
    scope?: string | null;
    detail?: string | null;
    durationMs?: number | null;
    success?: boolean;
  },
): void {
  try {
    db.prepare(`
      INSERT INTO audit_log (timestamp, action, tenant_hash, scope, detail, duration_ms, success)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      entry.action,
      entry.tenantHash ?? null,
      entry.scope ?? null,
      entry.detail ?? null,
      entry.durationMs ?? null,
      (entry.success ?? true) ? 1 : 0,
    );
  } catch (err) {
    // Audit logging must never crash the parent operation
    process.stderr.write(
      `[KINDX] ⚠ audit_log_write_failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Query audit entries with optional filters.
 * Returns entries in reverse chronological order (newest first).
 */
export function queryAuditLog(
  db: Database,
  filters?: {
    action?: AuditAction;
    tenantHash?: string;
    since?: string;
    limit?: number;
  },
): AuditEntry[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.action) {
    conditions.push("action = ?");
    params.push(filters.action);
  }
  if (filters?.tenantHash) {
    conditions.push("tenant_hash = ?");
    params.push(filters.tenantHash);
  }
  if (filters?.since) {
    conditions.push("timestamp >= ?");
    params.push(filters.since);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters?.limit ?? 100, 1000);

  const rows = db
    .prepare(
      `SELECT id, timestamp, action, tenant_hash, scope, detail, duration_ms, success
     FROM audit_log ${where}
     ORDER BY timestamp DESC
     LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: number;
    timestamp: string;
    action: string;
    tenant_hash: string | null;
    scope: string | null;
    detail: string | null;
    duration_ms: number | null;
    success: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    action: row.action as AuditAction,
    tenantHash: row.tenant_hash,
    scope: row.scope,
    detail: row.detail,
    durationMs: row.duration_ms,
    success: row.success === 1,
  }));
}

/**
 * Get audit log summary statistics for a tenant or globally.
 */
export function getAuditSummary(
  db: Database,
  tenantHash?: string,
): {
  totalEntries: number;
  byAction: Record<string, number>;
  failureCount: number;
  oldestEntry: string | null;
  newestEntry: string | null;
} {
  const tenantFilter = tenantHash
    ? "WHERE tenant_hash = ?"
    : "";
  const params = tenantHash ? [tenantHash] : [];

  const total = db
    .prepare(`SELECT COUNT(*) AS cnt FROM audit_log ${tenantFilter}`)
    .get(...params) as { cnt: number };

  const failures = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM audit_log ${tenantFilter ? tenantFilter + " AND" : "WHERE"} success = 0`,
    )
    .get(...params) as { cnt: number };

  const actionRows = db
    .prepare(
      `SELECT action, COUNT(*) AS cnt FROM audit_log ${tenantFilter} GROUP BY action ORDER BY cnt DESC`,
    )
    .all(...params) as Array<{ action: string; cnt: number }>;

  const oldest = db
    .prepare(
      `SELECT MIN(timestamp) AS ts FROM audit_log ${tenantFilter}`,
    )
    .get(...params) as { ts: string | null };

  const newest = db
    .prepare(
      `SELECT MAX(timestamp) AS ts FROM audit_log ${tenantFilter}`,
    )
    .get(...params) as { ts: string | null };

  return {
    totalEntries: total.cnt,
    byAction: Object.fromEntries(actionRows.map((r) => [r.action, r.cnt])),
    failureCount: failures.cnt,
    oldestEntry: oldest.ts,
    newestEntry: newest.ts,
  };
}

/**
 * Purge audit entries older than the retention period.
 * Returns the number of purged records.
 */
export function purgeOldAuditEntries(
  db: Database,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const result = db
    .prepare(`DELETE FROM audit_log WHERE timestamp < ?`)
    .run(cutoff);
  return Number(result.changes);
}
