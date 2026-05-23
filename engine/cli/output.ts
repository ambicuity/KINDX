/**
 * cli/output.ts — central output system for the KINDX CLI.
 *
 * Resolves an output mode (`pretty | json | plain`) once from environment +
 * flags, exposes color helpers that honor `--no-color`/`--color`/`NO_COLOR`,
 * and provides envelope helpers for the stable JSON contract that every
 * command emits when `--format json` (or `KINDX_JSON_ENVELOPE=1`) is set.
 *
 * The resolver is the *single source of truth* for "is this terminal
 * pretty / scriptable / dumb"; renderers and command handlers must call
 * `resolveOutputMode()` rather than checking TTY state directly.
 */

export type OutputMode = "pretty" | "json" | "plain";
export type OutputFormat =
  | "pretty"   // alias for "snippets" (the default pretty layout)
  | "snippets" // pretty kindx://...:N #docid / Title / Score / @@ diff snippet
  | "cards"    // pretty with card layout
  | "table"    // pretty with table layout
  | "lines"    // pretty one-line-per-result
  | "plain"    // ANSI-stripped text
  | "json"     // structured JSON
  | "csv"
  | "md"
  | "xml"
  | "files";

export type ProgressMode = "pretty-tty" | "pretty-log" | "ndjson" | "silent";

export interface OutputResolverInput {
  format?: string;
  json?: boolean;
  plain?: boolean;
  noColor?: boolean;
  color?: boolean;
  csv?: boolean;
  md?: boolean;
  xml?: boolean;
  files?: boolean;
  /** Suppress progress output entirely. */
  quiet?: boolean;
}

export interface ResolvedOutput {
  mode: OutputMode;
  format: OutputFormat;
  color: boolean;
  /** True when the user explicitly requested an output mode (--format, --json, --plain). */
  explicit: boolean;
  /** Selected progress paint mode for the active stderr stream. */
  progress: ProgressMode;
  /** True when glyphs/output should use UTF-8 (e.g. ✓ ▸); false → ASCII fallbacks. */
  glyphsUtf8: boolean;
}

const PRETTY_FORMATS = new Set<OutputFormat>(["pretty", "snippets", "cards", "table", "lines"]);
const PLAIN_FORMATS = new Set<OutputFormat>(["plain"]);
const STRUCTURED_FORMATS = new Set<OutputFormat>(["json", "csv", "md", "xml", "files"]);

function parseFormat(raw: string | undefined): OutputFormat | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (
    s === "pretty" || s === "snippets" || s === "cards" || s === "table" || s === "lines" ||
    s === "plain" || s === "json" || s === "csv" || s === "md" ||
    s === "xml" || s === "files"
  ) return s as OutputFormat;
  return undefined;
}

function modeFor(format: OutputFormat): OutputMode {
  if (format === "json") return "json";
  if (PLAIN_FORMATS.has(format)) return "plain";
  if (PRETTY_FORMATS.has(format)) return "pretty";
  // csv/md/xml/files: structured, not pretty
  return "plain";
}

/**
 * Resolve the active output mode and format from CLI flags + environment.
 *
 * Precedence (highest wins):
 *   1. `--format <value>`
 *   2. `--json` / `--plain` legacy booleans
 *   3. legacy `--csv`/`--md`/`--xml`/`--files` booleans
 *   4. `KINDX_OUTPUT` env var
 *   5. TTY detection (stdout.isTTY && !NO_COLOR → pretty, else plain)
 *
 * Color is on when stdout is a TTY and NO_COLOR/--no-color are absent.
 * `--color` forces it on; `--no-color` forces it off and beats `--color`.
 */
export function resolveOutputMode(
  input: OutputResolverInput,
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTty: boolean = Boolean(process.stdout?.isTTY),
  stderrIsTty: boolean = Boolean(process.stderr?.isTTY),
): ResolvedOutput {
  let format: OutputFormat | undefined;
  let explicit = false;

  // 1. --format
  const parsed = parseFormat(input.format);
  if (parsed) { format = parsed; explicit = true; }

  // 2. legacy --json / --plain
  if (!format && input.json) { format = "json"; explicit = true; }
  if (!format && input.plain) { format = "plain"; explicit = true; }

  // 3. legacy structured booleans
  if (!format && input.csv) { format = "csv"; explicit = true; }
  if (!format && input.md) { format = "md"; explicit = true; }
  if (!format && input.xml) { format = "xml"; explicit = true; }
  if (!format && input.files) { format = "files"; explicit = true; }

  // 4. KINDX_OUTPUT env
  if (!format) {
    const envFormat = parseFormat(env.KINDX_OUTPUT);
    if (envFormat) format = envFormat;
  }

  // 5. fallback: TTY → pretty, else plain
  if (!format) {
    format = stdoutIsTty && !env.NO_COLOR ? "pretty" : "plain";
  }

  // Color resolution
  let color: boolean;
  if (input.noColor) color = false;
  else if (input.color) color = true;
  else color = stdoutIsTty && !env.NO_COLOR && PRETTY_FORMATS.has(format);

  // Glyph set: utf8 unless the locale explicitly doesn't claim it.
  const locale = (env.LC_ALL || env.LC_CTYPE || env.LANG || "").toUpperCase();
  const glyphsUtf8 = locale.includes("UTF-8") || locale.includes("UTF8") ||
                     env.KINDX_FORCE_UTF8 === "1" ||
                     // When no locale hints exist at all (common in CI), assume utf8.
                     locale === "";

  const progress = pickProgressMode({
    format,
    color,
    glyphsUtf8,
    stderrIsTty,
    quiet: input.quiet,
    env,
  });

  return { mode: modeFor(format), format, color, explicit, progress, glyphsUtf8 };
}

