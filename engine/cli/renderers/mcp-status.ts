/**
 * cli/renderers/mcp-status.ts — render `kindx mcp` lifecycle output.
 *
 * The renderer is **secret-aware**: any token-shaped value passed in is
 * masked with `maskSecret()` so the printed line shows only the last four
 * characters and never echoes the secret itself, regardless of the output
 * mode. This is the only place in the CLI where token values appear; no
 * other module should print them.
 */

import { paletteFor } from "../output.js";

export type McpTransport = "stdio" | "http" | "daemon";

export interface McpStatusData {
  transport: McpTransport;
  /** Listen port for HTTP/daemon modes. */
  port?: number;
  /** Bound host (e.g. "localhost"). */
  host?: string;
  /** Authentication mode label ("none", "bearer", "mtls"). */
  authMode?: string;
  /** Raw token string. NEVER stored or logged — only the last 4 chars are echoed. */
  token?: string;
  /** Process ID of the daemon, if applicable. */
  pid?: number;
  /** Absolute path to the PID file. */
  pidPath?: string;
  /** Absolute path to the daemon log. */
  logPath?: string;
  /** Health-check endpoint URL. */
  healthEndpoint?: string;
  /** Prometheus metrics endpoint URL. */
  metricsEndpoint?: string;
  /** Primary MCP transport endpoint URL. */
  mcpEndpoint?: string;
  /** Stop command suggestion. */
  stopCommand?: string;
}

/**
 * Mask a secret to last-4 visible characters. Returns `<unset>` for empty
 * input. Strings shorter than 4 chars are reduced to all asterisks so they
 * can never leak.
 */
export function maskSecret(token: string | undefined | null): string {
  if (!token) return "<unset>";
  if (token.length <= 4) return "*".repeat(token.length);
  return "*".repeat(Math.min(token.length - 4, 12)) + token.slice(-4);
}

/**
 * Construct the redacted JSON object suitable for emitting in --json output
 * or for embedding in `status --json`. The raw token is never carried; only
 * the masked form and whether a token is configured.
 */
export function redactedMcpStatus(data: McpStatusData): {
  transport: McpTransport;
  host?: string;
  port?: number;
  authMode?: string;
  tokenConfigured: boolean;
  tokenLast4?: string;
  pid?: number;
  pidPath?: string;
  logPath?: string;
  endpoints: { mcp?: string; health?: string; metrics?: string };
  stopCommand?: string;
} {
  return {
    transport: data.transport,
    ...(data.host ? { host: data.host } : {}),
    ...(data.port !== undefined ? { port: data.port } : {}),
    ...(data.authMode ? { authMode: data.authMode } : {}),
    tokenConfigured: Boolean(data.token),
    ...(data.token && data.token.length >= 4 ? { tokenLast4: data.token.slice(-4) } : {}),
    ...(data.pid !== undefined ? { pid: data.pid } : {}),
    ...(data.pidPath ? { pidPath: data.pidPath } : {}),
    ...(data.logPath ? { logPath: data.logPath } : {}),
    endpoints: {
      ...(data.mcpEndpoint ? { mcp: data.mcpEndpoint } : {}),
      ...(data.healthEndpoint ? { health: data.healthEndpoint } : {}),
      ...(data.metricsEndpoint ? { metrics: data.metricsEndpoint } : {}),
    },
    ...(data.stopCommand ? { stopCommand: data.stopCommand } : {}),
  };
}

/**
 * Render a multi-line pretty banner. Output deliberately omits the raw token
 * value; consumers needing the token must read it from its file/env source.
 */
export function renderMcpStatus(
  data: McpStatusData,
  opts: { color: boolean },
): string {
  const palette = paletteFor(opts.color);
  const out: string[] = [];

  out.push(palette.bold("KINDX MCP Server"));
  out.push(`  ${palette.dim("transport")}  ${data.transport}`);
  if (data.host || data.port) {
    out.push(`  ${palette.dim("listen")}     ${data.host ?? "localhost"}${data.port ? `:${data.port}` : ""}`);
  }
  if (data.mcpEndpoint) out.push(`  ${palette.dim("mcp")}        ${palette.cyan(data.mcpEndpoint)}`);
  if (data.healthEndpoint) out.push(`  ${palette.dim("health")}     ${palette.cyan(data.healthEndpoint)}`);
  if (data.metricsEndpoint) out.push(`  ${palette.dim("metrics")}    ${palette.cyan(data.metricsEndpoint)}`);
  if (data.authMode) {
    const tokenSuffix = data.token ? ` ${palette.dim("(token ****" + data.token.slice(-4) + ")")}` : "";
    out.push(`  ${palette.dim("auth")}       ${data.authMode}${tokenSuffix}`);
  }
  if (data.pid !== undefined) out.push(`  ${palette.dim("pid")}        ${data.pid}${data.pidPath ? palette.dim(`  (${data.pidPath})`) : ""}`);
  if (data.logPath) out.push(`  ${palette.dim("logs")}       ${data.logPath}`);
  if (data.stopCommand) {
    out.push("");
    out.push(`  ${palette.dim("stop with")}  ${palette.cyan(data.stopCommand)}`);
  }
  return out.join("\n");
}
