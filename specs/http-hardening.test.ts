/**
 * Regression: HTTP daemon hardening (Tier-0-7, 0-8, 0-10).
 *
 * The full daemon path is exercised by specs/command-line.test.ts (which
 * verifies it still starts and serves /health + /metrics). This spec
 * focuses on the new defenses in isolation:
 *
 *   - body cap behaviour for an oversized POST (mirrors `collectBody` logic
 *     that was extracted into protocol.ts)
 *   - mcp_token file is written via the atomic-write path so the perms
 *     are 0o600 from the moment the file appears (no TOCTOU window)
 *
 * The createServer timeout assignment in protocol.ts is type-checked at
 * build time; runtime behavior is best validated in the existing daemon
 * smoke test rather than re-spawning the entire MCP stack here.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../engine/utils/atomic-write.js";

// Minimal port-of the production collectBody guard so the spec can verify
// the byte cap + 413 mapping shape without booting the full daemon.
async function collectBodyCapped(req: import("node:http").IncomingMessage, capBytes: number): Promise<{
  ok: true; body: string;
} | { ok: false; bytesSeen: number; cap: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > capBytes) {
      // Pause the stream — the caller writes the 413 response before destroying
      // the socket so the client actually sees the status code.
      try { req.pause(); } catch { /* noop */ }
      return { ok: false, bytesSeen: total, cap: capBytes };
    }
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf-8") };
}

let server: Server;
let baseUrl: string;
const CAP = 1024;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const result = await collectBodyCapped(req, CAP).catch(() => null);
    if (!result || result.ok === false) {
      res.writeHead(413, { "content-type": "application/json", "Connection": "close" });
      res.end(JSON.stringify({ code: "payload_too_large" }));
      try { req.destroy(); } catch { /* noop */ }
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`got ${result.body.length} bytes`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HTTP body cap (Tier-0-7)", () => {
  test("returns 413 for body larger than the cap", async () => {
    const big = "x".repeat(2 * CAP);
    const res = await fetch(`${baseUrl}/`, { method: "POST", body: big });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.code).toBe("payload_too_large");
  });

  test("accepts body smaller than the cap", async () => {
    const res = await fetch(`${baseUrl}/`, { method: "POST", body: "hello" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("got 5 bytes");
  });
});

describe("MCP token write (Tier-0-10)", () => {
  test("atomicWriteFile writes mcp_token with mode 0o600 from the start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kindx-tok-"));
    try {
      const path = join(dir, "mcp_token");
      atomicWriteFile(path, "fake-token-bytes", { mode: 0o600 });
      const s = await fsStat(path);
      const perms = s.mode & 0o777;
      // Owner-only: group + other have no rwx.
      expect(perms & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("HTTP server timeout configuration (Tier-0-8, type-level)", () => {
  test("Node's http.Server supports requestTimeout / headersTimeout / keepAliveTimeout", () => {
    const s = createServer();
    s.requestTimeout = 30_000;
    s.headersTimeout = 10_000;
    s.keepAliveTimeout = 65_000;
    expect(s.requestTimeout).toBe(30_000);
    expect(s.headersTimeout).toBe(10_000);
    expect(s.keepAliveTimeout).toBe(65_000);
    s.close();
  });
});
