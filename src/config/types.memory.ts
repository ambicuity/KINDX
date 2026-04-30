import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "kindx";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryKindxSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  kindx?: MemoryKindxConfig;
};

export type MemoryKindxConfig = {
  command?: string;
  mcporter?: MemoryKindxMcporterConfig;
  searchMode?: MemoryKindxSearchMode;
  includeDefaultMemory?: boolean;
  paths?: MemoryKindxIndexPath[];
  sessions?: MemoryKindxSessionConfig;
  update?: MemoryKindxUpdateConfig;
  limits?: MemoryKindxLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryKindxMcporterConfig = {
  /**
   * Route KINDX searches through mcporter (MCP runtime) instead of spawning `kindx` per query.
   * Requires:
   * - `mcporter` installed and on PATH
   * - A configured mcporter server that runs `kindx mcp` with `lifecycle: keep-alive`
   */
  enabled?: boolean;
  /** mcporter server name (defaults to "kindx") */
  serverName?: string;
  /** Start the mcporter daemon automatically (defaults to true when enabled). */
  startDaemon?: boolean;
  /** Optional allowlist of mcporter KINDX tools that may be invoked. */
  enabledTools?: string[];
  /** Optional denylist of mcporter KINDX tools that are blocked. */
  disabledTools?: string[];
  /** Daemon startup timeout in seconds (default: 20). */
  startupTimeoutSec?: number;
  /** Tool call timeout in seconds (default: 60). */
  toolTimeoutSec?: number;
  /** Static HTTP headers for mcporter-managed KINDX MCP requests. */
  httpHeaders?: Record<string, string>;
  /** HTTP headers sourced from environment variables (header -> env var name). */
  envHttpHeaders?: Record<string, string>;
  /** Env var name that stores a bearer token for Authorization header injection. */
  bearerTokenEnvVar?: string;
  /** Restrict this bridge config to trusted projects only. */
  projectScoped?: boolean;
};

export type MemoryKindxIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryKindxSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryKindxUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryKindxLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
