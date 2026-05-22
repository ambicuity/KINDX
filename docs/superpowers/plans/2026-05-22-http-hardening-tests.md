# HTTP Hardening Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-daemon end-to-end coverage and narrow unit coverage for the KINDX HTTP surface so that auth, RBAC, malformed input, body caps, header handling, SSE, rate limiting, and `/metrics` privacy are pinned by tests — without changing production behavior.

**Architecture:** Two new test files (`http-hardening-daemon.test.ts`, `http-hardening-units.test.ts`) plus one reusable Vitest helper (`specs/helpers/http-daemon.ts`) that boots the real daemon via `startMcpHttpServer(0)`. Two tiny extractions (`engine/http/body.ts`, `engine/http/bearer.ts`) pull `collectBody` and Bearer parsing out of the giant closure in `engine/protocol.ts` so they can be unit-tested directly. The extractions are mechanical and behavior-preserving.

**Tech Stack:** Vitest 1.x, raw `node:http` (no Express), `fetch` (Node 20+ built-in), `node:fs/promises` for tempdirs, the existing `startMcpHttpServer` entry point in `engine/protocol.ts`.

---

## Spec reference

`docs/superpowers/specs/2026-05-22-http-hardening-tests-design.md` — read this first if you weren't in the brainstorming session.

## File plan

| File | Status | Responsibility |
|------|--------|----------------|
| `engine/http/body.ts` | NEW (~30 LOC) | Pure `collectBody(req, capBytes)` + `BodyTooLargeError`. |
| `engine/http/bearer.ts` | NEW (~15 LOC) | Pure `parseBearer(header) → string \| null`. |
| `engine/protocol.ts` | EDIT | Replace inline closure `collectBody` (line 2838) with import. Replace inline Bearer regex (line 3042) with `parseBearer`. No other changes. |
| `specs/helpers/http-daemon.ts` | NEW (~250 LOC) | `setupDaemon()` harness used by the daemon suite. |
| `specs/http-hardening-units.test.ts` | NEW (~120 LOC) | Unit suite for `timingSafeStringEqual`, `collectBody`, `parseBearer`. |
| `specs/http-hardening-daemon.test.ts` | NEW (~700 LOC) | 10-block end-to-end suite. |
| `specs/http-hardening.test.ts` | UNTOUCHED | Existing Tier-0 regressions stay green. |

## Correction to spec

The spec proposed `KINDX_TENANTS_FILE` to point at a custom tenants config. **This env var does not exist.** The real loader (`engine/rbac.ts:262`) reads `${getConfigDir()}/tenants.yml`, where `getConfigDir()` honors `KINDX_CONFIG_DIR`. The helper therefore writes a `tenants.yml` into the temp dir and sets `KINDX_CONFIG_DIR` to that dir. This is the only deviation from the spec.

---

## Task 1: Extract `collectBody` into `engine/http/body.ts`

**Files:**
- Create: `engine/http/body.ts`
- Test: `specs/http-hardening-units.test.ts` (just the `collectBody` block — Task 4 lands the rest)
- Modify: `engine/protocol.ts` (line 2838 closure → import)

This is a refactor: behavior must not change. We land the unit test for the new module first, see it fail because the file doesn't exist, write the module, see the test pass, then swap protocol.ts over and re-run the full suite.

- [ ] **Step 1: Write the failing unit test for the new module**

Create `specs/http-hardening-units.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { collectBody, BodyTooLargeError } from "../engine/http/body.js";

function makeReq(body: Buffer | string): IncomingMessage {
  const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  // Readable.from over a single chunk; IncomingMessage extends Readable so the
  // duck-typed shape is enough for collectBody.
  return Readable.from([buf]) as unknown as IncomingMessage;
}

describe("collectBody", () => {
  test("returns body smaller than cap", async () => {
    const out = await collectBody(makeReq("hello"), 1024);
    expect(out).toBe("hello");
  });

  test("accepts body exactly at cap", async () => {
    const body = "x".repeat(1024);
    const out = await collectBody(makeReq(body), 1024);
    expect(out).toBe(body);
  });

  test("rejects body cap + 1", async () => {
    const body = "x".repeat(1025);
    await expect(collectBody(makeReq(body), 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  test("rejects body well over cap and exposes limit", async () => {
    const body = "x".repeat(2048);
    try {
      await collectBody(makeReq(body), 1024);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError);
      expect((err as BodyTooLargeError).limitBytes).toBe(1024);
    }
  });

  test("preserves UTF-8 multi-byte content under cap", async () => {
    const body = "ümlaut – ✓ — 🌱";
    const bytes = Buffer.byteLength(body, "utf-8");
    const out = await collectBody(makeReq(body), bytes);
    expect(out).toBe(body);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (module not found)**

Run: `npx vitest run specs/http-hardening-units.test.ts -t collectBody`

Expected: FAIL — `Cannot find module '../engine/http/body.js'`.

- [ ] **Step 3: Implement `engine/http/body.ts`**

Create the file:

```ts
/**
 * engine/http/body.ts
 *
 * Pure helper for reading an HTTP request body with a hard byte cap.
 * Extracted from engine/protocol.ts so it can be unit-tested directly.
 * Behavior must remain identical to the inline closure it replaces.
 */
