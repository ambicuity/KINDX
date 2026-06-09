/**
 * specs/helpers/http-daemon.ts
 *
 * Boots the real KINDX HTTP daemon on an ephemeral port for end-to-end
 * tests. Each call mints an isolated temp directory so KINDX_CONFIG_DIR,
 * KINDX_CACHE_DIR, and INDEX_PATH don't collide with other tests.
 *
 * Usage:
 *   const h = await setupDaemon({ token: "tok" });
 *   const res = await h.fetch("/health");
 *   ...
 *   await h.stop();
 *
 * The helper saves the relevant process.env keys in setupDaemon() and
 * restores them in stop(). Do not nest setupDaemon() calls within a single
 * test — env snapshots are per-call, not stack-aware.
 *
 * Implementation notes
 * --------------------
 * startMcpHttpServer() returns:
 *   { httpServer, port, host, url, stop, controlPlane }
 *
 * where `url` is "http://<host>:<port>/mcp" (includes /mcp suffix).
 * The helper therefore constructs its own base URL from `host` and `port`
 * so that h.fetch("/health") reaches http://<host>:<port>/health correctly.
 *
 * There is no `store` field on the returned handle. DaemonHandle.store is
 * typed as any and always null for callers that need it — later tasks that
 * require store access should go through HTTP endpoints instead.
 *
 * When no KINDX_MCP_TOKEN is configured, the server auto-generates one and
 * writes it to ~/.config/kindx/mcp_token (hardcoded path, not affected by
 * KINDX_CONFIG_DIR). To keep tests hermetic and avoid polluting the real
 * config directory, setupDaemon() always sets KINDX_MCP_TOKEN to a random
 * hex string unless the caller supplied a token or tenantsYml.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface DaemonOptions {
  /** Single-tenant token; if absent and tenantsYml absent, a random token is
   *  generated automatically so the real ~/.config/kindx/mcp_token is not
   *  touched. Pass an explicit empty string to force zero-auth loopback mode. */
  token?: string;
  /** Multi-tenant config (raw YAML string); writes to <tempDir>/tenants.yml and
   *  points KINDX_CONFIG_DIR at <tempDir>. Mutually exclusive with `token`. */
  tenantsYml?: string;
  /** Override body cap for /query and /mcp bodies (bytes). */
  bodyCapBytes?: number;
  /** Override request/headers/keep-alive timeouts (ms). */
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  /** Override per-tenant rate limit (req/window). */
  rateLimit?: { max: number; windowMs: number };
  /** Suppress engine log noise (default true in tests). */
  quiet?: boolean;
}

export interface SseHandle {
  events: AsyncIterableIterator<{ event: string; data: string }>;
  abort: () => void;
}

export interface DaemonHandle {
  /** Base URL: http://<host>:<port> (no trailing slash, no /mcp suffix). */
  url: string;
  port: number;
  tempDir: string;
  /**
   * Perform a fetch against the daemon.
   * `path` must start with "/", e.g. "/health", "/mcp".
   * An Authorization header is added automatically when a token is configured.
   */
  fetch(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  sse(path: string, init?: { token?: string; body?: string }): SseHandle;
  /** Always null — the handle returned by startMcpHttpServer has no store field.
   *  Use HTTP endpoints to interact with storage in tests. */
  store: null;
  /** controlPlane from the underlying handle (rateLimiter, quotaManager, etc.) */
  controlPlane: any;
  stop(): Promise<void>;
}

// Environment variable keys that setupDaemon may modify and must restore.
const KINDX_ENV_KEYS = [
  "KINDX_CONFIG_DIR",
  "KINDX_CACHE_DIR",
  "INDEX_PATH",
  "KINDX_MCP_TOKEN",
  "KINDX_HTTP_MAX_BODY_BYTES",
  "KINDX_HTTP_REQUEST_TIMEOUT_MS",
  "KINDX_HTTP_HEADERS_TIMEOUT_MS",
  "KINDX_HTTP_KEEPALIVE_TIMEOUT_MS",
  "KINDX_RATE_LIMIT_MAX",
  "KINDX_RATE_LIMIT_WINDOW_MS",
  "KINDX_MAX_CONCURRENCY_PER_TENANT",
  "KINDX_HTTP_CONCURRENCY",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  const snap = new Map<string, string | undefined>();
  for (const k of KINDX_ENV_KEYS) snap.set(k, process.env[k]);
  return snap;
}

function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const [k, v] of snap) {
    if (v === undefined) delete process.env[k as string];
    else process.env[k as string] = v;
  }
}

/**
 * Start a KINDX HTTP daemon on an ephemeral port (port 0) inside an isolated
 * temp directory. Returns a handle with a `stop()` method that closes the
 * server, removes the temp directory, and restores env vars.
 */
