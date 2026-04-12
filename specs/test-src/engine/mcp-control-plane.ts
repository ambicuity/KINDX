import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type McpServerControlConfig = {
  enabled_tools?: string[];
  disabled_tools?: string[];
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  bearer_token_env_var?: string;
  project_scoped?: boolean;
};

export type McpControlPlaneConfig = {
  mcp_servers?: Record<string, McpServerControlConfig>;
};

export type ResolvedMcpServerControl = {
  id: string;
  enabled_tools: string[] | null;
  disabled_tools: string[];
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  http_headers: Record<string, string>;
  env_http_headers: Record<string, string>;
  bearer_token_env_var: string | null;
  project_scoped: boolean;
  trusted_project: boolean;
  config_hash: string;
  project_hash: string;
  source: "runtime" | "project" | "user" | "defaults";
};

const DEFAULT_STARTUP_TIMEOUT_SEC = 20;
const DEFAULT_TOOL_TIMEOUT_SEC = 60;
const DEFAULT_CACHE_TTL_MS = 300_000;

function boolFromEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isSafeHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function isSafeHeaderValue(value: string): boolean {
  return !/[\r\n]/.test(value);
}

function normalizeHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || !isSafeHeaderName(key)) continue;
    if (typeof v === "string") {
      if (!isSafeHeaderValue(v)) continue;
      out[key] = v;
    }
  }
  return out;
}

function normalizeTools(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function readJsonIfExists(path: string, sourceLabel?: string): McpControlPlaneConfig | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") {
      if (sourceLabel) {
        process.stderr.write(`KINDX Warning: ignoring invalid ${sourceLabel} config (expected JSON object): ${path}\n`);
      }
      return null;
    }
    return parsed as McpControlPlaneConfig;
  } catch (err) {
    if (sourceLabel) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`KINDX Warning: failed to parse ${sourceLabel} config ${path}: ${detail}\n`);
    }
    return null;
  }
}

function getKindxConfigRoot(): string {
  const cfg = process.env.KINDX_CONFIG_DIR?.trim();
  if (cfg) return resolve(cfg);
  return resolve(homedir(), ".config", "kindx");
}

function getKindxCacheRoot(): string {
  const cache = process.env.XDG_CACHE_HOME?.trim();
  if (cache) return resolve(cache, "kindx");
  return resolve(homedir(), ".cache", "kindx");
}

function getProjectRoot(cwd?: string): string {
  return resolve(cwd || process.cwd());
}

function getProjectConfigPath(cwd?: string): string {
  return resolve(getProjectRoot(cwd), ".kindx", "mcp-servers.json");
}

function getProjectTrustMarkerPath(cwd?: string): string {
  return resolve(getProjectRoot(cwd), ".kindx", "trusted");
}

function getUserConfigPath(): string {
  return resolve(getKindxConfigRoot(), "mcp-servers.json");
}

export function loadMcpControlPlaneConfig(cwd?: string): {
  runtime: McpControlPlaneConfig | null;
  project: McpControlPlaneConfig | null;
  user: McpControlPlaneConfig | null;
  trustedProject: boolean;
  projectHash: string;
} {
  const runtimeRaw = process.env.KINDX_MCP_SERVERS_JSON?.trim();
  const runtime = runtimeRaw ? (() => {
    try {
      const parsed = JSON.parse(runtimeRaw);
      if (!parsed || typeof parsed !== "object") {
        process.stderr.write("KINDX Warning: ignoring invalid KINDX_MCP_SERVERS_JSON (expected JSON object)\n");
        return null;
      }
      return parsed as McpControlPlaneConfig;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`KINDX Warning: failed to parse KINDX_MCP_SERVERS_JSON: ${detail}\n`);
      return null;
    }
  })() : null;

  const projectPath = getProjectConfigPath(cwd);
  const userPath = getUserConfigPath();
  const project = readJsonIfExists(projectPath, "project MCP");
  const user = readJsonIfExists(userPath, "user MCP");

  const trustedProject = boolFromEnv(process.env.KINDX_TRUST_PROJECT)
    || existsSync(getProjectTrustMarkerPath(cwd));

  const projectHash = stableHash({
    root: getProjectRoot(cwd),
    trustedProject,
  });

  return { runtime, project, user, trustedProject, projectHash };
}

