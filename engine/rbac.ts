/**
 * rbac.ts — Multi-Tenant Isolation & Role-Based Access Control
 *
 * Provides tenant management, token-to-identity resolution, and permission
 * enforcement for the KINDX HTTP MCP daemon.
 *
 * Tenant registry is stored in ~/.config/kindx/tenants.yml alongside the
 * collection config. Each tenant maps a bearer token to a role and a set
 * of allowed collections.
 *
 * Roles:
 *   admin  — full access: all collections, write ops, tenant management
 *   editor — read + write to assigned collections (query, get, embed, memory write)
 *   viewer — read-only access to assigned collections (query, get, memory read)
 *
 * Backward compatibility:
 *   When no tenants.yml exists, the system operates in single-tenant mode.
 *   The existing KINDX_MCP_TOKEN is treated as an admin token with no
 *   collection restrictions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, openSync, writeSync, fsyncSync, closeSync, promises as fsp } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes, createHash } from "crypto";
import YAML from "yaml";

// =============================================================================
// Types
// =============================================================================

export type TenantRole = "admin" | "editor" | "viewer";

export interface Tenant {
  /** Unique tenant identifier (slug). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** RBAC role. */
  role: TenantRole;
  /**
   * SHA-256 hash of the bearer token.
   * We never store plaintext tokens in the registry.
   */
  tokenHash: string;
  /**
   * Collections this tenant can access.
   * `["*"]` means all collections (admin default).
   * Empty array means no collection access.
   */
  allowedCollections: string[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Optional description / notes. */
  description?: string;
  /** Whether the tenant is active. Disabled tenants are rejected at auth. */
  active: boolean;
}

export interface TenantRegistry {
  tenants: Record<string, Tenant>;
}

/**
 * Resolved identity from a bearer token.
 * Attached to every authenticated HTTP request.
 */
export interface ResolvedIdentity {
  tenantId: string;
  role: TenantRole;
  allowedCollections: string[] | "*";
}

// =============================================================================
// Permission definitions
// =============================================================================

/**
 * Operations that can be checked against the RBAC policy.
 */
export type RBACOperation =
  | "query"
  | "search"
  | "get"
  | "multi_get"
  | "status"
  | "memory_put"
  | "memory_search"
  | "memory_history"
  | "memory_stats"
  | "memory_mark_accessed"
  | "collection_add"
  | "collection_remove"
  | "collection_rename"
  | "embed"
  | "update"
  | "backup"
  | "doctor"
  | "tenant_manage"
  | "arch_query"
  | "arch_status";

const ROLE_PERMISSIONS: Record<TenantRole, Set<RBACOperation>> = {
  admin: new Set([
    "query", "search", "get", "multi_get", "status",
    "memory_put", "memory_search", "memory_history", "memory_stats", "memory_mark_accessed",
    "collection_add", "collection_remove", "collection_rename",
    "embed", "update", "backup", "doctor", "tenant_manage",
    "arch_query", "arch_status",
  ]),
  editor: new Set([
    "query", "search", "get", "multi_get", "status",
    "memory_put", "memory_search", "memory_history", "memory_stats", "memory_mark_accessed",
    "embed", "update", "doctor",
    "arch_query", "arch_status",
  ]),
  viewer: new Set([
    "query", "search", "get", "multi_get", "status",
    "memory_search", "memory_history", "memory_stats",
    "doctor",
    "arch_query", "arch_status",
  ]),
};

// =============================================================================
// Token hashing
// =============================================================================

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// =============================================================================
// Registry persistence
// =============================================================================

function getConfigDir(): string {
  if (process.env.KINDX_CONFIG_DIR) {
    return process.env.KINDX_CONFIG_DIR;
  }
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "kindx");
  }
  return join(homedir(), ".config", "kindx");
}

function getTenantsFilePath(): string {
  return join(getConfigDir(), "tenants.yml");
}

let _cachedRegistry: TenantRegistry | null = null;
let _lastRegistryMtime = 0;
let _registryLoaded = false;
let _refreshInFlight: Promise<void> | null = null;
let _refreshTimer: NodeJS.Timeout | null = null;
const REGISTRY_REFRESH_INTERVAL_MS = 5000;
const REGISTRY_WARN_WINDOW_MS = 60_000;
const registryWarnState = new Map<string, number>();

function warnRegistry(code: string, detail: string): void {
  const now = Date.now();
  const last = registryWarnState.get(code);
  if (typeof last === "number" && now - last < REGISTRY_WARN_WINDOW_MS) return;
  registryWarnState.set(code, now);
  process.stderr.write(`KINDX Warning: tenant_registry_${code} ${detail}\n`);
}

