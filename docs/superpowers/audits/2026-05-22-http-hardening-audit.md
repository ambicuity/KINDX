# HTTP Hardening Audit — `feat/http-hardening-tests`

| Field | Value |
| --- | --- |
| Date | 2026-05-22 |
| Branch | `feat/http-hardening-tests` |
| Base | `main` |
| Audited commits | `31164450..ec96d549` (5 commits) |
| Scope | HTTP hardening infrastructure phase only — `engine/http/*`, `specs/http-hardening-*`, `specs/helpers/http-daemon.ts`, and the relevant slice of `engine/protocol.ts` |
| Lenses | Correctness · Security · Test Quality · Architecture |
| Deliverable type | Observational. Recommendations are explicit "consider X" notes, not implementation work. |

## Executive Summary

The branch lands the **infrastructure phase** of the broader HTTP hardening spec at `docs/superpowers/plans/2026-05-22-http-hardening-tests.md`: two small pure-function extractions (`bearer.ts`, `body.ts`), a robust real-daemon test helper (`specs/helpers/http-daemon.ts`), a working unit suite, and a single smoke test for the daemon suite. The code that landed is **tight, well-bounded, and behavior-tightening** (no regressions detected). The single highest-impact gap is **test coverage**: 10 daemon hardening blocks plus the `timingSafeStringEqual` unit block specified in the plan are not yet implemented. There is **one notable architectural foot-gun** in the auth path — single-tenant and multi-tenant modes reject malformed bearer headers through different mechanisms, which is fine today but invites divergence later.

**Recommendation rollup:** No blockers. Land the missing test blocks before the larger PR; route single-tenant auth through `parseBearer` for symmetry; add a `Retry-After` header to 429 responses.

## Methodology

Three parallel exploration passes:

1. **Module + unit-test pass.** Read `engine/http/bearer.ts`, `engine/http/body.ts`, `engine/utils/timing-safe.ts`, and `specs/http-hardening-units.test.ts` in full. Diffed against `main` to confirm extractions were behavior-preserving (they were not — they tightened input validation, intentionally).
2. **Helper + daemon-test pass.** Read `specs/helpers/http-daemon.ts` and `specs/http-hardening-daemon.test.ts` in full. Cross-referenced against the design plan to identify documented-but-unwritten test blocks.
3. **Integration pass.** Read the relevant slices of `engine/protocol.ts` (auth block, body collection call sites, central 413 handler, server boot) and `engine/rbac.ts` (token-hash resolution). Verified every documented call site for `parseBearer` and `collectBody`.

All findings cite `file:line`. The audit makes no source-code changes.

---

## Correctness

### High

*(none)*

### Medium

- **`parseBearer` semantics differ from the original inline parser** (`engine/http/bearer.ts:12-22`). The old inline parser in `protocol.ts` was `authHeader?.replace(/^Bearer\s+/i, "").trim() || null`, which silently accepted: tokens with embedded whitespace, non-Bearer schemes, and tokens carrying header-injection payloads. The new function rejects all three: requires `\S+` as the token (no embedded whitespace), requires the literal "Bearer" prefix, and rejects any token containing `[\x00-\x1f\x7f]`. This is a *tightening*, not a bug. But pre-existing clients that were sending non-conforming headers (e.g. `"Bearer abc\n"`, `"bearertoken"`) will now receive 401 where they previously received 200. **Consider:** add a note in the branch changelog calling this out so deployers can audit clients before merging.

### Low

- **`collectBody` swallows stream errors after an overflow** (`engine/http/body.ts:32-34`). When the byte total exceeds the cap, the function throws `BodyTooLargeError` and the surrounding `try { req.pause(); } catch {}` swallows any error from the pause call. Intentional: the caller (`protocol.ts:3796-3808`) responds with 413 + `Connection: close` and `req.destroy()`, so a stream-pause failure is irrelevant. But the silent catch is non-obvious. **Consider:** a one-line comment at `body.ts:33` explaining the contract (caller terminates the request; pause is best-effort).

### Nit

- **`Buffer.concat(chunks).toString("utf-8")`** (`engine/http/body.ts:38`) is explicit UTF-8 (good) but does not validate that the bytes are well-formed UTF-8. Malformed sequences are silently replaced with U+FFFD. Downstream `JSON.parse` will fail with a `SyntaxError` — the right behavior. **Consider:** if debuggability ever matters, switching to `Buffer.concat(chunks).toString("utf-8")` plus a fast `Buffer.compare` against a re-encoded round-trip would produce a sharper error. Probably not worth doing today.