/**
 * Decide which progress paint mode to use. Centralized so `resolveOutputMode()`
 * and direct callers from `progress.ts` agree on the same precedence:
 *
 *   1. `--quiet` flag or `KINDX_PROGRESS=off`         → silent
 *   2. format is structured (json/csv/md/xml/files)   → ndjson
 *   3. stderr is a TTY, color is on, glyphs are utf8  → pretty-tty
 *   4. otherwise                                       → pretty-log
 */
export function pickProgressMode(input: {
  format: OutputFormat;
  color: boolean;
  glyphsUtf8: boolean;
  stderrIsTty: boolean;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
}): ProgressMode {
  const env = input.env ?? process.env;
  if (input.quiet || env.KINDX_PROGRESS === "off" || env.KINDX_PROGRESS === "0") {
    return "silent";
  }
  if (
    input.format === "json" || input.format === "csv" ||
    input.format === "md"   || input.format === "xml" ||
    input.format === "files"
  ) {
    return "ndjson";
  }
  if (input.stderrIsTty && input.color && input.glyphsUtf8) return "pretty-tty";
  return "pretty-log";
}

/**
 * Strip ANSI escape sequences from a string. Used by `plain` mode and tests.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
          .replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Wrap `text` in an OSC 8 hyperlink escape so terminals that support it
 * (iTerm2, WezTerm, kitty, VS Code, Windows Terminal) render it as a
 * cmd/ctrl-clickable link. When `color` is false (pipes, NO_COLOR, dumb
 * terminals) returns the text unchanged.
 *
 * Format: ESC ] 8 ; ; URL BEL TEXT ESC ] 8 ; ; BEL
 *
 * `stripAnsi()` removes the wrapping bytes, so plain-mode output via the
 * existing helpers stays byte-equivalent.
 */
export function hyperlink(text: string, url: string, color: boolean): string {
  if (!color || !url) return text;
  // Strip control chars from URL to avoid escape injection.
  // eslint-disable-next-line no-control-regex
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, "");
  return `\x1b]8;;${safeUrl}\x07${text}\x1b]8;;\x07`;
}

/**
 * Build a file:// URL from an absolute filesystem path, with an optional
 * `#L<line>` anchor. Terminals that honor line anchors (some IDE protocols)
 * jump to that line; others ignore the fragment.
 *
 * Spaces and non-ASCII characters are percent-encoded; existing percent
 * sequences are preserved.
 */
export function fileUrl(absolutePath: string, opts: { line?: number } = {}): string {
  // encodeURI handles spaces, unicode, etc. but preserves path separators.
  const encoded = encodeURI(absolutePath);
  const anchor = opts.line ? `#L${opts.line}` : "";
  return `file://${encoded}${anchor}`;
}

/**
 * Returns a color helper that honors the active color setting. When `color`
 * is false, every wrapper is the identity function — this is what allows
 * renderers to be written in a single style and degrade gracefully.
 */
export function paletteFor(color: boolean): {
  reset: string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  cyan: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  magenta: (s: string) => string;
  blue: (s: string) => string;
  red: (s: string) => string;
} {
  const wrap = (open: string, close: string) =>
    color ? (s: string) => `${open}${s}${close}` : (s: string) => s;
  const RESET = "\x1b[0m";
  return {
    reset: color ? RESET : "",
    dim: wrap("\x1b[2m", RESET),
    bold: wrap("\x1b[1m", RESET),
    cyan: wrap("\x1b[36m", RESET),
    yellow: wrap("\x1b[33m", RESET),
    green: wrap("\x1b[32m", RESET),
    magenta: wrap("\x1b[35m", RESET),
    blue: wrap("\x1b[34m", RESET),
    red: wrap("\x1b[31m", RESET),
  };
}

/**
 * Glyph set selector: returns Unicode icons by default and ASCII fallbacks
 * when `LANG`/`LC_ALL`/`LC_CTYPE` lack a UTF-8 hint.
 */
export function glyphsFor(env: NodeJS.ProcessEnv = process.env): {
  ok: string;
  warn: string;
  err: string;
  skip: string;
  hint: string;
  bullet: string;
} {
  const locale = (env.LC_ALL || env.LC_CTYPE || env.LANG || "").toUpperCase();
  const utf8 = locale.includes("UTF-8") || locale.includes("UTF8") || env.KINDX_FORCE_UTF8 === "1";
  if (utf8) {
    return { ok: "✓", warn: "!", err: "✗", skip: "·", hint: "→", bullet: "•" };
  }
  return { ok: "[ok]", warn: "[!]", err: "[x]", skip: "[-]", hint: "->", bullet: "*" };
}

/**
 * Wrap a payload in the stable JSON envelope. Used by every command's JSON
 * output path so script authors see a consistent shape across the CLI.
 */
export function jsonEnvelope<T>(
  command: string,
  data: T,
  opts: { warnings?: string[]; meta?: Record<string, unknown> } = {},
): { ok: true; command: string; data: T; warnings?: string[]; meta?: Record<string, unknown> } {
  const out: { ok: true; command: string; data: T; warnings?: string[]; meta?: Record<string, unknown> } = {
    ok: true,
    command,
    data,
  };
  if (opts.warnings && opts.warnings.length > 0) out.warnings = opts.warnings;
  if (opts.meta && Object.keys(opts.meta).length > 0) out.meta = opts.meta;
  return out;
}

/**
 * True when the caller has opted into the new JSON envelope. While the
 * envelope is rolling out we honor an env var so existing JSON consumers
 * keep their current shape; new commands always emit the envelope.
 */
export function jsonEnvelopeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KINDX_JSON_ENVELOPE === "1" || env.KINDX_JSON_ENVELOPE === "true";
}

export { STRUCTURED_FORMATS, PRETTY_FORMATS };
