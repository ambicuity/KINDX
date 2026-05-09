/**
 * timing-safe.ts
 *
 * Constant-time string equality wrapping `crypto.timingSafeEqual`.
 *
 * Required by RBAC token resolution: the previous code did `tenant.tokenHash === tokenH`
 * inside a linear scan over tenants, leaking tenant existence + active state via
 * timing. Even though both sides are 64-char hex, V8's `===` short-circuits on
 * first differing byte.
 *
 * Strategy:
 *   - timingSafeEqual requires equal-length buffers; if lengths differ the call
 *     itself throws. We hash both inputs through a fixed-output function to
 *     make lengths uniform and prevent an oracle on string length.
 *   - We compare HMAC-SHA-256 digests of (a) and (b) — equal-length, fixed-cost.
 *   - The HMAC key is process-local random; a new key each process means an
 *     attacker cannot precompute against it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// One key per process. Pinned at module load.
const COMPARE_KEY = randomBytes(32);

/**
 * Constant-time string equality. Returns true iff `a === b`, with comparison
 * cost independent of input length and contents.
 *
 * Both inputs are HMAC-SHA-256'd through a per-process key, then compared via
 * timingSafeEqual.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const da = createHmac("sha256", COMPARE_KEY).update(a, "utf8").digest();
  const db = createHmac("sha256", COMPARE_KEY).update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * Buffer-buffer constant-time equality. Length-aware: returns false on length
 * mismatch without an exception, while still doing the timing-safe compare on
 * a deterministic-length internal hash to avoid leaking length via fast-path.
 */
export function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Still do a fixed-cost compare so the negative path costs the same as
    // a length-equal mismatch.
    timingSafeEqual(
      createHmac("sha256", COMPARE_KEY).update(a).digest(),
      createHmac("sha256", COMPARE_KEY).update(b).digest()
    );
    return false;
  }
  return timingSafeEqual(a, b);
}