function pickServerConfig(
  all: { runtime: McpControlPlaneConfig | null; project: McpControlPlaneConfig | null; user: McpControlPlaneConfig | null },
  id: string
): { source: ResolvedMcpServerControl["source"]; cfg: McpServerControlConfig } {
  const fromRuntime = all.runtime?.mcp_servers?.[id];
  if (fromRuntime) return { source: "runtime", cfg: fromRuntime };
  const fromProject = all.project?.mcp_servers?.[id];
  if (fromProject) return { source: "project", cfg: fromProject };
  const fromUser = all.user?.mcp_servers?.[id];
  if (fromUser) return { source: "user", cfg: fromUser };
  return { source: "defaults", cfg: {} };
}

export function resolveMcpServerControl(
  id: string,
  loaded: ReturnType<typeof loadMcpControlPlaneConfig>
): ResolvedMcpServerControl {
  const chosen = pickServerConfig(loaded, id);
  const cfg = chosen.cfg;
  const enabled = normalizeTools(cfg.enabled_tools);
  const disabled = normalizeTools(cfg.disabled_tools) ?? [];
  const startup = typeof cfg.startup_timeout_sec === "number" && cfg.startup_timeout_sec > 0
    ? Math.floor(cfg.startup_timeout_sec)
    : DEFAULT_STARTUP_TIMEOUT_SEC;
  const toolTimeout = typeof cfg.tool_timeout_sec === "number" && cfg.tool_timeout_sec > 0
    ? Math.floor(cfg.tool_timeout_sec)
    : DEFAULT_TOOL_TIMEOUT_SEC;
  const bearerEnv = typeof cfg.bearer_token_env_var === "string" && cfg.bearer_token_env_var.trim()
    ? cfg.bearer_token_env_var.trim()
    : null;
  const resolved: ResolvedMcpServerControl = {
    id,
    enabled_tools: enabled,
    disabled_tools: disabled,
    startup_timeout_sec: startup,
    tool_timeout_sec: toolTimeout,
    http_headers: normalizeHeaderMap(cfg.http_headers),
    env_http_headers: normalizeHeaderMap(cfg.env_http_headers),
    bearer_token_env_var: bearerEnv,
    project_scoped: cfg.project_scoped === true,
    trusted_project: loaded.trustedProject,
    config_hash: stableHash({ id, source: chosen.source, cfg }),
    project_hash: loaded.projectHash,
    source: chosen.source,
  };
  return resolved;
}

export function buildResolvedHttpHeaders(control: ResolvedMcpServerControl): Record<string, string> {
  const out: Record<string, string> = { ...control.http_headers };
  for (const [header, envName] of Object.entries(control.env_http_headers)) {
    if (!isSafeHeaderName(header)) continue;
    const envValue = process.env[envName];
    if (typeof envValue === "string" && envValue.trim() && isSafeHeaderValue(envValue)) {
      out[header] = envValue;
    }
  }
  if (control.bearer_token_env_var) {
    const token = process.env[control.bearer_token_env_var];
    if (typeof token === "string" && token.trim() && isSafeHeaderValue(token)) {
      out.Authorization = `Bearer ${token.trim()}`;
    }
  }
  return out;
}

export function isToolEnabledByPolicy(control: ResolvedMcpServerControl, toolName: string): boolean {
  if (control.project_scoped && !control.trusted_project) return false;
  const inEnabled = control.enabled_tools === null || control.enabled_tools.includes(toolName);
  const inDisabled = control.disabled_tools.includes(toolName);
  return inEnabled && !inDisabled;
}

export function applyToolPolicy(control: ResolvedMcpServerControl, toolNames: string[]): string[] {
  return toolNames.filter((name) => isToolEnabledByPolicy(control, name));
}

export type ToolProvenanceEntry = {
  tool_name: string;
  qualified_name: string;
  server_id: string;
  source: string;
};

export function buildToolProvenanceRegistry(serverId: string, toolNames: string[]): Record<string, ToolProvenanceEntry> {
  const out: Record<string, ToolProvenanceEntry> = {};
  for (const tool of toolNames) {
    out[tool] = {
      tool_name: tool,
      qualified_name: `mcp:${serverId}/${tool}`,
      server_id: serverId,
      source: "kindx-core",
    };
  }
  return out;
}