---

## Security

### High

- **Single-tenant auth path bypasses `parseBearer`** (`engine/protocol.ts:3038`). The single-tenant branch compares the full raw `authHeader` against `"Bearer " + mcpToken` via `timingSafeStringEqual`. The multi-tenant branch parses the header with `parseBearer(authHeader ?? null)` first, then resolves the resulting token. Both paths *currently* reject the same malformed inputs, but through different mechanisms — and the rejection criteria are not identical. Concretely, `"Bearer\tabc"` is rejected by `parseBearer` (regex requires `\s+`, not `\s`, so a tab does match — but the token capture must be `\S+`, so the result is rejected when the regex fails to match the whole header due to trailing chars). In single-tenant, the same header is rejected only because the string compare to `"Bearer " + mcpToken` fails. The divergence becomes dangerous if a future contributor "fixes" one path without touching the other. **Recommend:** route single-tenant through `parseBearer` too:
  ```ts
  const parsed = parseBearer(authHeader ?? null);
  if (!parsed || !timingSafeStringEqual(parsed, mcpToken)) { /* 401 */ }
  ```
  Cost: 3 lines. Benefit: one validation path, both modes.

### Medium

- **Bearer-token byte length is unbounded** (`engine/http/bearer.ts:17`). The regex captures `\S+`, accepting tokens of arbitrary length. Node's default `http.maxHeaderSize` is 16 KB so the platform layer mitigates large-header DoS, but a per-token sanity cap is defense in depth and helps surface client bugs faster. **Consider:** reject tokens longer than 512 bytes. The `KINDX_MCP_TOKEN` written by the server is 32 bytes hex (64 chars); a 512-byte cap leaves 8× headroom for any future token format.
- **No `Retry-After` header on 429 responses** (`engine/protocol.ts:3072-3074`). RFC 6585 §4 recommends `Retry-After`. Without it, naive clients have no backoff guidance and can sustain the rate-limited load. The rate limiter already knows the window via `KINDX_RATE_LIMIT_WINDOW_MS`. **Consider:** add `"Retry-After": Math.ceil(windowMs / 1000)` to the 429 response headers.

### Low

- **Error response shapes are inconsistent across status codes.** 413 returns `{error, code: "payload_too_large"}` (`protocol.ts:3796-3808`); 401/403/429 return `{error}` only (`protocol.ts:3020-3046, 3072-3074`); the `/mcp` initialize path uses `{error, code: "tool_quota_exceeded"}` for its own 429 (`protocol.ts:3442`). Not a security issue. Clients doing machine-readable error handling have to special-case each endpoint. **Consider:** introduce a `code` field on every error shape (`unauthorized`, `forbidden`, `rate_limited`, etc.) in a follow-up.
- **`/metrics` is intentionally unauthenticated** (`engine/protocol.ts:2972-2998`, documented at `:3010`). Verified: the rendered Prometheus output contains pool sizes, queue depths, and timeout counters — no token, tenant ID, request body, or other sensitive data. Safe today. **Consider:** add a one-line test that asserts the `/metrics` body never contains the string `Bearer ` or the configured token, so a future contributor adding a new metric can't accidentally leak it.

### Nit

- **Default test token uses `randomBytes(32).toString("hex")`** (`specs/helpers/http-daemon.ts:146-149`). Good — high-entropy, no collisions across parallel tests, and keeps tests from polluting `~/.config/kindx/mcp_token`. No action.

---

## Test Quality

### High

- **10 daemon hardening blocks documented in the plan are not yet implemented.** `specs/http-hardening-daemon.test.ts` contains only a 1-test smoke block (`GET /health returns 200 with ok status`). Plan Tasks 5–14 — auth bypass, loopback restriction, RBAC, malformed input, oversized body, header abuse, method/route negotiation, SSE, rate limit, `/metrics` privacy — are designed in detail (see plan lines ~700–1200) but unwritten. The helper is built and ready. This is the largest gap in the branch and the most likely thing to be missed when reading the title of the PR (which says "real-daemon helper + `/health` smoke"). **Recommend:** the PR description should explicitly call out that the daemon hardening blocks are deferred to a follow-up.
- **`timingSafeStringEqual` unit block is missing from the new suite.** Plan Task 3 specifies it, alongside the `collectBody` and `parseBearer` blocks. The new file `specs/http-hardening-units.test.ts` imports only `parseBearer` and `collectBody`. A separate older file `specs/timing-safe.test.ts` exists and covers the function adequately — so coverage is not zero — but the plan asked for these three blocks to live together so the audit trail of "what we hardened" is a single file. **Recommend:** either move/copy the timing-safe tests into the new suite, or update the plan to acknowledge the existing file as sufficient.

