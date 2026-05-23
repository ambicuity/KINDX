/**
 * specs/audit.test.ts
 *
 * Unit tests for engine/audit.ts - Audit logging subsystem.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import {
  initializeAuditSchema,
  recordAudit,
  queryAuditLog,
  getAuditSummary,
  purgeOldAuditEntries,
  type AuditAction,
} from "../engine/audit.js";

describe("audit", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initializeAuditSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("initializeAuditSchema", () => {
    test("creates audit_log table", () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates indexes", () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'"
      ).all();
      const indexNames = indexes.map((i: any) => i.name);
      expect(indexNames).toContain("idx_audit_log_timestamp");
      expect(indexNames).toContain("idx_audit_log_action");
      expect(indexNames).toContain("idx_audit_log_tenant");
      expect(indexNames).toContain("idx_audit_log_scope");
    });

    test("is idempotent", () => {
      expect(() => initializeAuditSchema(db)).not.toThrow();
    });
  });

  describe("recordAudit", () => {
    test("records audit entry", () => {
      recordAudit(db, {
        action: "auth_success",
        scope: "test",
        detail: "User logged in",
      });

      const entries = queryAuditLog(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("auth_success");
      expect(entries[0].scope).toBe("test");
      expect(entries[0].detail).toBe("User logged in");
      expect(entries[0].success).toBe(true);
    });

    test("records failure entry", () => {
      recordAudit(db, {
        action: "auth_failure",
        success: false,
        detail: "Invalid token",
      });

      const entries = queryAuditLog(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].success).toBe(false);
    });

    test("records tenant hash", () => {
      recordAudit(db, {
        action: "rbac_deny",
        tenantHash: "abc123",
      });

      const entries = queryAuditLog(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].tenantHash).toBe("abc123");
    });

    test("handles null optional fields", () => {
      recordAudit(db, {
        action: "query",
      });

      const entries = queryAuditLog(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].tenantHash).toBeNull();
      expect(entries[0].scope).toBeNull();
      expect(entries[0].detail).toBeNull();
      expect(entries[0].durationMs).toBeNull();
    });
  });

  describe("queryAuditLog", () => {
    test("returns entries in reverse chronological order", () => {
      recordAudit(db, { action: "query", detail: "First" });
      recordAudit(db, { action: "embed", detail: "Second" });

      const entries = queryAuditLog(db);
      expect(entries).toHaveLength(2);
      expect(entries[0].detail).toBe("Second");
      expect(entries[1].detail).toBe("First");
    });

    test("filters by action", () => {
      recordAudit(db, { action: "query" });
      recordAudit(db, { action: "embed" });
      recordAudit(db, { action: "query" });

      const entries = queryAuditLog(db, { action: "query" });
      expect(entries).toHaveLength(2);
    });

    test("filters by tenant hash", () => {
      recordAudit(db, { action: "query", tenantHash: "tenant1" });
      recordAudit(db, { action: "query", tenantHash: "tenant2" });

      const entries = queryAuditLog(db, { tenantHash: "tenant1" });
      expect(entries).toHaveLength(1);
    });

    test("filters by scope", () => {
      recordAudit(db, { action: "memory_put", scope: "global" });
      recordAudit(db, { action: "memory_put", scope: "project" });

      const entries = queryAuditLog(db, { scope: "global" });
      expect(entries).toHaveLength(1);
    });

    test("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        recordAudit(db, { action: "query" });
      }

      const entries = queryAuditLog(db, { limit: 5 });
      expect(entries).toHaveLength(5);
    });

    test("caps limit at 1000", () => {
      const entries = queryAuditLog(db, { limit: 2000 });
      expect(entries).toHaveLength(0);
    });
  });

  describe("getAuditSummary", () => {
    test("returns zero counts for empty log", () => {
      const summary = getAuditSummary(db);
      expect(summary.totalEntries).toBe(0);
      expect(summary.failureCount).toBe(0);
      expect(summary.oldestEntry).toBeNull();
      expect(summary.newestEntry).toBeNull();
    });

    test("counts entries by action", () => {
      recordAudit(db, { action: "query" });
      recordAudit(db, { action: "query" });
      recordAudit(db, { action: "embed" });

      const summary = getAuditSummary(db);
      expect(summary.totalEntries).toBe(3);
      expect(summary.byAction["query"]).toBe(2);
      expect(summary.byAction["embed"]).toBe(1);
    });

    test("counts failures", () => {
      recordAudit(db, { action: "auth_failure", success: false });
      recordAudit(db, { action: "auth_success", success: true });

      const summary = getAuditSummary(db);
      expect(summary.failureCount).toBe(1);
    });

    test("filters by tenant", () => {
      recordAudit(db, { action: "query", tenantHash: "tenant1" });
      recordAudit(db, { action: "query", tenantHash: "tenant2" });

      const summary = getAuditSummary(db, "tenant1");
      expect(summary.totalEntries).toBe(1);
    });
  });

  describe("purgeOldAuditEntries", () => {
    test("purges old entries", () => {
      const oldTimestamp = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        "INSERT INTO audit_log (timestamp, action, success) VALUES (?, ?, ?)"
      ).run(oldTimestamp, "query", 1);

      const purged = purgeOldAuditEntries(db, 90);
      expect(purged).toBe(1);
    });

    test("keeps recent entries", () => {
      recordAudit(db, { action: "query" });

      const purged = purgeOldAuditEntries(db, 90);
      expect(purged).toBe(0);
    });

    test("uses custom retention period", () => {
      const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        "INSERT INTO audit_log (timestamp, action, success) VALUES (?, ?, ?)"
      ).run(oldTimestamp, "query", 1);

      const purged = purgeOldAuditEntries(db, 5);
      expect(purged).toBe(1);
    });
  });
});