function parseRegistry(content: string): TenantRegistry {
  const parsed = YAML.parse(content) as TenantRegistry | null;
  if (!parsed || typeof parsed !== "object") {
    return { tenants: {} };
  }
  if (!parsed.tenants || typeof parsed.tenants !== "object") {
    parsed.tenants = {};
  }
  return parsed;
}

async function refreshTenantRegistryFromDisk(): Promise<void> {
  const filePath = getTenantsFilePath();
  try {
    if (!existsSync(filePath)) {
      _cachedRegistry = { tenants: {} };
      _lastRegistryMtime = 0;
      _registryLoaded = true;
      return;
    }
    const stat = await fsp.stat(filePath);
    if (_cachedRegistry && stat.mtimeMs === _lastRegistryMtime) {
      _registryLoaded = true;
      return;
    }
    const content = await fsp.readFile(filePath, "utf-8");
    _cachedRegistry = parseRegistry(content);
    _lastRegistryMtime = stat.mtimeMs;
    _registryLoaded = true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      if (!_cachedRegistry) {
        _cachedRegistry = { tenants: {} };
        _lastRegistryMtime = 0;
      }
      _registryLoaded = true;
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    warnRegistry("refresh_failed", detail);
  }
}

function scheduleTenantRegistryRefresh(): Promise<void> {
  if (_refreshInFlight) {
    return _refreshInFlight;
  }
  _refreshInFlight = refreshTenantRegistryFromDisk().finally(() => {
    _refreshInFlight = null;
  });
  return _refreshInFlight;
}

function ensureTenantRegistryRefreshTimer(): void {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(() => {
    void scheduleTenantRegistryRefresh();
  }, REGISTRY_REFRESH_INTERVAL_MS);
  if (typeof _refreshTimer.unref === "function") {
    _refreshTimer.unref();
  }
}

function loadTenantRegistrySyncCold(filePath: string): TenantRegistry {
  if (!existsSync(filePath)) {
    _cachedRegistry = { tenants: {} };
    _lastRegistryMtime = 0;
    _registryLoaded = true;
    return _cachedRegistry;
  }
  const stat = statSync(filePath);
  const content = readFileSync(filePath, "utf-8");
  const registry = parseRegistry(content);
  _cachedRegistry = registry;
  _lastRegistryMtime = stat.mtimeMs;
  _registryLoaded = true;
  return registry;
}

export function loadTenantRegistry(): TenantRegistry {
  const filePath = getTenantsFilePath();
  ensureTenantRegistryRefreshTimer();
  if (!_registryLoaded) {
    try {
      return loadTenantRegistrySyncCold(filePath);
    } catch (error) {
      throw new Error(`Failed to parse ${filePath}: ${error}`);
    }
  }
  void scheduleTenantRegistryRefresh();
  return _cachedRegistry ?? { tenants: {} };
}

export function saveTenantRegistry(registry: TenantRegistry): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const filePath = getTenantsFilePath();
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  const yaml = YAML.stringify(registry, { indent: 2, lineWidth: 0 });
  
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "w", 0o600);
    writeSync(fd, yaml, null, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch (e) {}
    }
  }
  
  renameSync(tempPath, filePath);

  // fsync the directory to ensure the rename is durable against power failure
  let dirFd: number | null = null;
  try {
    dirFd = openSync(configDir, "r");
    fsyncSync(dirFd);
  } catch (e) {
    // Ignore errors for OSes that don't support directory fsync
  } finally {
    if (dirFd !== null) {
      try { closeSync(dirFd); } catch (e) {}
    }
  }
  const stat = statSync(filePath);
  _cachedRegistry = registry;
  _lastRegistryMtime = stat.mtimeMs;
  _registryLoaded = true;
  void scheduleTenantRegistryRefresh();
}

export async function __refreshTenantRegistryNowForTests(): Promise<void> {
  _lastRegistryMtime = -1;
  await scheduleTenantRegistryRefresh();
}