type ToolListCacheEnvelope = {
  key: string;
  expires_at: number;
  created_at: number;
  payload: unknown;
};

const CACHE_WARN_WINDOW_MS = 60_000;
const CACHE_TTL_SANITY_MULTIPLIER = 24;
const CACHE_WARN_STATE_SOFT_LIMIT = 1_000;
const CACHE_DISK_PRUNE_INTERVAL_MS = 60_000;
const cacheWarnState = new Map<string, number>();

function warnCache(code: string, key: string, detail: string): void {
  const now = Date.now();
  if (cacheWarnState.size > CACHE_WARN_STATE_SOFT_LIMIT) {
    for (const [k, ts] of cacheWarnState) {
      if (now - ts > CACHE_WARN_WINDOW_MS) {
        cacheWarnState.delete(k);
      }
    }
  }
  const dedupeKey = `${code}:${key}`;
  const last = cacheWarnState.get(dedupeKey);
  if (typeof last === "number" && now - last < CACHE_WARN_WINDOW_MS) return;
  cacheWarnState.set(dedupeKey, now);
  process.stderr.write(`KINDX Warning: mcp_tool_cache_${code} key=${key} ${detail}\n`);
}

function isValidEnvelopeShape(value: unknown): value is ToolListCacheEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.key === "string"
    && Number.isFinite(rec.created_at)
    && Number.isFinite(rec.expires_at)
    && "payload" in rec
  );
}

