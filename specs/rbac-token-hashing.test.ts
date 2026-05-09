/**
 * Regression: bearer tokens must be HMAC-hashed (not bare SHA-256) and
 * compared in constant time. Legacy bare-SHA-256 hashes still work for
 * backward compatibility but emit a quietWarn so operators can rotate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import YAML from "yaml";
import { resetQuietWarnForTests, getQuietWarnCount } from "../engine/utils/quiet-warn.js";

let rbac: typeof import("../engine/rbac.js");
let tmpDir: string;
const origConfigDir = process.env.KINDX_CONFIG_DIR;
const origSecret = process.env.KINDX_TENANT_SECRET;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `kindx-rbac-tok-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env.KINDX_CONFIG_DIR = tmpDir;
  delete process.env.KINDX_TENANT_SECRET;
  resetQuietWarnForTests();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  rbac = await import("../engine/rbac.js");
  rbac.__resetTenantRegistryCacheForTests();
  rbac.__resetServerSecretCacheForTests();
});

afterEach(() => {
  rbac.__resetTenantRegistryCacheForTests();
  rbac.__resetServerSecretCacheForTests();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (origConfigDir !== undefined) process.env.KINDX_CONFIG_DIR = origConfigDir;
  else delete process.env.KINDX_CONFIG_DIR;
  if (origSecret !== undefined) process.env.KINDX_TENANT_SECRET = origSecret;
  else delete process.env.KINDX_TENANT_SECRET;
  stderrSpy.mockRestore();
});

describe("rbac token hashing", () => {
  it("stores tokens in hmac:<hex> format", () => {
    const { tenant } = rbac.createTenant("bot1", "B", "viewer", ["docs"]);
    expect(tenant.tokenHash.startsWith("hmac:")).toBe(true);
    expect(tenant.tokenHash.length).toBe("hmac:".length + 64);
  });

  it("auto-provisions tenant_secret file with 0o600 perms", () => {
    rbac.createTenant("bot2", "B", "viewer", ["docs"]);
    const secretPath = join(tmpDir, "tenant_secret");
    const fs = require("node:fs");
    expect(fs.existsSync(secretPath)).toBe(true);
    const stat = fs.statSync(secretPath);
    const mode = stat.mode & 0o777;
    // On some FS (CI tmpfs) other bits may be present; minimum is owner-only.
    expect(mode & 0o077).toBe(0); // group + other have no rwx
  });

  it("resolves correct token via HMAC", () => {
    const { plaintextToken } = rbac.createTenant("bot3", "B", "editor", ["docs"]);
    const id = rbac.resolveTokenToIdentity(plaintextToken);
    expect(id).not.toBeNull();
    expect(id?.tenantId).toBe("bot3");
    expect(id?.role).toBe("editor");
  });

  it("rejects an incorrect token", () => {
    rbac.createTenant("bot4", "B", "editor", ["docs"]);
    const id = rbac.resolveTokenToIdentity("not-the-token");
    expect(id).toBeNull();
  });

  it("legacy bare-SHA-256 token hash still resolves (backwards compat) but warns", () => {
    // Hand-craft a tenants.yml with the legacy hash format.
    const plaintext = "legacy-token-1234567890";
    const legacyHash = createHash("sha256").update(plaintext).digest("hex");
    const yamlContent = YAML.stringify({
      tenants: {
        legacy: {
          id: "legacy",
          name: "Legacy",
          role: "viewer",
          tokenHash: legacyHash,
          allowedCollections: ["*"],
          createdAt: new Date().toISOString(),
          active: true,
        },
      },
    });
    writeFileSync(join(tmpDir, "tenants.yml"), yamlContent);
    rbac.__resetTenantRegistryCacheForTests();

    const id = rbac.resolveTokenToIdentity(plaintext);
    expect(id).not.toBeNull();
    expect(id?.tenantId).toBe("legacy");
    // Operator gets a quietWarn so they know to rotate.
    expect(getQuietWarnCount("rbac.legacy_token_hash_in_use")).toBeGreaterThan(0);
  });

  it("rejects disabled tenant tokens (full-scan, no early return)", () => {
    const { plaintextToken } = rbac.createTenant("bot5", "B", "editor", ["docs"]);
    rbac.updateTenant("bot5", { active: false });
    expect(rbac.resolveTokenToIdentity(plaintextToken)).toBeNull();
  });

  it("uses KINDX_TENANT_SECRET env when provided", () => {
    const customSecret = randomBytes(32).toString("base64");
    process.env.KINDX_TENANT_SECRET = customSecret;
    rbac.__resetServerSecretCacheForTests();

    const { tenant: t1, plaintextToken: tok } = rbac.createTenant("bot6", "B", "viewer", []);
    // Resolve with the same secret -> works.
    const id = rbac.resolveTokenToIdentity(tok);
    expect(id?.tenantId).toBe("bot6");
    expect(t1.tokenHash.startsWith("hmac:")).toBe(true);

    // Change the env secret (simulating a rotated key) -> resolution fails.
    process.env.KINDX_TENANT_SECRET = randomBytes(32).toString("base64");
    rbac.__resetServerSecretCacheForTests();
    rbac.__resetTenantRegistryCacheForTests();
    expect(rbac.resolveTokenToIdentity(tok)).toBeNull();
  });
});