export function __resetTenantRegistryCacheForTests(): void {
  _cachedRegistry = null;
  _lastRegistryMtime = 0;
  _registryLoaded = false;
  _refreshInFlight = null;
  registryWarnState.clear();
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

/**
 * Check whether multi-tenant mode is active.
 * Returns true if a tenants.yml exists with at least one tenant.
 */
export function isMultiTenantEnabled(): boolean {
  const registry = loadTenantRegistry();
  return Object.keys(registry.tenants).length > 0;
}

// =============================================================================
// Tenant CRUD
// =============================================================================

/**
 * Create a new tenant and return the plaintext token (shown once).
 * The token is stored as a SHA-256 hash — it cannot be recovered.
 */
export function createTenant(
  id: string,
  name: string,
  role: TenantRole,
  allowedCollections: string[],
  description?: string,
): { tenant: Tenant; plaintextToken: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid tenant ID '${id}': must be alphanumeric with hyphens/underscores`);
  }

  const registry = loadTenantRegistry();
  if (registry.tenants[id]) {
    throw new Error(`Tenant '${id}' already exists`);
  }

  const plaintextToken = randomBytes(32).toString("hex");
  const tenant: Tenant = {
    id,
    name,
    role,
    tokenHash: hashToken(plaintextToken),
    allowedCollections: role === "admin" ? ["*"] : allowedCollections,
    createdAt: new Date().toISOString(),
    description,
    active: true,
  };

  registry.tenants[id] = tenant;
  saveTenantRegistry(registry);

  return { tenant, plaintextToken };
}

/**
 * Remove a tenant by ID.
 */
export function removeTenant(id: string): boolean {
  const registry = loadTenantRegistry();
  if (!registry.tenants[id]) return false;
  delete registry.tenants[id];
  saveTenantRegistry(registry);
  return true;
}

/**
 * List all tenants (without token hashes for display safety).
 */
export function listTenants(): Omit<Tenant, "tokenHash">[] {
  const registry = loadTenantRegistry();
  return Object.values(registry.tenants).map(({ tokenHash, ...rest }) => rest);
}

/**
 * Get a tenant by ID.
 */
export function getTenant(id: string): Tenant | null {
  const registry = loadTenantRegistry();
  return registry.tenants[id] ?? null;
}

/**
 * Rotate a tenant's token. Returns the new plaintext token.
 */
export function rotateTenantToken(id: string): string {
  const registry = loadTenantRegistry();
  const tenant = registry.tenants[id];
  if (!tenant) throw new Error(`Tenant '${id}' not found`);

  const newToken = randomBytes(32).toString("hex");
  tenant.tokenHash = hashToken(newToken);
  saveTenantRegistry(registry);
  return newToken;
}

/**
 * Update tenant properties (role, collections, active status).
 */
export function updateTenant(
  id: string,
  updates: Partial<Pick<Tenant, "role" | "allowedCollections" | "active" | "name" | "description">>,
): Tenant | null {
  const registry = loadTenantRegistry();
  const tenant = registry.tenants[id];
  if (!tenant) return null;

  if (updates.role !== undefined) tenant.role = updates.role;
  if (updates.allowedCollections !== undefined) tenant.allowedCollections = updates.allowedCollections;
  if (updates.active !== undefined) tenant.active = updates.active;
  if (updates.name !== undefined) tenant.name = updates.name;
  if (updates.description !== undefined) tenant.description = updates.description;

  saveTenantRegistry(registry);
  return tenant;
}

/**
 * Grant a tenant access to additional collections.
 */
export function grantCollections(id: string, collections: string[]): boolean {
  const registry = loadTenantRegistry();
  const tenant = registry.tenants[id];
  if (!tenant) return false;

  if (tenant.allowedCollections.includes("*")) return true; // Already has wildcard

  const existing = new Set(tenant.allowedCollections);
  for (const c of collections) existing.add(c);
  tenant.allowedCollections = Array.from(existing);

  saveTenantRegistry(registry);
  return true;
}

/**
 * Revoke a tenant's access to specific collections.
 */
export function revokeCollections(id: string, collections: string[]): boolean {
  const registry = loadTenantRegistry();
  const tenant = registry.tenants[id];
  if (!tenant) return false;

  const toRemove = new Set(collections);
  tenant.allowedCollections = tenant.allowedCollections.filter(c => !toRemove.has(c));

  saveTenantRegistry(registry);
  return true;
}

// =============================================================================
// Token resolution
// =============================================================================

/**
 * Resolve a bearer token to a tenant identity.
 * Returns null if the token doesn't match any active tenant.
 *
 * Time-complexity: O(n) over registered tenants. For typical deployments
 * (<100 tenants), this is negligible. If needed, a reverse-index
 * (tokenHash → tenantId) can be built at load time.
 */
export function resolveTokenToIdentity(token: string): ResolvedIdentity | null {
  const registry = loadTenantRegistry();
  const tokenH = hashToken(token);

  for (const tenant of Object.values(registry.tenants)) {
    if (tenant.tokenHash === tokenH) {
      if (!tenant.active) return null; // Disabled tenant

      return {
        tenantId: tenant.id,
        role: tenant.role,
        allowedCollections: tenant.allowedCollections.includes("*")
          ? "*"
          : tenant.allowedCollections,
      };
    }
  }

  return null;
}

// =============================================================================
// Policy enforcement
// =============================================================================

/**
 * Check whether the given identity is permitted to perform the operation.
 */
export function isPermitted(identity: ResolvedIdentity, operation: RBACOperation): boolean {
  const perms = ROLE_PERMISSIONS[identity.role];
  return perms?.has(operation) ?? false;
}

/**
 * Check whether the identity can access a specific collection.
 */
export function canAccessCollection(identity: ResolvedIdentity, collectionName: string): boolean {
  if (identity.allowedCollections === "*") return true;
  return identity.allowedCollections.includes(collectionName);
}

/**
 * Filter a list of collection names to only those the identity can access.
 */
export function filterAllowedCollections(
  identity: ResolvedIdentity,
  collections: string[],
): string[] {
  if (identity.allowedCollections === "*") return collections;
  const allowed = new Set(identity.allowedCollections);
  return collections.filter(c => allowed.has(c));
}

/**
 * Verify operation + collection access. Throws RBACDeniedError on failure.
 */
export function enforce(
  identity: ResolvedIdentity,
  operation: RBACOperation,
  collectionName?: string,
): void {
  enforceRateLimit(identity.tenantId, operation);

  if (!isPermitted(identity, operation)) {
    throw new RBACDeniedError(
      `Tenant '${identity.tenantId}' (role=${identity.role}) is not permitted to perform '${operation}'`
    );
  }

  if (collectionName && !canAccessCollection(identity, collectionName)) {
    throw new RBACDeniedError(
      `Tenant '${identity.tenantId}' does not have access to collection '${collectionName}'`
    );
  }
}

// =============================================================================
// Error types
// =============================================================================

export class RBACDeniedError extends Error {
  public readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "RBACDeniedError";
  }
}

// =============================================================================
// Diagnostic summary (for kindx doctor / status)
// =============================================================================

export function getRBACStatus(): {
  enabled: boolean;
  tenantCount: number;
  roles: Record<TenantRole, number>;
} {
  const registry = loadTenantRegistry();
  const tenants = Object.values(registry.tenants);
  const roles: Record<TenantRole, number> = { admin: 0, editor: 0, viewer: 0 };
  for (const t of tenants) {
    if (t.active) roles[t.role]++;
  }
  return {
    enabled: tenants.length > 0,
    tenantCount: tenants.filter(t => t.active).length,
    roles,
  };
}

// =============================================================================
// Rate Limiting
// =============================================================================

export class RateLimitExceededError extends Error {
  public readonly statusCode = 429;
  constructor(message: string) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

interface RateLimitTracker {
  tokens: number;
  lastRefill: number;
}

const rateLimits = new Map<string, RateLimitTracker>();

export function __resetRateLimitsForTests(): void {
  rateLimits.clear();
}

export function getRateLimitConfig() {
  const burst = parseInt(process.env.KINDX_RATE_LIMIT_BURST ?? "100", 10);
  const rateMs = parseInt(process.env.KINDX_RATE_LIMIT_MS ?? "1000", 10);
  return {
    burst: Number.isFinite(burst) && burst > 0 ? burst : 100,
    rateMs: Number.isFinite(rateMs) && rateMs > 0 ? rateMs : 1000
  };
}

export function enforceRateLimit(tenantId: string, operation?: RBACOperation): void {
  const now = Date.now();
  let tracker = rateLimits.get(tenantId);
  const cfg = getRateLimitConfig();
  
  if (!tracker) {
    tracker = { tokens: cfg.burst, lastRefill: now };
    rateLimits.set(tenantId, tracker);
  } else {
    const timeElapsed = now - tracker.lastRefill;
    const tokensToAdd = Math.floor(timeElapsed / cfg.rateMs);
    if (tokensToAdd > 0) {
      tracker.tokens = Math.min(cfg.burst, tracker.tokens + tokensToAdd);
      tracker.lastRefill = now;
    }
  }

  // F-004: Lightweight per-tenant rate limit middleware
  // Certain critical/admin operations bypass rate limit, or can have dynamic costs
  if (tracker.tokens <= 0) {
    throw new RateLimitExceededError(`Rate limit exceeded for tenant '${tenantId}' (max ${cfg.burst} reqs / ${(cfg.rateMs / 1000).toFixed(1)}s)`);
  }

  tracker.tokens -= 1;
}

// Memory cleanup for stale trackers
let _rlCleanupTimer: NodeJS.Timeout | null = null;
export function _startRateLimitCleanup() {
  if (_rlCleanupTimer) return;
  _rlCleanupTimer = setInterval(() => {
    const now = Date.now();
    const cfg = getRateLimitConfig();
    for (const [tenantId, tracker] of rateLimits.entries()) {
      if (now - tracker.lastRefill > cfg.rateMs * cfg.burst) {
        rateLimits.delete(tenantId);
      }
    }
  }, 60000);
  if (typeof _rlCleanupTimer.unref === "function") {
    _rlCleanupTimer.unref();
  }
}
_startRateLimitCleanup();
