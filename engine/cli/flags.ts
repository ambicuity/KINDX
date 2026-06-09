/**
 * cli/flags.ts — declarative list of global flags added by the revamp.
 *
 * The existing `parseCLI()` in engine/kindx.ts owns argument parsing via
 * Node's `util.parseArgs`. This module supplies the *extra* option entries
 * to merge into that call without disturbing the existing command-specific
 * flags. It also provides a normalizer that interprets the merged values
 * into the typed shapes the rest of the CLI uses.
 */

import type { ParseArgsConfig } from "util";

type ParseArgsOptions = NonNullable<ParseArgsConfig["options"]>;

/**
 * Global flags added by the revamp. These are *additive* — every flag that
 * already exists in parseCLI() keeps working with its current semantics.
 *
 * Notable additions:
 *   --format <pretty|json|plain|cards|table|lines|csv|md|xml|files>
 *   --plain, --no-color, --color
 *   --verbose, --quiet, --debug, --trace
 *   --config, --profile, --timeout
 *   --confirm, --yes, --dry-run
 *   --limit, --candidate-limit, --min-score (already exist as -n/-C, kept as aliases)
 *   --interactive
 */
export const GLOBAL_FLAGS: ParseArgsOptions = {
  format: { type: "string" },
  plain: { type: "boolean" },
  "no-color": { type: "boolean" },
  color: { type: "boolean" },
  verbose: { type: "boolean" },
  quiet: { type: "boolean" },
  debug: { type: "boolean" },
  trace: { type: "boolean" },
  config: { type: "string" },
  profile: { type: "string" },
  timeout: { type: "string" },
  confirm: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  limit: { type: "string" },
  interactive: { type: "boolean", short: "i" },
  "show-scores": { type: "boolean" },
  "show-metadata": { type: "boolean" },
  open: { type: "boolean" },
};

/**
 * Parse a numeric flag value with a sensible default. Returns `fallback`
 * for `undefined` / non-numeric input rather than NaN.
 */
export function parseNumberFlag(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}
