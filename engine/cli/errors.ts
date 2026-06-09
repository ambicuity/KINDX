/**
 * cli/errors.ts — central error model for the KINDX CLI.
 *
 * KindxError carries everything a user needs to recover from a failure:
 * a stable machine-readable `code`, a one-line `what`, optional `why`/`fix`
 * lines, and `examples` of next-step commands. The top-level catch in the
 * CLI entrypoint formats this into pretty or JSON output and propagates
 * the chosen `exitCode`.
 */

export type KindxExitCode =
  | 0   // success
  | 1   // generic error
  | 2   // usage / doctor-failed
  | 3   // config
  | 4   // missing dependency / model
  | 5   // network / remote backend
  | 6   // permission / auth
  | 7   // not found
  | 65; // data corruption (sysexits EX_DATAERR)

export interface KindxErrorOptions {
  code: string;
  what: string;
  why?: string;
  fix?: string;
  examples?: string[];
  exitCode?: KindxExitCode;
  cause?: unknown;
}

export class KindxError extends Error {
  readonly code: string;
  readonly what: string;
  readonly why?: string;
  readonly fix?: string;
  readonly examples?: string[];
  readonly exitCode: KindxExitCode;
  readonly cause?: unknown;

  constructor(opts: KindxErrorOptions) {
    super(opts.what);
    this.name = "KindxError";
    this.code = opts.code;
    this.what = opts.what;
    this.why = opts.why;
    this.fix = opts.fix;
    this.examples = opts.examples;
    this.exitCode = opts.exitCode ?? 1;
    this.cause = opts.cause;
  }
}

/**
 * Adapt a thrown unknown into a KindxError. If `err` is already a KindxError,
 * return it. Otherwise wrap it as `internal` with the message preserved.
 *
 * Well-known SQLite error codes are mapped to friendlier categories.
 */
export function toKindxError(err: unknown): KindxError {
  if (err instanceof KindxError) return err;

  const anyErr = err as { code?: string; message?: string } | undefined;
  const message = anyErr?.message || String(err);
  const sqliteCode = anyErr?.code;

  if (sqliteCode === "SQLITE_NOTADB") {
    return new KindxError({
      code: "index.corrupted",
      what: "Index file is corrupted or not a valid database",
      why: message,
      fix: "Remove the index file and re-index your collections",
      examples: ["kindx cleanup", "kindx update"],
      exitCode: 65,
      cause: err,
    });
  }
  if (sqliteCode === "SQLITE_CANTOPEN") {
    return new KindxError({
      code: "index.cant_open",
      what: "Cannot open database file",
      why: "Check that the path exists and is writable",
      fix: "Run `kindx init` to bootstrap, or set --index to an existing index",
      examples: ["kindx init", "kindx status"],
      exitCode: 3,
      cause: err,
    });
  }
  if (sqliteCode === "SQLITE_BUSY") {
    return new KindxError({
      code: "index.busy",
      what: "Database is locked by another process",
      why: "Another kindx process is holding the database",
      fix: "Retry in a moment, or stop the other process (e.g. `kindx mcp stop`)",
      examples: ["kindx status", "kindx mcp stop"],
      exitCode: 1,
      cause: err,
    });
  }

  return new KindxError({
    code: "internal",
    what: message,
    exitCode: 1,
    cause: err,
  });
}

/**
 * Build the stable JSON envelope used by --json error output.
 */
export function errorEnvelope(err: KindxError, command?: string): {
  ok: false;
  command?: string;
  error: {
    code: string;
    what: string;
    why?: string;
    fix?: string;
    examples?: string[];
  };
} {
  return {
    ok: false,
    ...(command ? { command } : {}),
    error: {
      code: err.code,
      what: err.what,
      ...(err.why ? { why: err.why } : {}),
      ...(err.fix ? { fix: err.fix } : {}),
      ...(err.examples && err.examples.length > 0 ? { examples: err.examples } : {}),
    },
  };
}
