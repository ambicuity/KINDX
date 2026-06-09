# HTTP Hardening Test Coverage — Design

**Date:** 2026-05-22
**Status:** Draft, pending user review
**Owner:** BDFL @ambicuity (single owner)
**Scope:** Test-only. No engine behavior changes.

## Context

The KINDX HTTP daemon (`engine/protocol.ts:2939–3958`) serves `/health`,
`/ready`, `/metrics`, `/query` (alias `/search`), `/query/stream`, and `/mcp`.
It enforces three auth modes (multi-tenant RBAC, single-tenant token,
loopback-only no-auth), a per-tenant rate limiter, a per-tenant concurrency
policy, body caps, header/keep-alive timeouts, atomic `mcp_token` writes, and
constant-time string compare for tokens.

`specs/http-hardening.test.ts` (115 lines) currently asserts three Tier-0
regressions — body cap on a *synthetic* `http.createServer`, file perms on
`atomicWriteFile`, and type-level timeout assignability. It does **not**
exercise the real daemon, does **not** cover auth bypass, RBAC enforcement,
malformed input, header injection, SSE behavior, rate limiting, or metrics
leakage. Any regression in the real middleware stack would land silently.

The goal of this work is to add **real-daemon end-to-end coverage** so that
the production HTTP surface is the system under test, with a small set of
narrow unit cases reserved for pieces whose correctness is best asserted in
isolation (constant-time compare, body-cap byte-accounting, Bearer parser).

## Non-goals

- No production behavior changes. Tests must pass against `main` as-is. Any
  defect uncovered by these tests is filed separately; the test for that
  defect ships **xfail** (using `test.skip` with a `// TODO(kindx#XYZ)`
  comment) and lands green.
- No TLS / mTLS coverage — daemon does not terminate TLS today.
- No A2A / multimodal / observability route coverage — those endpoints don't
  exist yet on `main`.
- No actual timing-attack measurement. Reliable wall-clock-level timing
  assertions are flaky in CI; we verify the *call site* and *return type*
  of `timingSafeStringEqual` instead.
- No fuzzing or property-based coverage in this round.

## Files added

```
specs/helpers/http-daemon.ts            -- daemon lifecycle helper, exported reusable harness
specs/http-hardening-daemon.test.ts     -- real-daemon end-to-end suite
specs/http-hardening-units.test.ts      -- narrow unit suite for parser/compare
```

`specs/http-hardening.test.ts` (the existing Tier-0 file) is left untouched
to preserve the regression history.

## Helper: `specs/helpers/http-daemon.ts`

A small fixture that boots the real daemon on an ephemeral port, returns its
URL, and tears down cleanly. It owns env-var save/restore, temp directory
allocation, and optional `tenants.yml` provisioning.

### API

```ts
export interface DaemonOptions {
  /** Single-tenant token; if absent and tenantsYml absent, runs no-auth/loopback. */
  token?: string;
  /** Multi-tenant config (raw YAML string); writes to a temp file and points
   *  KINDX_TENANTS_FILE at it. Mutually exclusive with `token`. */
  tenantsYml?: string;
  /** Override body cap for /query and /mcp bodies (bytes). */
  bodyCapBytes?: number;
  /** Override request/headers/keep-alive timeouts (ms). */
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  /** Override per-tenant rate limit (req/window). */
  rateLimit?: { max: number; windowMs: number };
  /** Pre-populate the store with one or more collections + docs. */
  fixtures?: Array<{ collection: string; path: string; body: string }>;
  /** Suppress engine log noise (default true in tests). */
  quiet?: boolean;
}

export interface DaemonHandle {
  url: string;                                  // http://127.0.0.1:<port>
  port: number;
  /** Convenience for hitting the daemon with auth headers pre-set. */
  fetch(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  /** Open SSE; returns an iterator over events plus an abort() handle. */
  sse(path: string, init?: { token?: string; body?: string }): {
    events: AsyncIterableIterator<{ event: string; data: string }>;
    abort: () => void;
  };
  /** Direct access to the underlying store for audit-log assertions. */
  store: import("../../engine/store.js").Store;
  /** Tear everything down; restores env vars and removes temp dirs. */
  stop(): Promise<void>;
}

export async function setupDaemon(opts?: DaemonOptions): Promise<DaemonHandle>;
```

### Implementation notes

