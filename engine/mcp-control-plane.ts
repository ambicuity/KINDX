import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

function normalizeHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!k.trim()) continue;
    if (typeof v === "string") {
      out[k.trim()] = v;
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

function readJsonIfExists(path: string): McpControlPlaneConfig | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as McpControlPlaneConfig;
  } catch {
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
      return (parsed && typeof parsed === "object") ? (parsed as McpControlPlaneConfig) : null;
    } catch {
      return null;
    }
  })() : null;

  const projectPath = getProjectConfigPath(cwd);
  const userPath = getUserConfigPath();
  const project = readJsonIfExists(projectPath);
  const user = readJsonIfExists(userPath);

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
    const envValue = process.env[envName];
    if (typeof envValue === "string" && envValue.trim()) {
      out[header] = envValue;
    }
  }
  if (control.bearer_token_env_var) {
    const token = process.env[control.bearer_token_env_var];
    if (typeof token === "string" && token.trim()) {
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

export class McpToolListCache {
  private readonly memory = new Map<string, ToolListCacheEnvelope>();
  private readonly ttlMs: number;

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
    const mem = this.memory.get(key);
    if (mem && mem.expires_at > now) {
      return mem.payload;
    }
    if (mem) this.memory.delete(key);
    const disk = this.readDisk(key);
    if (!disk) return null;
    if (disk.expires_at <= now) {
      this.deleteDisk(key);
      return null;
    }
    this.memory.set(key, disk);
    return disk.payload;
  }

  set(key: string, payload: unknown): void {
    const envelope: ToolListCacheEnvelope = {
      key,
      created_at: Date.now(),
      expires_at: Date.now() + this.ttlMs,
      payload,
    };
    this.memory.set(key, envelope);
    this.writeDisk(key, envelope);
  }

  invalidate(key: string): void {
    this.memory.delete(key);
    this.deleteDisk(key);
  }

  invalidateAll(): void {
    this.memory.clear();
  }

  private cacheDir(): string {
    const dir = resolve(getKindxCacheRoot(), "mcp-tool-cache");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private cachePath(key: string): string {
    return resolve(this.cacheDir(), `${key}.json`);
  }

  private readDisk(key: string): ToolListCacheEnvelope | null {
    try {
      const path = this.cachePath(key);
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ToolListCacheEnvelope;
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeDisk(key: string, envelope: ToolListCacheEnvelope): void {
    try {
      const path = this.cachePath(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(envelope));
    } catch {
      // best effort cache
    }
  }

  private deleteDisk(key: string): void {
    try {
      const path = this.cachePath(key);
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch {
      // best effort
    }
  }
}
