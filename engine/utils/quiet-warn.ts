/**
 * quiet-warn.ts
 *
 * Records a failure mode without log-spamming.
 *
 * Replaces the ~25 empty `catch {}` blocks the audit found scattered across
 * engine/. The pattern was: legitimate edge case (DB closed mid-shutdown,
 * filesystem race, parse error from external file) is caught and discarded so
 * production logs stay clean — but then real production failures of the same
 * shape become invisible too, and "MCP not stopping" debugging becomes
 * guesswork.
 *
 * `quietWarn(code, ctx?)`:
 *   - Always increments a counter `error.<code>` (visible at /metrics).
 *   - Logs `WARN` once per N occurrences (default 1; configurable per-code).
 *   - Never throws. Safe inside any catch.
 */

import { logger } from "./logger.js";
import { incCounter } from "./metrics.js";

const occurrences = new Map<string, number>();

export type QuietWarnOptions = {
  /** Log on every Nth occurrence. Default 1 (every time). */
  logEveryN?: number;
};

const codeRateLimits = new Map<string, number>();

/**
 * Configure per-code rate limiting. Useful for very chatty failure modes
 * (e.g. a watcher event that fires once per concurrent rename).
 */
export function configureQuietWarn(code: string, options: QuietWarnOptions): void {
  if (options.logEveryN && options.logEveryN > 0) {
    codeRateLimits.set(code, options.logEveryN);
  } else {
    codeRateLimits.delete(code);
  }
}

export function getQuietWarnCount(code: string): number {
  return occurrences.get(code) ?? 0;
}

export function resetQuietWarnForTests(): void {
  occurrences.clear();
  codeRateLimits.clear();
}

/**
 * Record a failure. Increments `error.<code>`, logs via WARN per rate limit.
 *
 * `code` should be a short, stable, dot-separated identifier suitable for a
 * Prometheus label — e.g. `"watcher.realpath_failed"`, `"audit.write_dropped"`.
 *
 * `ctx` is logged as structured metadata. Errors should be passed as `err`.
 */
export function quietWarn(code: string, ctx?: Record<string, unknown>): void {
  const next = (occurrences.get(code) ?? 0) + 1;
  occurrences.set(code, next);

  try { incCounter("error", 1, { code }); } catch { /* metrics must never crash callers */ }

  const rate = codeRateLimits.get(code) ?? 1;
  if (rate > 0 && next % rate !== 0 && next !== 1) return;

  // Normalize Error -> message for log payload safety.
  const meta: Record<string, unknown> = { code };
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (v instanceof Error) {
        meta[k] = v.message;
      } else {
        meta[k] = v;
      }
    }
  }
  try { logger.warn(`quiet: ${code}`, meta); } catch { /* logger must never crash callers */ }
}

/**
 * Helper: stringify an unknown error for `ctx.err`.
 */
export function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
