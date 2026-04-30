import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionSendPolicyConfig } from "../config/types.base.js";
import type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryKindxConfig,
  MemoryKindxIndexPath,
  MemoryKindxMcporterConfig,
  MemoryKindxSearchMode,
} from "../config/types.memory.js";
import { resolveUserPath } from "../utils.js";
import { splitShellArgs } from "../utils/shell-argv.js";

export type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
  kindx?: ResolvedKindxConfig;
};

export type ResolvedKindxCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

export type ResolvedKindxUpdateConfig = {
  intervalMs: number;
  debounceMs: number;
  onBoot: boolean;
  waitForBootSync: boolean;
  embedIntervalMs: number;
  commandTimeoutMs: number;
  updateTimeoutMs: number;
  embedTimeoutMs: number;
};

export type ResolvedKindxLimitsConfig = {
  maxResults: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  timeoutMs: number;
};

export type ResolvedKindxSessionConfig = {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type ResolvedKindxMcporterConfig = {
  enabled: boolean;
  serverName: string;
  startDaemon: boolean;
  enabledTools: string[] | null;
  disabledTools: string[];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
  httpHeaders: Record<string, string>;
  envHttpHeaders: Record<string, string>;
  bearerTokenEnvVar: string | null;
  projectScoped: boolean;
};

export type ResolvedKindxConfig = {
  command: string;
  mcporter: ResolvedKindxMcporterConfig;
  searchMode: MemoryKindxSearchMode;
  collections: ResolvedKindxCollection[];
  sessions: ResolvedKindxSessionConfig;
  update: ResolvedKindxUpdateConfig;
  limits: ResolvedKindxLimitsConfig;
  includeDefaultMemory: boolean;
  scope?: SessionSendPolicyConfig;
};

const DEFAULT_BACKEND: MemoryBackend = "builtin";
const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";
const DEFAULT_KINDX_INTERVAL = "5m";
const DEFAULT_KINDX_DEBOUNCE_MS = 15_000;
const DEFAULT_KINDX_TIMEOUT_MS = 4_000;
// Defaulting to `query` can be extremely slow on CPU-only systems (query expansion + rerank).
// Prefer a faster mode for interactive use; users can opt into `query` for best recall.
const DEFAULT_KINDX_SEARCH_MODE: MemoryKindxSearchMode = "search";
const DEFAULT_KINDX_EMBED_INTERVAL = "60m";
const DEFAULT_KINDX_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_KINDX_UPDATE_TIMEOUT_MS = 120_000;
const DEFAULT_KINDX_EMBED_TIMEOUT_MS = 120_000;
const DEFAULT_KINDX_LIMITS: ResolvedKindxLimitsConfig = {
  maxResults: 6,
  maxSnippetChars: 700,
  maxInjectedChars: 4_000,
  timeoutMs: DEFAULT_KINDX_TIMEOUT_MS,
};
const DEFAULT_KINDX_MCPORTER: ResolvedKindxMcporterConfig = {
  enabled: false,
  serverName: "kindx",
  startDaemon: true,
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: 20,
  toolTimeoutSec: 60,
  httpHeaders: {},
  envHttpHeaders: {},
  bearerTokenEnvVar: null,
  projectScoped: false,
};

const DEFAULT_KINDX_SCOPE: SessionSendPolicyConfig = {
  default: "deny",
  rules: [
    {
      action: "allow",
      match: { chatType: "direct" },
    },
  ],
};

function sanitizeName(input: string): string {
  const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed || "collection";
}

function scopeCollectionBase(base: string, agentId: string): string {
  return `${base}-${sanitizeName(agentId)}`;
}

function ensureUniqueName(base: string, existing: Set<string>): string {
  let name = sanitizeName(base);
  if (!existing.has(name)) {
    existing.add(name);
    return name;
  }
  let suffix = 2;
  while (existing.has(`${name}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${name}-${suffix}`;
  existing.add(unique);
  return unique;
}

function resolvePath(raw: string, workspaceDir: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("path required");
  }
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return path.normalize(resolveUserPath(trimmed));
  }
  return path.normalize(path.resolve(workspaceDir, trimmed));
}

function resolveIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_KINDX_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_KINDX_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveEmbedIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_KINDX_EMBED_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_KINDX_EMBED_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveDebounceMs(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_KINDX_DEBOUNCE_MS;
}

function resolveTimeoutMs(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

function resolveLimits(raw?: MemoryKindxConfig["limits"]): ResolvedKindxLimitsConfig {
  const parsed: ResolvedKindxLimitsConfig = { ...DEFAULT_KINDX_LIMITS };
  if (raw?.maxResults && raw.maxResults > 0) {
    parsed.maxResults = Math.floor(raw.maxResults);
  }
  if (raw?.maxSnippetChars && raw.maxSnippetChars > 0) {
    parsed.maxSnippetChars = Math.floor(raw.maxSnippetChars);
  }
  if (raw?.maxInjectedChars && raw.maxInjectedChars > 0) {
    parsed.maxInjectedChars = Math.floor(raw.maxInjectedChars);
  }
  if (raw?.timeoutMs && raw.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(raw.timeoutMs);
  }
  return parsed;
}

function resolveSearchMode(raw?: MemoryKindxConfig["searchMode"]): MemoryKindxSearchMode {
  if (raw === "search" || raw === "vsearch" || raw === "query") {
    return raw;
  }
  return DEFAULT_KINDX_SEARCH_MODE;
}

function resolveSessionConfig(
  cfg: MemoryKindxConfig["sessions"],
  workspaceDir: string,
): ResolvedKindxSessionConfig {
  const enabled = Boolean(cfg?.enabled);
  const exportDirRaw = cfg?.exportDir?.trim();
  const exportDir = exportDirRaw ? resolvePath(exportDirRaw, workspaceDir) : undefined;
  const retentionDays =
    cfg?.retentionDays && cfg.retentionDays > 0 ? Math.floor(cfg.retentionDays) : undefined;
  return {
    enabled,
    exportDir,
    retentionDays,
  };
}

function resolveCustomPaths(
  rawPaths: MemoryKindxIndexPath[] | undefined,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedKindxCollection[] {
  if (!rawPaths?.length) {
    return [];
  }
  const collections: ResolvedKindxCollection[] = [];
  rawPaths.forEach((entry, index) => {
    const trimmedPath = entry?.path?.trim();
    if (!trimmedPath) {
      return;
    }
    let resolved: string;
    try {
      resolved = resolvePath(trimmedPath, workspaceDir);
    } catch {
      return;
    }
    const pattern = entry.pattern?.trim() || "**/*.md";
    const baseName = scopeCollectionBase(entry.name?.trim() || `custom-${index + 1}`, agentId);
    const name = ensureUniqueName(baseName, existing);
    collections.push({
      name,
      path: resolved,
      pattern,
      kind: "custom",
    });
  });
  return collections;
}

function resolveMcporterConfig(raw?: MemoryKindxMcporterConfig): ResolvedKindxMcporterConfig {
  const parsed: ResolvedKindxMcporterConfig = { ...DEFAULT_KINDX_MCPORTER };
  if (!raw) {
    return parsed;
  }
  if (raw.enabled !== undefined) {
    parsed.enabled = raw.enabled;
  }
  if (typeof raw.serverName === "string" && raw.serverName.trim()) {
    parsed.serverName = raw.serverName.trim();
  }
  if (raw.startDaemon !== undefined) {
    parsed.startDaemon = raw.startDaemon;
  }
  const normalizeTools = (value: unknown): string[] | null => {
    if (value === undefined) {
      return null;
    }
    if (!Array.isArray(value)) {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  };
  parsed.enabledTools = normalizeTools(raw.enabledTools);
  parsed.disabledTools = normalizeTools(raw.disabledTools) ?? [];
  if (
    typeof raw.startupTimeoutSec === "number" &&
    Number.isFinite(raw.startupTimeoutSec) &&
    raw.startupTimeoutSec > 0
  ) {
    parsed.startupTimeoutSec = Math.floor(raw.startupTimeoutSec);
  }
  if (
    typeof raw.toolTimeoutSec === "number" &&
    Number.isFinite(raw.toolTimeoutSec) &&
    raw.toolTimeoutSec > 0
  ) {
    parsed.toolTimeoutSec = Math.floor(raw.toolTimeoutSec);
  }
  if (raw.httpHeaders && typeof raw.httpHeaders === "object") {
    parsed.httpHeaders = Object.fromEntries(
      Object.entries(raw.httpHeaders).filter(([k, v]) => k.trim() && typeof v === "string"),
    ) as Record<string, string>;
  }
  if (raw.envHttpHeaders && typeof raw.envHttpHeaders === "object") {
    parsed.envHttpHeaders = Object.fromEntries(
      Object.entries(raw.envHttpHeaders).filter(([k, v]) => k.trim() && typeof v === "string"),
    ) as Record<string, string>;
  }
  if (typeof raw.bearerTokenEnvVar === "string" && raw.bearerTokenEnvVar.trim()) {
    parsed.bearerTokenEnvVar = raw.bearerTokenEnvVar.trim();
  }
  if (raw.projectScoped !== undefined) {
    parsed.projectScoped = raw.projectScoped;
  }
  // When enabled, default startDaemon to true.
  if (parsed.enabled && raw.startDaemon === undefined) {
    parsed.startDaemon = true;
  }
  return parsed;
}

function resolveDefaultCollections(
  include: boolean,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedKindxCollection[] {
  if (!include) {
    return [];
  }
  const entries: Array<{ path: string; pattern: string; base: string }> = [
    { path: workspaceDir, pattern: "MEMORY.md", base: "memory-root" },
    { path: workspaceDir, pattern: "memory.md", base: "memory-alt" },
    { path: path.join(workspaceDir, "memory"), pattern: "**/*.md", base: "memory-dir" },
  ];
  return entries.map((entry) => ({
    name: ensureUniqueName(scopeCollectionBase(entry.base, agentId), existing),
    path: entry.path,
    pattern: entry.pattern,
    kind: "memory",
  }));
}

export function resolveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
  if (backend !== "kindx") {
    return { backend: "builtin", citations };
  }

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const kindxCfg = params.cfg.memory?.kindx;
  const includeDefaultMemory = kindxCfg?.includeDefaultMemory !== false;
  const nameSet = new Set<string>();
  const collections = [
    ...resolveDefaultCollections(includeDefaultMemory, workspaceDir, nameSet, params.agentId),
    ...resolveCustomPaths(kindxCfg?.paths, workspaceDir, nameSet, params.agentId),
  ];

  const rawCommand = kindxCfg?.command?.trim() || "kindx";
  const parsedCommand = splitShellArgs(rawCommand);
  const command = parsedCommand?.[0] || rawCommand.split(/\s+/)[0] || "kindx";
  const resolved: ResolvedKindxConfig = {
    command,
    mcporter: resolveMcporterConfig(kindxCfg?.mcporter),
    searchMode: resolveSearchMode(kindxCfg?.searchMode),
    collections,
    includeDefaultMemory,
    sessions: resolveSessionConfig(kindxCfg?.sessions, workspaceDir),
    update: {
      intervalMs: resolveIntervalMs(kindxCfg?.update?.interval),
      debounceMs: resolveDebounceMs(kindxCfg?.update?.debounceMs),
      onBoot: kindxCfg?.update?.onBoot !== false,
      waitForBootSync: kindxCfg?.update?.waitForBootSync === true,
      embedIntervalMs: resolveEmbedIntervalMs(kindxCfg?.update?.embedInterval),
      commandTimeoutMs: resolveTimeoutMs(
        kindxCfg?.update?.commandTimeoutMs,
        DEFAULT_KINDX_COMMAND_TIMEOUT_MS,
      ),
      updateTimeoutMs: resolveTimeoutMs(
        kindxCfg?.update?.updateTimeoutMs,
        DEFAULT_KINDX_UPDATE_TIMEOUT_MS,
      ),
      embedTimeoutMs: resolveTimeoutMs(
        kindxCfg?.update?.embedTimeoutMs,
        DEFAULT_KINDX_EMBED_TIMEOUT_MS,
      ),
    },
    limits: resolveLimits(kindxCfg?.limits),
    scope: kindxCfg?.scope ?? DEFAULT_KINDX_SCOPE,
  };

  return {
    backend: "kindx",
    citations,
    kindx: resolved,
  };
}
