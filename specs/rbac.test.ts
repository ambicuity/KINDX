/**
 * RBAC unit tests — tenant management, token resolution, permission enforcement
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes, createHash } from "crypto";

// Module under test — use dynamic import to set KINDX_CONFIG_DIR before load
let rbac: typeof import("../engine/rbac.js");

describe("RBAC", () => {
  let tmpDir: string;
  const origConfigDir = process.env.KINDX_CONFIG_DIR;

  beforeEach(async () => {
    // Create isolated config dir per test
    tmpDir = join(tmpdir(), `kindx-rbac-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.KINDX_CONFIG_DIR = tmpDir;

    // Force fresh import to reset cache
    rbac = await import("../engine/rbac.js");
    rbac.__resetTenantRegistryCacheForTests();
  });

  afterEach(() => {
    rbac.__resetTenantRegistryCacheForTests();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (origConfigDir !== undefined) {
      process.env.KINDX_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.KINDX_CONFIG_DIR;
    }
  });

  describe("Tenant CRUD", () => {
    it("creates a tenant and returns plaintext token", () => {
      const { tenant, plaintextToken } = rbac.createTenant("bot1", "CI Bot", "viewer", ["docs"]);

      expect(tenant.id).toBe("bot1");
      expect(tenant.name).toBe("CI Bot");
      expect(tenant.role).toBe("viewer");
      expect(tenant.allowedCollections).toEqual(["docs"]);
      expect(tenant.active).toBe(true);
      expect(plaintextToken).toHaveLength(64); // 32 bytes hex
      // Token hash should be SHA-256 of the plaintext
      expect(tenant.tokenHash).toBe(createHash("sha256").update(plaintextToken).digest("hex"));
    });

    it("rejects duplicate tenant IDs", () => {
      rbac.createTenant("bot1", "Bot 1", "viewer", ["docs"]);
      expect(() => rbac.createTenant("bot1", "Bot 2", "viewer", ["notes"])).toThrow("already exists");
    });

    it("rejects invalid tenant IDs", () => {
      expect(() => rbac.createTenant("bad id!", "Bad", "viewer", [])).toThrow("Invalid tenant ID");
      expect(() => rbac.createTenant("bad/id", "Bad", "viewer", [])).toThrow("Invalid tenant ID");
    });

    it("admin tenants get wildcard collection access", () => {
      const { tenant } = rbac.createTenant("admin1", "Admin", "admin", ["docs"]);
      expect(tenant.allowedCollections).toEqual(["*"]);
    });

    it("removes a tenant", () => {
      rbac.createTenant("bot1", "Bot", "viewer", []);
      expect(rbac.removeTenant("bot1")).toBe(true);
      expect(rbac.removeTenant("bot1")).toBe(false); // Already removed
    });

    it("lists tenants without tokenHash", () => {
      rbac.createTenant("bot1", "Bot 1", "viewer", ["docs"]);
      rbac.createTenant("bot2", "Bot 2", "editor", ["notes"]);
      const list = rbac.listTenants();
      expect(list).toHaveLength(2);
      for (const t of list) {
        expect(t).not.toHaveProperty("tokenHash");
      }
    });

    it("gets a tenant by ID", () => {
      rbac.createTenant("bot1", "Bot 1", "viewer", ["docs"]);
      expect(rbac.getTenant("bot1")).not.toBeNull();
      expect(rbac.getTenant("nonexistent")).toBeNull();
    });

    it("rotates a tenant token", () => {
      const { plaintextToken: oldToken } = rbac.createTenant("bot1", "Bot", "viewer", []);
      const newToken = rbac.rotateTenantToken("bot1");
      expect(newToken).not.toBe(oldToken);
      expect(newToken).toHaveLength(64);
    });

    it("updates tenant properties", () => {
      rbac.createTenant("bot1", "Bot", "viewer", ["docs"]);
      const updated = rbac.updateTenant("bot1", { role: "editor", active: false });
      expect(updated?.role).toBe("editor");
      expect(updated?.active).toBe(false);
      expect(rbac.updateTenant("nonexistent", { role: "admin" })).toBeNull();
    });

    it("grants and revokes collection access", () => {
      rbac.createTenant("bot1", "Bot", "viewer", ["docs"]);
      rbac.grantCollections("bot1", ["notes", "meetings"]);
      expect(rbac.getTenant("bot1")?.allowedCollections).toContain("notes");
      expect(rbac.getTenant("bot1")?.allowedCollections).toContain("meetings");

      rbac.revokeCollections("bot1", ["meetings"]);
      expect(rbac.getTenant("bot1")?.allowedCollections).not.toContain("meetings");
    });
  });

  describe("Token Resolution", () => {
    it("resolves a valid token to identity", () => {
      const { plaintextToken } = rbac.createTenant("bot1", "Bot", "editor", ["docs", "notes"]);
      const identity = rbac.resolveTokenToIdentity(plaintextToken);

      expect(identity).not.toBeNull();
      expect(identity!.tenantId).toBe("bot1");
      expect(identity!.role).toBe("editor");
      expect(identity!.allowedCollections).toEqual(["docs", "notes"]);
    });

    it("returns null for unknown tokens", () => {
      rbac.createTenant("bot1", "Bot", "viewer", []);
      expect(rbac.resolveTokenToIdentity("invalid-token-value")).toBeNull();
    });

    it("rejects disabled tenant tokens", () => {
      const { plaintextToken } = rbac.createTenant("bot1", "Bot", "viewer", []);
      rbac.updateTenant("bot1", { active: false });
      expect(rbac.resolveTokenToIdentity(plaintextToken)).toBeNull();
    });

    it("admin identity gets wildcard collections", () => {
      const { plaintextToken } = rbac.createTenant("admin1", "Admin", "admin", []);
      const identity = rbac.resolveTokenToIdentity(plaintextToken);
      expect(identity!.allowedCollections).toBe("*");
    });
  });

  describe("Permission Enforcement", () => {
    it("admin can do everything", () => {
      const adminId: import("../engine/rbac.js").ResolvedIdentity = {
        tenantId: "admin1",
        role: "admin",
        allowedCollections: "*",
      };
      expect(rbac.isPermitted(adminId, "query")).toBe(true);
      expect(rbac.isPermitted(adminId, "memory_put")).toBe(true);
      expect(rbac.isPermitted(adminId, "collection_add")).toBe(true);
      expect(rbac.isPermitted(adminId, "backup")).toBe(true);
      expect(rbac.isPermitted(adminId, "tenant_manage")).toBe(true);
    });

    it("editor can query and write but not manage", () => {
      const editorId: import("../engine/rbac.js").ResolvedIdentity = {
        tenantId: "e1",
        role: "editor",
        allowedCollections: ["docs"],
      };
      expect(rbac.isPermitted(editorId, "query")).toBe(true);
      expect(rbac.isPermitted(editorId, "memory_put")).toBe(true);
      expect(rbac.isPermitted(editorId, "embed")).toBe(true);
      expect(rbac.isPermitted(editorId, "collection_add")).toBe(false);
      expect(rbac.isPermitted(editorId, "backup")).toBe(false);
      expect(rbac.isPermitted(editorId, "tenant_manage")).toBe(false);
    });

    it("viewer is read-only", () => {
      const viewerId: import("../engine/rbac.js").ResolvedIdentity = {
        tenantId: "v1",
        role: "viewer",
        allowedCollections: ["docs"],
      };
      expect(rbac.isPermitted(viewerId, "query")).toBe(true);
      expect(rbac.isPermitted(viewerId, "get")).toBe(true);
      expect(rbac.isPermitted(viewerId, "memory_search")).toBe(true);
      expect(rbac.isPermitted(viewerId, "memory_put")).toBe(false);
      expect(rbac.isPermitted(viewerId, "embed")).toBe(false);
      expect(rbac.isPermitted(viewerId, "collection_add")).toBe(false);
      expect(rbac.isPermitted(viewerId, "tenant_manage")).toBe(false);
    });
  });

  describe("Collection ACL", () => {
    it("wildcard allows all collections", () => {
      const id: import("../engine/rbac.js").ResolvedIdentity = {
        tenantId: "a1",
        role: "admin",
        allowedCollections: "*",
      };
      expect(rbac.canAccessCollection(id, "anything")).toBe(true);
      expect(rbac.filterAllowedCollections(id, ["docs", "notes", "secret"])).toEqual(["docs", "notes", "secret"]);
    });

    it("restricts to allowed collections only", () => {
      const id: import("../engine/rbac.js").ResolvedIdentity = {
        tenantId: "v1",
        role: "viewer",
        allowedCollections: ["docs", "notes"],
      };
      expect(rbac.canAccessCollection(id, "docs")).toBe(true);
      expect(rbac.canAccessCollection(id, "secret")).toBe(false);
      expect(rbac.filterAllowedCollections(id, ["docs", "notes", "secret"])).toEqual(["docs", "notes"]);
    });

    it("enforce throws RBACDeniedError on collection violation", () => {
      const id: import("../engine/rbac.js").ResolvedIdentity = {
        tenantId: "v1",
        role: "viewer",
        allowedCollections: ["docs"],
      };
      expect(() => rbac.enforce(id, "query", "docs")).not.toThrow();
      expect(() => rbac.enforce(id, "query", "secret")).toThrow(rbac.RBACDeniedError);
    });

    it("enforce throws RBACDeniedError on operation violation", () => {
      const id: import("../engine/rbac.js").ResolvedIdentity = {
        tenantId: "v1",
        role: "viewer",
        allowedCollections: ["docs"],
      };
      expect(() => rbac.enforce(id, "memory_put")).toThrow(rbac.RBACDeniedError);
    });
  });

  describe("Multi-tenant Detection", () => {
    it("is disabled when no tenants exist", () => {
      expect(rbac.isMultiTenantEnabled()).toBe(false);
    });

    it("is enabled when tenants exist", () => {
      rbac.createTenant("bot1", "Bot", "viewer", []);
      expect(rbac.isMultiTenantEnabled()).toBe(true);
    });
  });

  describe("Diagnostic Status", () => {
    it("reports role counts correctly", () => {
      rbac.createTenant("a1", "Admin", "admin", []);
      rbac.createTenant("e1", "Editor", "editor", ["docs"]);
      rbac.createTenant("v1", "Viewer 1", "viewer", ["docs"]);
      rbac.createTenant("v2", "Viewer 2", "viewer", ["notes"]);
      rbac.updateTenant("v2", { active: false }); // Disabled — should not count

      const status = rbac.getRBACStatus();
      expect(status.enabled).toBe(true);
      expect(status.tenantCount).toBe(3); // Active only
      expect(status.roles.admin).toBe(1);
      expect(status.roles.editor).toBe(1);
      expect(status.roles.viewer).toBe(1); // Only active v1
    });
  });

  describe("Registry Refresh Cache", () => {
    it("keeps serving last-known-good registry until async refresh applies external change", async () => {
      const { plaintextToken } = rbac.createTenant("bot1", "Bot", "viewer", ["docs"]);
      expect(rbac.resolveTokenToIdentity(plaintextToken)?.tenantId).toBe("bot1");

      const tenantsFile = join(tmpDir, "tenants.yml");
      writeFileSync(tenantsFile, "tenants: {}\n", "utf-8");
      const bumped = new Date(Date.now() + 2000);
      utimesSync(tenantsFile, bumped, bumped);

      // Stale-while-refresh should keep existing cache until refresh runs.
      expect(rbac.resolveTokenToIdentity(plaintextToken)?.tenantId).toBe("bot1");

      await rbac.__refreshTenantRegistryNowForTests();
      expect(rbac.resolveTokenToIdentity(plaintextToken)).toBeNull();
    });

    it("logs refresh warning and preserves last-known-good registry on invalid async reload", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const { plaintextToken } = rbac.createTenant("bot1", "Bot", "viewer", ["docs"]);
        const tenantsFile = join(tmpDir, "tenants.yml");
        writeFileSync(tenantsFile, "tenants: [\n", "utf-8"); // malformed YAML
        const bumped = new Date(Date.now() + 2000);
        utimesSync(tenantsFile, bumped, bumped);

        await rbac.__refreshTenantRegistryNowForTests();
        expect(rbac.resolveTokenToIdentity(plaintextToken)?.tenantId).toBe("bot1");
        const warningText = stderrSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(warningText).toContain("tenant_registry_refresh_failed");
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe("Rate Limiting", () => {
    const origBurst = process.env.KINDX_RATE_LIMIT_BURST;
    const origRateMs = process.env.KINDX_RATE_LIMIT_MS;

    beforeEach(() => {
      process.env.KINDX_RATE_LIMIT_BURST = "2";
      process.env.KINDX_RATE_LIMIT_MS = "1000";
      rbac.__resetRateLimitsForTests();
    });

    afterEach(() => {
      rbac.__resetRateLimitsForTests();
      vi.useRealTimers();
      if (origBurst !== undefined) {
        process.env.KINDX_RATE_LIMIT_BURST = origBurst;
      } else {
        delete process.env.KINDX_RATE_LIMIT_BURST;
      }
      if (origRateMs !== undefined) {
        process.env.KINDX_RATE_LIMIT_MS = origRateMs;
      } else {
        delete process.env.KINDX_RATE_LIMIT_MS;
      }
    });

    it("enforces burst limit and throws RateLimitExceededError", () => {
      expect(() => rbac.enforceRateLimit("tenant-a")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-a")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-a")).toThrow(rbac.RateLimitExceededError);
    });

    it("refills tokens over time", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      expect(() => rbac.enforceRateLimit("tenant-a")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-a")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-a")).toThrow(rbac.RateLimitExceededError);

      vi.advanceTimersByTime(1000);
      expect(() => rbac.enforceRateLimit("tenant-a")).not.toThrow();
    });

    it("tracks limits independently per tenant", () => {
      expect(() => rbac.enforceRateLimit("tenant-a")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-a")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-a")).toThrow(rbac.RateLimitExceededError);

      expect(() => rbac.enforceRateLimit("tenant-b")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-b")).not.toThrow();
      expect(() => rbac.enforceRateLimit("tenant-b")).toThrow(rbac.RateLimitExceededError);
    });
  });
});