- Uses `startMcpHttpServer(0, { quiet: true, dbPath })` (existing export at
  `engine/protocol.ts:2475`). Port 0 lets the OS choose; the helper reads
  back via `httpServer.address()`.
- Each call mints a fresh temp directory via `mkdtemp(prefix("kindx-test-"))`
  to isolate `~/.cache/kindx`, models, and the SQLite file. Sets
  `KINDX_CACHE_DIR`, `KINDX_CONFIG_DIR`, `INDEX_PATH` accordingly.
- Saves the entire `process.env` snapshot in `beforeAll` and restores in
  `afterAll`.
- `fetch()` retries on `ECONNRESET` once with 50ms backoff to absorb
  occasional macOS-CI flakes; if it still fails, surfaces the error.
- `sse()` reads the response body as a stream, parses `event:` / `data:`
  lines, and yields. `abort()` calls `AbortController.abort()` so the
  daemon's client-abort propagation path is exercised.

### Reuse

Existing files that currently roll their own ad-hoc daemon setup
(`specs/mcp.test.ts`, `specs/mcp-control-plane.test.ts`) are left untouched
in this change. They can migrate to the helper later. The helper is
additive.

## Test file: `specs/http-hardening-daemon.test.ts`

One `describe` block per concern. All cases use `setupDaemon()`. Each block
boots its own daemon to keep failure isolation tight; total file expected to
boot ~10 ephemeral daemons.

### Block 1 — Auth bypass

| Case | Setup | Expected |
|------|-------|----------|
| No `Authorization` header | single-tenant, token set | 401 with JSON `{error: ...}` |
| Wrong token | single-tenant, token set | 401, constant-time path (cannot leak via length-of-response) |
| `Bearer` prefix case-insensitive | `bearer <token>`, `BEARER <token>` | 200 |
| Leading/trailing whitespace in header | `  Bearer <token>  ` | 200 |
| Empty token after prefix | `Authorization: Bearer ` | 401 |
| `Basic` scheme instead of `Bearer` | `Authorization: Basic dXNlcjpwYXNz` | 401 |
| Multiple `Authorization` headers | duplicated header | 401 (first wins or rejected; document outcome) |

### Block 2 — Loopback restriction (no-auth mode)

| Case | Setup | Expected |
|------|-------|----------|
| Loopback IPv4 hits `/query` no-auth | no token, `127.0.0.1` | 200 |
| Loopback IPv6 hits `/query` no-auth | no token, `::1` | 200 |
| IPv4-mapped IPv6 loopback | `::ffff:127.0.0.1` | 200 |
| Non-loopback source (simulated) | bind explicitly to `127.0.0.1`, but spoof `remoteAddress` via socket fixture | 403 |

> Implementation note for the spoof case: rather than create a real
> non-loopback peer, we wrap the daemon's `httpServer.on('connection')` in
> the helper to assign `socket.remoteAddress = '203.0.113.7'` for connections
> tagged via a test-only header `x-kindx-test-source-ip`. The wrapper is
> only enabled when `process.env.KINDX_TEST_SOCKET_REWRITE === '1'`.

### Block 3 — RBAC enforcement (multi-tenant)

`tenantsYml` provisions three tenants: `admin-tok`, `editor-tok`,
`viewer-tok`, plus a fourth tenant `b-tok` whose ACL excludes
`collection-a`.

| Case | Token | Action | Expected |
|------|-------|--------|----------|
| Viewer queries | viewer-tok | POST /query | 200 |
| Viewer attempts memory_put | viewer-tok | POST /mcp tools/call memory_put | 403 |
| Editor queries | editor-tok | POST /query | 200 |
| Editor calls admin tool | editor-tok | POST /mcp tools/call audit_log | 403 |
| Cross-tenant collection ACL | b-tok | POST /query filtered to `collection-a` | 200 with no results OR 403 (assert one, document) |
| Unknown token in multi-tenant | `bogus-tok` | any | 403 |

Audit-log assertions: for each 403, query `store.db` for an
`action='rbac_deny'` row with the matching tenant_hash within ~50ms.

### Block 4 — Malformed input