export async function setupDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const envSnap = snapshotEnv();
  const tempDir = await mkdtemp(join(tmpdir(), "kindx-test-"));

  // Point all KINDX file I/O at the isolated temp dir.
  process.env.KINDX_CONFIG_DIR = tempDir;
  process.env.KINDX_CACHE_DIR = tempDir;
  process.env.INDEX_PATH = join(tempDir, "index.sqlite");

  // Determine token configuration.
  // - If caller supplied tenantsYml: write it and clear KINDX_MCP_TOKEN
  //   so the multi-tenant RBAC path activates.
  // - If caller supplied a token (including explicit ""): use it.
  // - Otherwise: generate a random token to keep ~/.config/kindx untouched.
  if (opts.tenantsYml) {
    await writeFile(join(tempDir, "tenants.yml"), opts.tenantsYml, "utf-8");
    delete process.env.KINDX_MCP_TOKEN;
  } else if (opts.token !== undefined) {
    if (opts.token === "") {
      // Caller explicitly wants zero-auth loopback mode.
      delete process.env.KINDX_MCP_TOKEN;
    } else {
      process.env.KINDX_MCP_TOKEN = opts.token;
    }
  } else {
    // Default: generate a random token to avoid writing to ~/.config/kindx.
    process.env.KINDX_MCP_TOKEN = randomBytes(32).toString("hex");
  }

  // Override body / timeout / rate-limit defaults if requested.
  if (opts.bodyCapBytes !== undefined) {
    process.env.KINDX_HTTP_MAX_BODY_BYTES = String(opts.bodyCapBytes);
  }
  if (opts.requestTimeoutMs !== undefined) {
    process.env.KINDX_HTTP_REQUEST_TIMEOUT_MS = String(opts.requestTimeoutMs);
  }
  if (opts.headersTimeoutMs !== undefined) {
    process.env.KINDX_HTTP_HEADERS_TIMEOUT_MS = String(opts.headersTimeoutMs);
  }
  if (opts.keepAliveTimeoutMs !== undefined) {
    process.env.KINDX_HTTP_KEEPALIVE_TIMEOUT_MS = String(opts.keepAliveTimeoutMs);
  }
  if (opts.rateLimit) {
    process.env.KINDX_RATE_LIMIT_MAX = String(opts.rateLimit.max);
    process.env.KINDX_RATE_LIMIT_WINDOW_MS = String(opts.rateLimit.windowMs);
  }

  // Lazy import so that env vars are in place BEFORE the protocol module reads
  // them at function-call time (env vars are read inside startMcpHttpServer,
  // not at module-import time, so a dynamic import is sufficient).
  const { startMcpHttpServer } = await import("../../engine/protocol.js");

  // Port 0 → OS assigns an ephemeral port.
  const rawHandle = await startMcpHttpServer(0, {
    quiet: opts.quiet ?? true,
    dbPath: process.env.INDEX_PATH,
  });

  // rawHandle shape (from HttpServerHandle type in engine/protocol.ts):
  //   { httpServer, port, host, url, stop, controlPlane }
  //
  // rawHandle.url === "http://<host>:<port>/mcp"  (includes /mcp suffix)
  // We expose a base URL without that suffix so h.fetch("/health") is correct.
  const baseUrl = `http://${rawHandle.host}:${rawHandle.port}`;
  const activeTok = opts.tenantsYml ? undefined : process.env.KINDX_MCP_TOKEN;

  function doFetch(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
    const { token: perCallToken, ...rest } = init;
    const headers = new Headers(rest.headers as HeadersInit | undefined);
    const tok = perCallToken ?? activeTok;
    if (tok) headers.set("authorization", `Bearer ${tok}`);
    return fetch(`${baseUrl}${path}`, { ...rest, headers });
  }

  function openSse(path: string, init: { token?: string; body?: string } = {}): SseHandle {
    const ctrl = new AbortController();
    const headers = new Headers();
    const tok = init.token ?? activeTok;
    if (tok) headers.set("authorization", `Bearer ${tok}`);
    headers.set("accept", "text/event-stream");
    if (init.body) headers.set("content-type", "application/json");

    const pending = fetch(`${baseUrl}${path}`, {
      method: init.body ? "POST" : "GET",
      headers,
      body: init.body,
      signal: ctrl.signal,
    });

    async function* iter(): AsyncGenerator<{ event: string; data: string }> {
      const res = await pending;
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let evt = "message";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) evt = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          yield { event: evt, data };
          evt = "message";
        }
      }
    }

    return { events: iter(), abort: () => ctrl.abort() };
  }

  return {
    url: baseUrl,
    port: rawHandle.port,
    tempDir,
    fetch: doFetch,
    sse: openSse,
    store: null,
    controlPlane: rawHandle.controlPlane,
    async stop() {
      // rawHandle.stop() closes the HTTP server, disposes sessions, and
      // closes the SQLite store — it's the canonical shutdown path.
      try { await rawHandle.stop(); } catch { /* noop */ }
      // Clean up the isolated temp directory.
      try { await rm(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
      // Restore original env vars so subsequent tests see a clean environment.
      restoreEnv(envSnap);
    },
  };
}