export class McpToolListCache {
  private readonly memory = new Map<string, ToolListCacheEnvelope>();
  private readonly ttlMs: number;
  private lastDiskPruneAt = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(ttlMs = DEFAULT_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  buildKey(parts: {
    accountId?: string | null;
    workspaceId?: string | null;
    projectHash: string;
    serverFingerprint: string;
  }): string {
    return stableHash({
      accountId: parts.accountId || null,
      workspaceId: parts.workspaceId || null,
      projectHash: parts.projectHash,
      serverFingerprint: parts.serverFingerprint,
    });
  }

  get(key: string): unknown | null {
    const now = Date.now();
    this.pruneExpiredInMemory(now);
    const mem = this.memory.get(key);
    if (mem && mem.expires_at > now) {
      return mem.payload;
    }
    if (mem) this.memory.delete(key);
    const disk = this.readDisk(key);
    if (!disk) return null;
    if (disk.expires_at <= now) {
      this.removeCorruptDisk(this.cachePath(key), key);
      return null;
    }
    this.memory.set(key, disk);
    return disk.payload;
  }

  set(key: string, payload: unknown): void {
    const now = Date.now();
    this.pruneExpiredInMemory(now);
    const envelope: ToolListCacheEnvelope = {
      key,
      created_at: now,
      expires_at: now + this.ttlMs,
      payload,
    };
    this.memory.set(key, envelope);
    this.enqueueDiskTask(async () => {
      await this.writeDisk(key, envelope);
      // Opportunistically clean up stale disk entries on a bounded cadence.
      await this.maybePruneExpiredDisk(Date.now());
    });
  }

  invalidate(key: string): void {
    this.memory.delete(key);
    this.enqueueDiskTask(() => this.deleteDisk(key));
  }

  invalidateAll(): void {
    this.memory.clear();
    this.enqueueDiskTask(async () => {
      const dir = this.cacheDir();
      const entries = await fsp.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const path = resolve(dir, entry);
        try {
          if (existsSync(path)) {
            await fsp.unlink(path);
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          warnCache("invalidate_failed", entry.replace(/\.json$/, ""), detail);
        }
      }
    });
  }

  private pruneExpiredInMemory(now: number): void {
    for (const [key, envelope] of this.memory.entries()) {
      if (envelope.expires_at <= now) {
        this.memory.delete(key);
      }
    }
  }

  async waitForIdleForTests(): Promise<void> {
    await this.writeQueue;
  }

  private enqueueDiskTask(task: () => Promise<void>): void {
    this.writeQueue = this.writeQueue
      .then(task)
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        warnCache("queue_failed", "global", detail);
      });
  }

  private async maybePruneExpiredDisk(now: number): Promise<void> {
    if (now - this.lastDiskPruneAt < CACHE_DISK_PRUNE_INTERVAL_MS) return;
    this.lastDiskPruneAt = now;
    await this.pruneExpiredDisk(now);
  }

  private async pruneExpiredDisk(now: number): Promise<void> {
    const dir = this.cacheDir();
    const entries = await fsp.readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const path = resolve(dir, entry);
      try {
        if (!existsSync(path)) continue;
        const parsed = JSON.parse(await fsp.readFile(path, "utf-8"));
        if (!isValidEnvelopeShape(parsed)) {
          await fsp.unlink(path);
          continue;
        }
        if (parsed.expires_at <= now) {
          await fsp.unlink(path);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warnCache("prune_failed", entry.replace(/\.json$/, ""), detail);
      }
    }
  }

  private validateEnvelope(key: string, parsed: unknown): ToolListCacheEnvelope | null {
    if (!isValidEnvelopeShape(parsed)) {
      warnCache("invalid_envelope", key, "invalid envelope shape");
      return null;
    }
    if (parsed.key !== key) {
      warnCache("invalid_envelope", key, `key mismatch envelope=${parsed.key}`);
      return null;
    }
    if (parsed.created_at > parsed.expires_at) {
      warnCache("invalid_envelope", key, "created_at is greater than expires_at");
      return null;
    }
    const futureSkewMs = parsed.created_at - Date.now();
    if (futureSkewMs > this.ttlMs) {
      warnCache("invalid_envelope", key, `created_at is too far in the future skew_ms=${futureSkewMs}`);
      return null;
    }
    const ttl = parsed.expires_at - parsed.created_at;
    if (ttl <= 0 || ttl > this.ttlMs * CACHE_TTL_SANITY_MULTIPLIER) {
      warnCache("invalid_envelope", key, `ttl out of range ttl_ms=${ttl}`);
      return null;
    }
    return parsed;
  }

  private removeCorruptDisk(path: string, key: string): void {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnCache("delete_failed", key, detail);
    }
  }

  private tempCachePath(key: string): string {
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return resolve(this.cacheDir(), `${key}.${nonce}.tmp`);
  }

  private async syncFd(fd: FileHandle): Promise<void> {
    await fd.sync();
  }

  private async fsyncPathBestEffort(path: string, key: string, kind: "file" | "dir"): Promise<void> {
    let fd: FileHandle | null = null;
    try {
      fd = await fsp.open(path, "r");
      await this.syncFd(fd);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnCache("fsync_failed", key, `${kind}:${detail}`);
    } finally {
      if (fd !== null) {
        try {
          await fd.close();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          warnCache("fsync_failed", key, `${kind}_close:${detail}`);
        }
      }
    }
  }

  private readDisk(key: string): ToolListCacheEnvelope | null {
    const path = this.cachePath(key);
    try {
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      const envelope = this.validateEnvelope(key, parsed);
      if (!envelope) {
        this.removeCorruptDisk(path, key);
        return null;
      }
      return envelope;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnCache("read_failed", key, detail);
      this.removeCorruptDisk(path, key);
      return null;
    }
  }

  private async writeDisk(key: string, envelope: ToolListCacheEnvelope): Promise<void> {
    const path = this.cachePath(key);
    const parentDir = dirname(path);
    const tempPath = this.tempCachePath(key);
    try {
      await fsp.mkdir(parentDir, { recursive: true });
      await fsp.writeFile(tempPath, JSON.stringify(envelope), { mode: 0o600 });
      await this.fsyncPathBestEffort(tempPath, key, "file");
      await fsp.rename(tempPath, path);
      await this.fsyncPathBestEffort(parentDir, key, "dir");
      try {
        await fsp.chmod(path, 0o600);
      } catch {
        // best effort permission tighten
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnCache("write_failed", key, detail);
      this.removeCorruptDisk(tempPath, key);
    }
  }

  private async deleteDisk(key: string): Promise<void> {
    const path = this.cachePath(key);
    try {
      if (existsSync(path)) {
        await fsp.unlink(path);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnCache("delete_failed", key, detail);
    }
  }

  private cacheDir(): string {
    const dir = resolve(getKindxCacheRoot(), "mcp-tool-cache");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private cachePath(key: string): string {
    return resolve(this.cacheDir(), `${key}.json`);
  }
}