| Case | Body | Expected |
|------|------|----------|
| Invalid JSON | `{not json` | 400 with `code: bad_request`, daemon survives |
| Missing `searches` | `{}` | 400 |
| `searches` not array | `{searches: "x"}` | 400 |
| Each search missing `type` | `{searches: [{query:"x"}]}` | 400 |
| Each search bad `type` | `{searches: [{type:"sql", query:"x"}]}` | 400 |
| Deeply nested JSON (depth 10000) | recursive object | 400 or 413, no stack overflow |
| Empty body | `` | 400 |

### Block 5 — Oversized body

| Case | Setup | Expected |
|------|-------|----------|
| Just under cap | `bodyCapBytes=1024`, send 1023 bytes valid JSON | 200/400 (JSON error if invalid, not size error) |
| At cap | 1024 bytes | 200/400 |
| Just over cap | 1025 bytes | 413 with `payload_too_large` |
| Way over cap (1MB) | 1_048_576 bytes | 413, connection closed (`connection: close`) |
| Daemon survives oversized body | follow with a normal 200 request | succeeds |

### Block 6 — Header injection / abnormal headers

| Case | Header | Expected |
|------|--------|----------|
| CRLF in token | `Authorization: Bearer foo\r\nX-Inject: 1` | Node rejects at parse; 400 or socket reset |
| Extremely long header value (32KB) | random padded | 431 or 400 |
| Many headers (200) | flood | 431 or 400 |
| Path contains CRLF | `/query%0d%0aX-Inject:1` | Node rejects at parse |

> These tests rely on Node's default `maxHeaderSize` (16KB). The helper
> does not override it; if a future version of Node changes the default,
> the tests assert the *behavior shape* (4xx, no header reflection) rather
> than the exact status code.

### Block 7 — Method / route negotiation

| Case | Request | Expected |
|------|---------|----------|
| `GET /query` | -- | 405 or 404, never 500 |
| `POST /health` | -- | 405 or 404 |
| `PUT /mcp` | -- | 405 or 404 |
| Unknown path | `GET /nope` | 404 |
| `/query/../health` | path-traversal attempt | not silently rewritten; either 404 or normalized health (assert one) |

### Block 8 — SSE behavior on `/query/stream`

| Case | Setup | Expected |
|------|-------|----------|
| No token, multi-tenant | -- | 401 before any `event:` line |
| Valid token | -- | First event arrives within 1s; final event is `done` |
| Client abort mid-stream | call `abort()` after `event: retrieval` | server stops streaming within 1s, no leaked timers (`process._getActiveHandles().length` stable) |
| Backpressure | drain events slowly (100ms per read) | daemon keeps memory bounded; no `EPIPE` crash on close |

The backpressure assertion measures `process.memoryUsage().heapUsed` delta
across 200 events; the delta must remain under 50MB.

### Block 9 — Rate limit & concurrency

| Case | Setup | Expected |
|------|-------|----------|
| Tenant exceeds rate limit | `rateLimit: {max: 3, windowMs: 1000}`, send 5 requests | first 3 → 200/400, 4th and 5th → 429 |
| 429 emits audit | -- | audit log has `action='rate_limited'` with tenant_hash |
| Other tenant unaffected | second tenant sends 3 in same window | 3× success |
| Concurrency cap | spawn N parallel requests beyond cap | none crash; either queued (eventual 200) or `503` with `retry_after` |

### Block 10 — `/metrics` privacy

| Case | Setup | Expected |
|------|-------|----------|
| Metrics contain no tokens | request `/metrics`, grep response for the configured token | not present |
| Metrics contain no tenant ACL details | grep for tenant ID names | only hashed identifiers, never raw tenant IDs |
| Metrics format | -- | `text/plain; version=0.0.4; charset=utf-8` |

## Test file: `specs/http-hardening-units.test.ts`

Narrow, fast units. No daemon boot.

### Coverage