### Medium

- **`collectBody` unit tests don't cover three boundary cases**: empty body (0 bytes), single-byte body, and `capBytes = 0`. The first two work correctly per the code; the third is an edge case where the function rejects the first byte (since `total > capBytes` with `total ≥ 1` is true). All three are cheap to add (one `test.each` row each) and would catch regressions if the bookkeeping math is ever changed.
- **`parseBearer` unit tests don't explicitly cover non-CRLF control chars** (NUL `\x00`, TAB `\x09`, DEL `\x7f`, BEL `\x07`). The regex `[\x00-\x1f\x7f]` rejects them all — confirmed by reading — but there's one standalone test for CRLF injection and no parametrized table for the rest. A `test.each` covering the whole rejection class is one block and adds confidence.

### Low

- **Smoke test asserts response shape but not the daemon port** (`specs/http-hardening-daemon.test.ts:9-15`). It checks `body.status === "ok"` and `typeof body.uptime === "number"`. **Consider:** also assert `h.port > 0 && h.port < 65536`. Tiny improvement; catches a class of helper-bootstrap bugs (port 0 not resolved, or accidentally bound to a privileged port).

### Nit

- **No flakiness has manifested**, but the planned blocks for SSE (Task 12) and rate limit (Task 13) are timing-sensitive by nature. **Consider:** when those land, run the suite 20× before merging to catch any latent race. Vitest's `--repeat` flag (or `npx vitest run --repeat=20 specs/http-hardening-daemon.test.ts`) makes this cheap.

---

## Architecture / Maintainability

### High

*(none)*

### Medium

- **`engine/protocol.ts` is a ~3,800 LOC monolith** (156 KB). Pre-existing — out of scope for this branch — but the HTTP hardening extractions on this branch demonstrate the right pattern: pull pure, testable functions into `engine/http/*.ts`, leave routing in `protocol.ts`. Continuing this pattern post-merge would benefit the route handlers themselves (`/query`, `/query/stream`, `/mcp` are each 100+ LOC closures with intertwined concerns: auth resolution, body collection, JSON parsing, schema validation, repository call, response shaping). **Consider:** a follow-up plan to extract route handlers into `engine/http/routes/*.ts`, one per route.

### Low

- **`BodyTooLargeError` is caught by `instanceof` check** at `engine/protocol.ts:3796`. This works because both `body.ts` and `protocol.ts` are part of the same npm package, same `tsc` output, single ESM module graph. KINDX is pure ESM, so this is safe today. **Consider:** a one-line comment in `body.ts` documenting that the error must be caught by `instanceof` (not by `name === "BodyTooLargeError"`), so future contributors don't mix the two styles.
- **`http-daemon.ts:80-82` exposes `store: null`** with a comment explaining the raw handle doesn't surface the SQLite store. Fine for the current smoke + planned hardening blocks (which only exercise HTTP). **Consider:** when a test later needs to verify e.g. that an indexed document landed in SQLite, the helper will need to grow a `store` accessor. The comment is clear and self-deprecating; no action today.
- **Helper warns about nested `setupDaemon()` calls** (`specs/helpers/http-daemon.ts:15-16`) but has no runtime guard. The env snapshot is captured fresh per call; a nested call would clobber the outer snapshot, and the inner `restoreEnv()` would only restore the inner-captured state, leaving the outer test environment corrupted. **Consider:** add a module-level `let active = false` boolean and throw if `setupDaemon()` is called while `active === true`. ~5 lines.

### Nit

- **Lazy dynamic import** of `startMcpHttpServer` (`specs/helpers/http-daemon.ts:172`: `await import("../../engine/protocol.js")`) is the right pattern. It ensures env vars set in the helper take effect before `protocol.ts` reads them at module-load time (e.g. `HTTP_MAX_BODY_BYTES` at `protocol.ts:2821`). **Consider:** add a comment explaining the rationale so a future maintainer doesn't "optimize" it back to a static import.

