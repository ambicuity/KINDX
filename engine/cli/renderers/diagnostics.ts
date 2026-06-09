/**
 * cli/renderers/diagnostics.ts — unified renderer for diagnostic-shaped
 * outputs (doctor, status, repair, scheduler status, verify-wipe).
 *
 * Each check is classified into one of five severities:
 *   - ok    : the check passed
 *   - warn  : non-fatal anomaly that the user should be aware of
 *   - error : the check failed; user action is required
 *   - skip  : the check was not applicable in this environment
 *   - rec   : an actionable recommendation (not a status, but rendered alongside)
 *
 * The renderer guarantees deterministic ordering (input order preserved
 * within each severity, severities printed ok → warn → error → skip → rec)
 * so golden tests are stable.
 */

import { paletteFor, glyphsFor } from "../output.js";

export type CheckSeverity = "ok" | "warn" | "error" | "skip" | "rec";

export interface DiagnosticCheck {
  id: string;
  severity: CheckSeverity;
  detail: string;
  recommendation?: string;
}

export interface DiagnosticsRenderOptions {
  title?: string;
  color: boolean;
  /** When false, hides the trailing summary line. */
  showSummary?: boolean;
  env?: NodeJS.ProcessEnv;
}

const SEVERITY_ORDER: CheckSeverity[] = ["ok", "warn", "error", "skip", "rec"];

function iconFor(sev: CheckSeverity, palette: ReturnType<typeof paletteFor>, glyphs: ReturnType<typeof glyphsFor>): string {
  switch (sev) {
    case "ok":    return palette.green(glyphs.ok);
    case "warn":  return palette.yellow(glyphs.warn);
    case "error": return palette.red(glyphs.err);
    case "skip":  return palette.dim(glyphs.skip);
    case "rec":   return palette.cyan(glyphs.hint);
  }
}

export function renderDiagnostics(
  checks: DiagnosticCheck[],
  opts: DiagnosticsRenderOptions,
): string {
  const palette = paletteFor(opts.color);
  const glyphs = glyphsFor(opts.env);
  const out: string[] = [];

  if (opts.title) out.push(palette.bold(opts.title));

  const sorted = [...checks].sort((a, b) =>
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  for (const ch of sorted) {
    out.push(`  ${iconFor(ch.severity, palette, glyphs)} ${ch.id}: ${ch.detail}`);
    if (ch.recommendation) {
      out.push(`     ${palette.dim(glyphs.hint + " " + ch.recommendation)}`);
    }
  }

  if (opts.showSummary !== false) {
    const counts = countBySeverity(checks);
    const parts: string[] = [];
    if (counts.ok)    parts.push(palette.green(`${counts.ok} ok`));
    if (counts.warn)  parts.push(palette.yellow(`${counts.warn} warn`));
    if (counts.error) parts.push(palette.red(`${counts.error} error`));
    if (counts.skip)  parts.push(palette.dim(`${counts.skip} skipped`));
    if (parts.length > 0) {
      out.push("");
      out.push(`  ${parts.join("  ")}`);
    }
  }

  return out.join("\n");
}

export function countBySeverity(checks: DiagnosticCheck[]): Record<CheckSeverity, number> {
  const counts: Record<CheckSeverity, number> = { ok: 0, warn: 0, error: 0, skip: 0, rec: 0 };
  for (const ch of checks) counts[ch.severity]++;
  return counts;
}

/**
 * Convert legacy doctor-style {id, ok, detail} entries into the new
 * severity-tagged structure. Anything not-ok becomes a warning unless its
 * id is known to be fatal (currently: db_integrity, ann_health, sqlite_vec).
 */
export function fromLegacyChecks(checks: { id: string; ok: boolean; detail: string }[]): DiagnosticCheck[] {
  const FATAL = new Set(["db_integrity", "sqlite_vec"]);
  return checks.map((ch) => ({
    id: ch.id,
    severity: ch.ok ? "ok" : FATAL.has(ch.id) ? "error" : "warn",
    detail: ch.detail,
  }));
}

/**
 * Compute an overall status string from a set of checks. Used in JSON
 * envelopes so consumers can branch on a single field.
 */
export function overallStatus(checks: DiagnosticCheck[]): "ok" | "warn" | "failed" {
  if (checks.some((c) => c.severity === "error")) return "failed";
  if (checks.some((c) => c.severity === "warn")) return "warn";
  return "ok";
}