```ts
import { timingSafeStringEqual } from "../engine/utils/timing-safe.js";
import { collectBody } from "../engine/protocol.js";       // re-export to be added if private
import { parseBearer } from "../engine/protocol.js";       // re-export to be added if private

describe("timingSafeStringEqual", () => {
  test.each([
    ["equal strings", "abc", "abc", true],
    ["different content", "abc", "abd", false],
    ["different length short/long", "abc", "abcd", false],
    ["different length long/short", "abcd", "abc", false],
    ["both empty", "", "", true],
    ["one empty", "", "x", false],
  ])("%s", (_label, a, b, want) => {
    expect(timingSafeStringEqual(a, b)).toBe(want);
  });
});

describe("collectBody cap accounting", () => {
  test("accepts exactly cap bytes", ...);
  test("rejects cap + 1 bytes with 413-shape", ...);
  test("preserves UTF-8 multi-byte boundary at cap", ...);
});

describe("parseBearer", () => {
  test.each([
    ["Bearer x", "x"],
    ["bearer x", "x"],
    ["  Bearer   x  ", "x"],
    ["Bearer ", null],
    ["Basic dXNlcjpwYXNz", null],
    ["", null],
  ])("%s -> %s", (header, want) => {
    expect(parseBearer(header)).toBe(want);
  });
});
```

If `collectBody` and the bearer-parsing logic are not currently exported,
this design assumes they will be exposed via a new test-only barrel
`engine/protocol-internals.ts` that re-exports the two functions. The
barrel does not appear in the public API surface (`packages/kindx-client`
or `kindx` CLI) — it exists solely so tests can pin behavior at the unit
level. This is the only **non-test** code change required by this design
and is mechanical (~20 LOC).

## Acceptance criteria

1. `npm test` is green with both new files.
2. `specs/http-hardening-daemon.test.ts` completes in under 30s on a clean
   checkout (target p95 < 25s, observed via CI timing).
3. `specs/http-hardening-units.test.ts` completes in under 1s.
4. Helper `specs/helpers/http-daemon.ts` is reusable: provide a docstring
   and one minimal example call inside the file.
5. No test depends on a network connection.
6. No test mutates global state (env vars, working directory) without
   restoring it in `afterAll`.
7. Audit-log assertions in Block 3 and Block 9 verify against
   `store.db.prepare("SELECT action FROM audit_log WHERE ...").all()`,
   not via logger spies.
8. If any block uncovers a real defect on `main`, the affected case is
   committed as `test.skip` with an inline `// TODO(kindx#issue):` link;
   the rest of the suite ships green.

## Implementation order

1. Land `specs/helpers/http-daemon.ts` first (no test value alone, but
   nothing else compiles without it). Smoke it from a trivial test that
   asserts `/health → 200`.
2. Add `engine/protocol-internals.ts` if `collectBody`/`parseBearer` are
   not already exported. Keep the export list minimal and document with
   one inline comment that it is test-only.
3. Land `specs/http-hardening-units.test.ts`. Fast and independent.
4. Land `specs/http-hardening-daemon.test.ts` block-by-block. Each block
   should be committable on its own.

A single PR is acceptable if the diff stays under ~1000 LOC of test code.
If it grows, split into helper-PR + units-PR + daemon-PR.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Port flakes on busy CI | `setupDaemon` uses port 0 + retry once on `EADDRINUSE`. |
| Temp dirs leak | `afterAll` rm-rf with `force: true`; verified by a meta-test that counts `/tmp/kindx-test-*` entries before/after. |
| Env-var leaks between files | Helper snapshots `process.env` in `beforeAll`, restores in `afterAll`, asserts no stray `KINDX_*` keys remain. |
| Loopback spoof helper masks a real bug | The helper is opt-in via env var; production code path is untouched. Loopback enforcement still tested via real non-loopback bind only if the CI runner exposes a non-loopback interface (skipped otherwise). |
| Block 6 status codes drift with Node version | Tests assert *shape* (4xx, no header reflection) not exact code. |
| `/metrics` privacy assertions become stale as new metrics ship | Block 10 greps for any substring of the configured token; new metrics that don't add tokens won't false-positive. |

## Future extensions (out of scope here)

- Fuzz `/query` and `/mcp` bodies (e.g., via `fast-check`).
- Add a load test that asserts the daemon survives N concurrent SSE clients.
- Cover `/a2a/v1/*` routes once the A2A branch lands (see
  `docs/roadmap/2026/a2a-agent-interoperability.md`).
- Cover `/eval/*`, `/traces/*`, `/ui` once the observability branch lands.
- Migrate `specs/mcp.test.ts` and `specs/mcp-control-plane.test.ts` to the
  shared helper.

## Open questions for review

None. The design is intentionally test-only and additive. The single
non-test change is a test-only export barrel for two private helpers; if
the reviewer objects, those two unit blocks can be deleted and the design
proceeds with daemon coverage alone.