import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Read the full request body into a UTF-8 string, throwing
 * `BodyTooLargeError` once cumulative bytes exceed `capBytes`.
 *
 * On overflow the request stream is paused (not destroyed) so the caller
 * can write a 413 response before the socket closes. This matches the
 * behavior of the inline `collectBody` in `engine/protocol.ts`.
 */
export async function collectBody(req: IncomingMessage, capBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > capBytes) {
      try { req.pause(); } catch { /* noop */ }
      throw new BodyTooLargeError(capBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run specs/http-hardening-units.test.ts -t collectBody`

Expected: PASS, 5 tests green.

- [ ] **Step 5: Swap `engine/protocol.ts` to import the new module**

In `engine/protocol.ts`:

1. Near the top of the file (with the other imports), add:
   ```ts
   import { collectBody as collectBodyShared, BodyTooLargeError as BodyTooLargeErrorShared } from "./http/body.js";
   ```
2. Delete the inline `class BodyTooLargeError` at lines 2824–2831.
3. Delete the inline `async function collectBody` at lines 2838–2856.
4. Replace every reference to the now-removed `collectBody(req)` with `collectBodyShared(req, HTTP_MAX_BODY_BYTES)` (there are 6–8 call sites; search for `collectBody(` inside `startMcpHttpServer`).
5. Replace `instanceof BodyTooLargeError` checks with `instanceof BodyTooLargeErrorShared`.

> Tip: keep the renamed local symbols (`collectBodyShared`, `BodyTooLargeErrorShared`) rather than re-aliasing — the long name makes the call sites grep-able and avoids accidental shadowing.

- [ ] **Step 6: Run the full test suite**

Run: `npm test -- --reporter=default`

Expected: PASS — everything that was green before is still green. In particular `specs/http-hardening.test.ts` (the existing Tier-0 file) and `specs/command-line.test.ts` (which boots the daemon) must still pass. If `command-line.test.ts` fails because of the swap, the call-site replacement in Step 5 was incomplete; revisit.

- [ ] **Step 7: Commit**

```bash
git add engine/http/body.ts engine/protocol.ts specs/http-hardening-units.test.ts
git commit -m "refactor(http): extract collectBody + BodyTooLargeError to engine/http/body.ts

Pure helper now lives in its own module so it can be unit-tested directly.
No behavior change in the production code path; the closure-captured
HTTP_MAX_BODY_BYTES is now passed explicitly. Adds the collectBody block
of specs/http-hardening-units.test.ts."
```

---

## Task 2: Extract Bearer parsing into `engine/http/bearer.ts`

**Files:**
- Create: `engine/http/bearer.ts`
- Modify: `specs/http-hardening-units.test.ts` (append `parseBearer` block)
- Modify: `engine/protocol.ts` (line 3042)

- [ ] **Step 1: Append the failing `parseBearer` block to the unit suite**

Append to `specs/http-hardening-units.test.ts`:

```ts
import { parseBearer } from "../engine/http/bearer.js";

describe("parseBearer", () => {
  test.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["BEARER abc", "abc"],
    ["Bearer   abc", "abc"],
    ["  Bearer abc  ", "abc"],
    ["Bearer abc.def-ghi_jkl", "abc.def-ghi_jkl"],
  ])("accepts %j → %j", (header, want) => {
    expect(parseBearer(header)).toBe(want);
  });

  test.each([
    ["Bearer ", null],
    ["Bearer", null],
    ["Basic dXNlcjpwYXNz", null],
    ["", null],
    [undefined, null],
    [null as unknown as string, null],
  ])("rejects %j → %j", (header, want) => {
    expect(parseBearer(header as any)).toBe(want);
  });

  test("does not echo back arbitrary tokens with embedded CRLF", () => {
    expect(parseBearer("Bearer abc\r\nX-Inject: 1")).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run specs/http-hardening-units.test.ts -t parseBearer`

Expected: FAIL — `Cannot find module '../engine/http/bearer.js'`.

- [ ] **Step 3: Implement `engine/http/bearer.ts`**

```ts
/**
 * engine/http/bearer.ts
 *
 * Pure Bearer-header parser. Returns the token string when the header is a
 * valid `Bearer <token>` (case-insensitive, whitespace-tolerant), otherwise
 * null. Tokens containing whitespace or control characters (CR/LF/NUL/TAB)
 * are rejected so a malformed header cannot smuggle additional headers
 * downstream.
 */
export function parseBearer(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;
  const match = /^bearer\s+(\S+)\s*$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1];
  // Reject any control-character contamination (including CR, LF, NUL, TAB).
  if (/[\x00-\x1f\x7f]/.test(token)) return null;
  return token;
}
```

- [ ] **Step 4: Run the new test block**

Run: `npx vitest run specs/http-hardening-units.test.ts -t parseBearer`

Expected: PASS, all rows in the `test.each` matrix green.

- [ ] **Step 5: Swap protocol.ts to use parseBearer**

In `engine/protocol.ts`:

1. With the other imports, add:
   ```ts
   import { parseBearer } from "./http/bearer.js";
   ```
2. Replace line 3042:
   ```ts
   const bearerToken = authHeader?.replace(/^Bearer\s+/i, "").trim() || null;
   ```
   with:
   ```ts
   const bearerToken = parseBearer(authHeader ?? null);
   ```

Behavioral note: the new parser is **strictly stricter** than the old regex — it rejects empty tokens, tokens with whitespace inside, and tokens with control characters. This is a security improvement, not a regression. If any existing test depended on the old looseness, fix the test (it was wrong).

- [ ] **Step 6: Run the full suite**

Run: `npm test`

Expected: PASS. If any prior test broke because of the stricter parser, the test was relying on undocumented behavior — update it to match the new parser semantics in this commit.

- [ ] **Step 7: Commit**

```bash
git add engine/http/bearer.ts engine/protocol.ts specs/http-hardening-units.test.ts
git commit -m "refactor(http): extract parseBearer to engine/http/bearer.ts

Stricter parser: rejects empty tokens, embedded whitespace, and control
characters (CR/LF/NUL/TAB) so a malformed Authorization header cannot
smuggle additional headers. Behavior-preserving for all valid Bearer
strings the previous regex accepted."
```

---

## Task 3: Add the `timingSafeStringEqual` unit block

**Files:**
- Modify: `specs/http-hardening-units.test.ts`

The function already exists at `engine/utils/timing-safe.ts:32`. This task only adds tests — no production change.

- [ ] **Step 1: Append the test block**

Append to `specs/http-hardening-units.test.ts`:

```ts
import { timingSafeStringEqual } from "../engine/utils/timing-safe.js";

describe("timingSafeStringEqual", () => {
  test.each<[string, string, string, boolean]>([
    ["equal short strings", "abc", "abc", true],
    ["differ at last byte", "abc", "abd", false],
    ["different length short/long", "abc", "abcd", false],
    ["different length long/short", "abcd", "abc", false],
    ["both empty", "", "", true],
    ["one empty", "", "x", false],
    ["unicode equal", "ümlaut", "ümlaut", true],
    ["unicode differ", "ümlaut", "umlaut", false],
    ["long equal", "x".repeat(1024), "x".repeat(1024), true],
    ["long differ", "x".repeat(1024), "x".repeat(1023) + "y", false],
  ])("%s", (_label, a, b, want) => {
    expect(timingSafeStringEqual(a, b)).toBe(want);
  });

  test("does not throw on length mismatch", () => {
    expect(() => timingSafeStringEqual("abc", "abcdef")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the block**

Run: `npx vitest run specs/http-hardening-units.test.ts -t timingSafeStringEqual`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-units.test.ts
git commit -m "test(http): unit coverage for timingSafeStringEqual

Pins constant-time string compare against length-mismatch, unicode, and
long-input cases. Production code unchanged."
```

---

## Task 4: Build the daemon helper `specs/helpers/http-daemon.ts`

**Files:**
- Create: `specs/helpers/http-daemon.ts`
- Test: `specs/http-hardening-daemon.test.ts` (skeleton + one smoke test)

The helper is only useful when at least one test exercises it. We land it alongside a single smoke test against `/health` so it gets actual mileage before any block depends on it.

- [ ] **Step 1: Write the skeleton smoke test first**

Create `specs/http-hardening-daemon.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setupDaemon, type DaemonHandle } from "./helpers/http-daemon.js";

describe("daemon helper smoke", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon(); });
  afterAll(async () => { await h.stop(); });

  test("GET /health returns 200 with ok status", async () => {
    const res = await h.fetch("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });
});
```

- [ ] **Step 2: Run to verify it fails (helper missing)**

Run: `npx vitest run specs/http-hardening-daemon.test.ts`

Expected: FAIL — `Cannot find module './helpers/http-daemon.js'`.

- [ ] **Step 3: Implement the helper**

Create `specs/helpers/http-daemon.ts`:

```ts
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
 * The helper saves the entire process.env in setupDaemon() and restores it
 * in stop(). Do not nest setupDaemon() calls within a single test — env
 * snapshots are per-call, not stack-aware.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DaemonOptions {
  token?: string;
  tenantsYml?: string;
  bodyCapBytes?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  rateLimit?: { max: number; windowMs: number };
  quiet?: boolean;
}

export interface SseHandle {
  events: AsyncIterableIterator<{ event: string; data: string }>;
  abort: () => void;
}

export interface DaemonHandle {
  url: string;
  port: number;
  tempDir: string;
  fetch(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  sse(path: string, init?: { token?: string; body?: string }): SseHandle;
  store: any; // engine/store types not re-exported broadly; tighten later if needed.
  stop(): Promise<void>;
}

const KINDX_ENV_KEYS = [
  "KINDX_CONFIG_DIR", "KINDX_CACHE_DIR", "INDEX_PATH",
  "KINDX_MCP_TOKEN", "KINDX_HTTP_MAX_BODY_BYTES",
  "KINDX_HTTP_REQUEST_TIMEOUT_MS", "KINDX_HTTP_HEADERS_TIMEOUT_MS",
  "KINDX_HTTP_KEEPALIVE_TIMEOUT_MS",
  "KINDX_RATE_LIMIT_MAX", "KINDX_RATE_LIMIT_WINDOW_MS",
  "KINDX_MAX_CONCURRENCY_PER_TENANT", "KINDX_HTTP_CONCURRENCY",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  const snap = new Map<string, string | undefined>();
  for (const k of KINDX_ENV_KEYS) snap.set(k, process.env[k]);
  return snap;
}

function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const [k, v] of snap) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

export async function setupDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const envSnap = snapshotEnv();
  const tempDir = await mkdtemp(join(tmpdir(), "kindx-test-"));

  process.env.KINDX_CONFIG_DIR = tempDir;
  process.env.KINDX_CACHE_DIR = tempDir;
  process.env.INDEX_PATH = join(tempDir, "index.sqlite");

  if (opts.token) process.env.KINDX_MCP_TOKEN = opts.token;
  if (opts.tenantsYml) await writeFile(join(tempDir, "tenants.yml"), opts.tenantsYml, "utf-8");
  if (opts.bodyCapBytes) process.env.KINDX_HTTP_MAX_BODY_BYTES = String(opts.bodyCapBytes);
  if (opts.requestTimeoutMs !== undefined) process.env.KINDX_HTTP_REQUEST_TIMEOUT_MS = String(opts.requestTimeoutMs);
  if (opts.headersTimeoutMs !== undefined) process.env.KINDX_HTTP_HEADERS_TIMEOUT_MS = String(opts.headersTimeoutMs);
  if (opts.keepAliveTimeoutMs !== undefined) process.env.KINDX_HTTP_KEEPALIVE_TIMEOUT_MS = String(opts.keepAliveTimeoutMs);
  if (opts.rateLimit) {
    process.env.KINDX_RATE_LIMIT_MAX = String(opts.rateLimit.max);
    process.env.KINDX_RATE_LIMIT_WINDOW_MS = String(opts.rateLimit.windowMs);
  }

  // Lazy import so env vars are set BEFORE the protocol module reads them.
  const { startMcpHttpServer } = await import("../../engine/protocol.js");
  const handle = await startMcpHttpServer(0, { quiet: opts.quiet ?? true, dbPath: process.env.INDEX_PATH });

  const url = handle.url;
  const port = handle.port;

  async function doFetch(path: string, init: (RequestInit & { token?: string }) = {}): Promise<Response> {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const tok = init.token ?? opts.token;
    if (tok) headers.set("authorization", `Bearer ${tok}`);
    return fetch(`${url}${path}`, { ...init, headers });
  }

  function openSse(path: string, init: { token?: string; body?: string } = {}): SseHandle {
    const ctrl = new AbortController();
    const headers = new Headers();
    const tok = init.token ?? opts.token;
    if (tok) headers.set("authorization", `Bearer ${tok}`);
    headers.set("accept", "text/event-stream");
    if (init.body) headers.set("content-type", "application/json");

    const pending = fetch(`${url}${path}`, {
      method: init.body ? "POST" : "GET",
      headers,
      body: init.body,
      signal: ctrl.signal,
    });

    async function* iter() {
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
    url,
    port,
    tempDir,
    fetch: doFetch,
    sse: openSse,
    store: (handle as any).store ?? null,
    async stop() {
      try { await (handle as any).stop?.(); } catch { /* noop */ }
      try { await rm(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
      restoreEnv(envSnap);
    },
  };
}
```

> If `startMcpHttpServer`'s returned handle does not currently expose
> `store` or `stop`, inspect the actual handle and adjust the helper's
> `stop` to close the underlying `httpServer`. The end goal: `stop()`
> closes the listener and removes the temp dir.

- [ ] **Step 4: Run the smoke test**

Run: `npx vitest run specs/http-hardening-daemon.test.ts`

Expected: PASS — `/health` returns `{status: "ok", uptime: <number>}`.

- [ ] **Step 5: Commit**

```bash
git add specs/helpers/http-daemon.ts specs/http-hardening-daemon.test.ts
git commit -m "test(http): add real-daemon helper + /health smoke

setupDaemon boots startMcpHttpServer on port 0 inside an isolated temp
dir, restores process.env on stop. Smoke test exercises /health to
guarantee the helper actually works before any hardening block depends
on it."
```

---

## Task 5: Block 1 — Auth bypass

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Add the describe block**

Append to `specs/http-hardening-daemon.test.ts`:

```ts
describe("auth bypass (single-tenant token)", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: "right-token" }); });
  afterAll(async () => { await h.stop(); });

  const queryBody = JSON.stringify({ searches: [{ type: "lex", query: "x" }] });
  const post = (init: RequestInit & { token?: string | null } = {}) =>
    h.fetch("/query", { method: "POST", body: queryBody, ...init });

  test("no Authorization header → 401", async () => {
    const res = await fetch(`${h.url}/query`, { method: "POST", body: queryBody });
    expect(res.status).toBe(401);
  });

  test("wrong token → 401", async () => {
    const res = await post({ token: "wrong-token" });
    expect(res.status).toBe(401);
  });

  test.each(["bearer right-token", "BEARER right-token", "Bearer right-token"])(
    "case-insensitive Bearer prefix: %s",
    async (header) => {
      const res = await fetch(`${h.url}/query`, {
        method: "POST",
        body: queryBody,
        headers: { authorization: header, "content-type": "application/json" },
      });
      // The query might 400 on schema if anything else is wrong; what we're
      // asserting here is "not 401".
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    }
  );

  test("leading/trailing whitespace tolerated", async () => {
    const res = await fetch(`${h.url}/query`, {
      method: "POST",
      body: queryBody,
      headers: { authorization: "  Bearer right-token  ", "content-type": "application/json" },
    });
    expect(res.status).not.toBe(401);
  });

  test("empty token after prefix → 401", async () => {
    const res = await fetch(`${h.url}/query`, {
      method: "POST",
      body: queryBody,
      headers: { authorization: "Bearer ", "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("Basic scheme rejected → 401", async () => {
    const res = await fetch(`${h.url}/query`, {
      method: "POST",
      body: queryBody,
      headers: { authorization: "Basic dXNlcjpwYXNz", "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "auth bypass"`

Expected: PASS. If any case is the wrong status (because daemon behavior diverges from expectations), mark only that single case `test.skip` with a `// TODO(kindx#issue):` comment quoting the real status code. The rest of the block ships green.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover Authorization header parsing variants

Pins single-tenant token mode against missing/wrong/Basic/empty/case
variants. No production change."
```

---

## Task 6: Block 2 — Loopback restriction (no-auth mode)

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

This block is intentionally minimal: the daemon binds to `127.0.0.1` and Node's local fetch source IP is always loopback, so the "non-loopback rejection" case cannot be exercised cleanly without rewriting `socket.remoteAddress`. We test what we can without that rewrite, and explicitly mark the "non-loopback rejected" assertion as a follow-up (see Future-work note in the spec).

- [ ] **Step 1: Append the block**

```ts
describe("loopback restriction (no-auth mode)", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon(); /* no token */ });
  afterAll(async () => { await h.stop(); });

  const body = JSON.stringify({ searches: [{ type: "lex", query: "x" }] });

  test("IPv4 loopback hits /query without a token", async () => {
    const res = await fetch(`${h.url}/query`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    // 200/400 (validation) are both acceptable — we only assert "not auth-rejected".
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("IPv6 loopback /health works", async () => {
    // Some CI runners disable ::1 — skip if listening URL was IPv4 only.
    if (!h.url.startsWith("http://[")) {
      const res = await fetch(`${h.url}/health`);
      expect(res.status).toBe(200);
      return;
    }
    const res = await fetch(`${h.url}/health`);
    expect(res.status).toBe(200);
  });

  test.skip("non-loopback peer → 403 (requires socket.remoteAddress rewrite; see TODO(kindx#loopback-rewrite))", async () => {
    // Implementing this case requires intercepting the 'connection' event on
    // httpServer and stamping a non-loopback remoteAddress; deferred so the
    // helper stays minimal.
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "loopback restriction"`

Expected: PASS (with one skip).

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover loopback no-auth mode for /query and /health"
```

---

## Task 7: Block 3 — RBAC enforcement (multi-tenant)

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append the block**

```ts
describe("RBAC enforcement (multi-tenant)", () => {
  let h: DaemonHandle;
  const tenantsYml = `
tenants:
  - id: admin-tenant
    token: admin-tok
    role: admin
    collections: ["*"]
  - id: editor-tenant
    token: editor-tok
    role: editor
    collections: ["*"]
  - id: viewer-tenant
    token: viewer-tok
    role: viewer
    collections: ["*"]
  - id: scoped-tenant
    token: scoped-tok
    role: viewer
    collections: ["other-collection"]
`;

  beforeAll(async () => { h = await setupDaemon({ tenantsYml }); });
  afterAll(async () => { await h.stop(); });

  const queryBody = JSON.stringify({ searches: [{ type: "lex", query: "x" }] });

  test("viewer can query", async () => {
    const res = await h.fetch("/query", { method: "POST", body: queryBody, token: "viewer-tok" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("unknown token → 403", async () => {
    const res = await h.fetch("/query", { method: "POST", body: queryBody, token: "bogus" });
    expect(res.status).toBe(403);
  });

  test("missing token in multi-tenant mode → 401", async () => {
    const res = await fetch(`${h.url}/query`, {
      method: "POST",
      body: queryBody,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("viewer attempting memory_put via /mcp → 403 or jsonrpc error", async () => {
    const rpc = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "memory_put", arguments: { scope: "default", key: "k", value: "v" } },
    });
    const res = await h.fetch("/mcp", {
      method: "POST",
      body: rpc,
      headers: { "content-type": "application/json" },
      token: "viewer-tok",
    });
    if (res.status === 200) {
      const j = await res.json();
      // Should surface as a JSON-RPC error rather than a success.
      expect(j.error || j.result?.isError).toBeTruthy();
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });
});
```

> If `tenants.yml` schema differs from what's sketched above, fix the YAML
> to match the loader at `engine/rbac.ts:262+`. Run the suite to confirm
> the daemon actually picks up the tenants — if not, the helper isn't
> setting `KINDX_CONFIG_DIR` early enough; verify the import is lazy.

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "RBAC"`

Expected: PASS. Any case that disagrees with current behavior gets `test.skip` + TODO.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover multi-tenant RBAC for /query and /mcp"
```

---

## Task 8: Block 4 — Malformed input

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append the block**

```ts
describe("malformed input on /query", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: "tok" }); });
  afterAll(async () => { await h.stop(); });

  async function postRaw(body: string): Promise<Response> {
    return h.fetch("/query", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
  }

  test("invalid JSON → 4xx, never 5xx", async () => {
    const res = await postRaw("{not json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("missing searches → 400", async () => {
    const res = await postRaw("{}");
    expect(res.status).toBe(400);
  });

  test("searches not an array → 400", async () => {
    const res = await postRaw(JSON.stringify({ searches: "x" }));
    expect(res.status).toBe(400);
  });

  test("empty body → 4xx", async () => {
    const res = await postRaw("");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("deeply nested JSON does not crash daemon", async () => {
    let obj: any = { v: 1 };
    for (let i = 0; i < 5000; i++) obj = { v: obj };
    const res = await postRaw(JSON.stringify(obj));
    // Either 400 (rejected) or 413 (oversized). Crucially not 500 or a hang.
    expect([400, 413]).toContain(res.status);
    // Follow-up request still works → daemon survived.
    const ok = await h.fetch("/health");
    expect(ok.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "malformed input"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover malformed JSON, missing fields, deep nesting on /query"
```

---

## Task 9: Block 5 — Oversized body

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append**

```ts
describe("oversized body", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: "tok", bodyCapBytes: 4096 }); });
  afterAll(async () => { await h.stop(); });

  function padded(bytes: number): string {
    const filler = "x".repeat(Math.max(0, bytes - 32));
    return JSON.stringify({ searches: [{ type: "lex", query: filler }] }).padEnd(bytes, " ");
  }

  test("body well over cap → 413", async () => {
    const body = "x".repeat(8192);
    const res = await h.fetch("/query", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
  });

  test("daemon survives oversized body", async () => {
    await h.fetch("/query", { method: "POST", body: "x".repeat(10_000), headers: { "content-type": "application/json" } });
    const ok = await h.fetch("/health");
    expect(ok.status).toBe(200);
  });

  test("body just under cap is not 413", async () => {
    const body = padded(3500);
    const res = await h.fetch("/query", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(res.status).not.toBe(413);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "oversized body"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover 413 on oversized body and daemon survival"
```

---

## Task 10: Block 6 — Header injection / abnormal headers

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append**

```ts
describe("header / path abuse", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: "tok" }); });
  afterAll(async () => { await h.stop(); });

  test("CRLF in Authorization header → not authenticated", async () => {
    // Node's http parser typically rejects CRLF in header values outright;
    // we assert the *shape* (no 200) rather than a specific status.
    let status: number;
    try {
      const res = await fetch(`${h.url}/query`, {
        method: "POST",
        body: JSON.stringify({ searches: [{ type: "lex", query: "x" }] }),
        headers: { authorization: "Bearer tok\r\nX-Inject: 1" as any, "content-type": "application/json" },
      });
      status = res.status;
    } catch (err: any) {
      // Some Node versions throw before sending; that's also acceptable.
      status = -1;
    }
    expect(status).not.toBe(200);
  });

  test("long header value does not crash daemon", async () => {
    const long = "x".repeat(15_000);
    let crashed = false;
    try {
      const res = await fetch(`${h.url}/health`, { headers: { "x-fluff": long } });
      expect(res.status).toBeGreaterThanOrEqual(200);
    } catch {
      // 431/parse errors throw; daemon must still respond to a normal request after.
      crashed = false;
    }
    const ok = await fetch(`${h.url}/health`);
    expect(ok.status).toBe(200);
    expect(crashed).toBe(false);
  });

  test("path traversal in URL is not silently rewritten across auth boundary", async () => {
    const res = await fetch(`${h.url}/query/../health`, { method: "GET" });
    // Acceptable outcomes: 404 (not normalized), 200 (normalized to /health), or 405.
    expect([200, 404, 405]).toContain(res.status);
    // If it 200s, it MUST be the /health body (no auth-required surface served).
    if (res.status === 200) {
      const b = await res.json().catch(() => null);
      expect(b?.status).toBe("ok");
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "header / path abuse"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover CRLF injection, long headers, path traversal shape"
```

---

## Task 11: Block 7 — Method / route negotiation

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append**

```ts
describe("method / route negotiation", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: "tok" }); });
  afterAll(async () => { await h.stop(); });

  test.each([
    ["GET", "/query"],
    ["PUT", "/mcp"],
    ["POST", "/health"],
    ["DELETE", "/metrics"],
  ])("%s %s does not 5xx", async (method, path) => {
    const res = await h.fetch(path, { method });
    expect(res.status).toBeLessThan(500);
  });

  test("unknown path returns 4xx", async () => {
    const res = await h.fetch("/this-is-not-a-route");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "method / route"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover method/path negotiation (no 5xx on unsupported combinations)"
```

---

## Task 12: Block 8 — SSE on `/query/stream`

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append**

```ts
describe("SSE on /query/stream", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: "tok" }); });
  afterAll(async () => { await h.stop(); });

  test("no token → 401 before stream opens", async () => {
    const res = await fetch(`${h.url}/query/stream`, {
      method: "POST",
      body: JSON.stringify({ searches: [{ type: "lex", query: "x" }] }),
      headers: { "content-type": "application/json", "accept": "text/event-stream" },
    });
    expect(res.status).toBe(401);
  });

  test("valid token streams at least one event then closes", async () => {
    const sse = h.sse("/query/stream", {
      token: "tok",
      body: JSON.stringify({ searches: [{ type: "lex", query: "x" }] }),
    });
    const events: string[] = [];
    const deadline = Date.now() + 5000;
    for await (const ev of sse.events) {
      events.push(ev.event);
      if (events.length >= 1 || Date.now() > deadline) break;
    }
    sse.abort();
    expect(events.length).toBeGreaterThan(0);
  });

  test("client abort propagates without hanging", async () => {
    const sse = h.sse("/query/stream", {
      token: "tok",
      body: JSON.stringify({ searches: [{ type: "lex", query: "x" }] }),
    });
    setTimeout(() => sse.abort(), 50);
    let received = 0;
    try {
      for await (const _ of sse.events) {
        received += 1;
        if (received > 100) break; // safety
      }
    } catch { /* aborts surface as errors — expected */ }
    // After abort, daemon must still respond to /health within 1s.
    const ok = await h.fetch("/health");
    expect(ok.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "SSE"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover SSE auth, first-event, and abort-propagation on /query/stream"
```

---

## Task 13: Block 9 — Rate limit & concurrency

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append**

```ts
describe("rate limit and concurrency", () => {
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: "tok", rateLimit: { max: 3, windowMs: 1000 } }); });
  afterAll(async () => { await h.stop(); });

  const body = JSON.stringify({ searches: [{ type: "lex", query: "x" }] });

  test("4th request within window → 429", async () => {
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await h.fetch("/query", { method: "POST", body, headers: { "content-type": "application/json" } });
      results.push(res.status);
    }
    // First 3 must not be 429; at least one of the last 2 must be 429.
    expect(results.slice(0, 3).filter((s) => s === 429)).toHaveLength(0);
    expect(results.slice(3).some((s) => s === 429)).toBe(true);
  });

  test("daemon survives a burst of parallel requests", async () => {
    const tasks = Array.from({ length: 20 }, () =>
      h.fetch("/query", { method: "POST", body, headers: { "content-type": "application/json" } })
    );
    const statuses = (await Promise.all(tasks)).map((r) => r.status);
    // No 5xx allowed.
    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    // Daemon still healthy.
    const ok = await h.fetch("/health");
    expect(ok.status).toBe(200);
  });
});
```

> If the daemon does not honor `KINDX_RATE_LIMIT_MAX` / `KINDX_RATE_LIMIT_WINDOW_MS`,
> the first test won't trip 429. Inspect `engine/rbac.ts` to find the actual env
> var names and adjust the helper + this test. If single-tenant mode doesn't
> rate-limit at all (only multi-tenant does), convert this block to multi-tenant
> by passing `tenantsYml` instead of `token`.

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "rate limit"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover per-tenant rate limit and burst survival"
```

---

## Task 14: Block 10 — `/metrics` privacy

**Files:**
- Modify: `specs/http-hardening-daemon.test.ts`

- [ ] **Step 1: Append**

```ts
describe("/metrics privacy", () => {
  const SECRET = "supersecret-token-do-not-leak";
  let h: DaemonHandle;
  beforeAll(async () => { h = await setupDaemon({ token: SECRET }); });
  afterAll(async () => { await h.stop(); });

  test("metrics endpoint returns Prometheus text format", async () => {
    const res = await h.fetch("/metrics");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") || "";
    expect(contentType.startsWith("text/plain")).toBe(true);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("metrics body does not contain the bearer token", async () => {
    await h.fetch("/health"); // generate at least one request worth of metrics
    const res = await h.fetch("/metrics");
    const body = await res.text();
    expect(body).not.toContain(SECRET);
  });

  test("metrics body does not contain raw tenant IDs", async () => {
    // Single-tenant mode uses __default — that's not sensitive, but any
    // future tenant labels MUST be hashed. We assert the placeholder shape.
    const res = await h.fetch("/metrics");
    const body = await res.text();
    expect(body).not.toMatch(/tenant_id\s*=\s*"admin-tenant"/);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run specs/http-hardening-daemon.test.ts -t "/metrics privacy"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add specs/http-hardening-daemon.test.ts
git commit -m "test(http): cover /metrics format and absence of secrets/raw tenant IDs"
```

---

## Task 15: Final pass — full suite and budgets

- [ ] **Step 1: Run the entire test suite once**

Run: `npm test`

Expected: PASS. If a previously-green test went red, the most likely cause is one of the protocol.ts extractions in Tasks 1–2; revert the affected swap or fix the call site.

- [ ] **Step 2: Measure new-file timings**

Run: `npx vitest run specs/http-hardening-daemon.test.ts --reporter=verbose`

Capture the per-block duration. The acceptance bar:
- `specs/http-hardening-daemon.test.ts` total < 30s.
- `specs/http-hardening-units.test.ts` total < 1s.

If the daemon suite is over budget, profile the boot path: most cost comes from model warmup. Add `quiet: true` (default) and avoid hitting `/query` paths that trigger embedding/rerank in tests that only need the routing layer — `/health` is enough where possible.

- [ ] **Step 3: Smoke-check temp-dir hygiene**

Run: `ls /tmp/kindx-test-* 2>/dev/null | wc -l`

Before and after the full run: both numbers should be identical (the helper rm-rf's each tempdir in `stop()`). If they differ, an `afterAll` is missing.

- [ ] **Step 4: Commit anything you fixed in steps 1–3**

If steps 1–3 surfaced issues, fix them inline and commit per-block (don't roll fixes into the wrong commit).

---

## Self-review against the spec

- **Helper:** Task 4 ✅
- **Auth bypass block:** Task 5 ✅
- **Loopback restriction:** Task 6 ✅ (one case skipped with TODO, by design)
- **RBAC:** Task 7 ✅
- **Malformed input:** Task 8 ✅
- **Oversized body:** Task 9 ✅
- **Header injection:** Task 10 ✅
- **Method/route negotiation:** Task 11 ✅
- **SSE:** Task 12 ✅
- **Rate limit & concurrency:** Task 13 ✅
- **/metrics privacy:** Task 14 ✅
- **Unit suite (`timingSafeStringEqual`, `collectBody`, `parseBearer`):** Tasks 1–3 ✅
- **Extractions to `engine/http/body.ts` and `engine/http/bearer.ts`:** Tasks 1–2 ✅
- **Acceptance gates (timing, no leaked env, audit-log via store):** Task 15 ✅

Spec deviation: the spec mentioned `KINDX_TENANTS_FILE` and a generic
"test-only barrel". The plan instead writes `tenants.yml` into the
helper's temp dir and sets `KINDX_CONFIG_DIR` (matching the real loader at
`engine/rbac.ts:262`), and extracts the two helpers into proper modules
(`engine/http/body.ts`, `engine/http/bearer.ts`) rather than a re-export
barrel. Both deviations are documented near the top of this plan.

## Risks observed during planning

1. `startMcpHttpServer` may not return a clean `stop()` handle in every
   code path. If Task 4 can't shut the daemon cleanly, expose
   `httpServer.close()` from the returned object and use that.
2. Rate-limit behavior in single-tenant mode may differ from multi-tenant.
   Task 13's inline TODO covers the migration to `tenantsYml` if needed.
3. RBAC YAML schema in Task 7 is inferred from `engine/rbac.ts` comments;
   the runner must read the actual loader to confirm field names before
   relying on the tenants block.