---

## Summary

| Lens | Blocker | High | Medium | Low | Nit | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Correctness | 0 | 0 | 1 | 1 | 1 | 3 |
| Security | 0 | 1 | 2 | 2 | 1 | 6 |
| Test Quality | 0 | 2 | 2 | 1 | 1 | 6 |
| Architecture | 0 | 0 | 1 | 3 | 1 | 5 |
| **Total** | **0** | **3** | **6** | **7** | **4** | **20** |

**Headline:** the three High findings are (1) the single-tenant / multi-tenant `parseBearer` divergence, and (2,3) the two test-coverage gaps relative to the plan. Everything else is defense-in-depth or polish.

---

## Appendix A — File Inventory (this branch vs `main`)

| File | Status | LOC | Notes |
| --- | --- | --- | --- |
| `engine/http/bearer.ts` | New | 23 | Pure function, no deps. |
| `engine/http/body.ts` | New | 40 | Pure function + error class; depends on `node:http` types only. |
| `engine/protocol.ts` | Modified | -25 / +10 | Removed inline `collectBody` + inline bearer parse; added 1 `parseBearer` call site, 4 `collectBody(req, HTTP_MAX_BODY_BYTES)` call sites, centralized 413 handler. |
| `specs/helpers/http-daemon.ts` | New | 258 | Real-daemon e2e helper; ephemeral port, temp dir, env snapshot/restore, SSE iterator. |
| `specs/http-hardening-units.test.ts` | New | ~80 | `collectBody` block (6 cases) + `parseBearer` block (12 cases + 1 standalone CRLF). |
| `specs/http-hardening-daemon.test.ts` | New | 16 | Single smoke test on `GET /health`. |
| `docs/superpowers/plans/2026-05-22-http-hardening-tests.md` | New | ~1200 | Full design plan + 15-task checklist. |

## Appendix B — Spec Acceptance Criteria Checklist

From `docs/superpowers/plans/2026-05-22-http-hardening-tests.md`:

| # | Criterion | Status |
| --- | --- | --- |
| 1 | `npm test` is green with both new test files | ⚠ Partial — units green, daemon green (smoke only), but daemon suite is a stub |
| 2 | `engine/http/body.ts` extracted with `collectBody(req, capBytes)` + `BodyTooLargeError` | ✓ |
| 3 | `engine/http/bearer.ts` extracted with `parseBearer(header)` and control-char rejection | ✓ |
| 4 | `specs/http-hardening-units.test.ts` covers `collectBody`, `parseBearer`, `timingSafeStringEqual` | ⚠ Missing `timingSafeStringEqual` block |
| 5 | `specs/helpers/http-daemon.ts` boots a real daemon with ephemeral port + temp dir | ✓ |
| 6 | `specs/http-hardening-daemon.test.ts` covers 10 hardening blocks | ✗ Smoke only; 0/10 blocks |
| 7 | Tier-0 regression suite `specs/http-hardening.test.ts` still passes | ✓ |
| 8 | Timing budgets verified for daemon suite | ✗ Pending blocks |

**Done:** 4 of 8 (50%). **Partial:** 2 of 8. **Pending:** 2 of 8.

## Appendix C — Reproducing the Findings

To re-verify any claim in this audit:

```bash
# Confirm the file inventory and diff against main
git log main..HEAD --stat
git diff main..HEAD -- engine/http/ engine/protocol.ts

# Confirm the unit suite contents
cat specs/http-hardening-units.test.ts | grep -E "^(describe|it|test)"

# Confirm the daemon suite is smoke-only
cat specs/http-hardening-daemon.test.ts

# Run the suites
npx vitest run specs/http-hardening-units.test.ts
npx vitest run specs/http-hardening-daemon.test.ts
npx vitest run specs/http-hardening.test.ts

# Confirm parseBearer / collectBody call sites in protocol.ts
grep -n "parseBearer\|collectBody\|BodyTooLargeError" engine/protocol.ts

# Confirm timingSafeStringEqual is used in single-tenant auth
grep -n "timingSafeStringEqual" engine/protocol.ts engine/rbac.ts
```

Each cited `file:line` reference in this report is reproducible with `git show HEAD:<path>` or by opening the file at the current branch HEAD.
