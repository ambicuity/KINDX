/**
 * cli/context.ts — `CliContext` is the per-invocation environment passed to
 * commands. It bundles the resolved output mode, color palette, verbosity,
 * and the original raw flags so renderers and handlers can share one source
 * of truth instead of independently re-reading argv / env / TTY state.
 */

import {
  resolveOutputMode,
  paletteFor,
  glyphsFor,
  jsonEnvelopeEnabled,
  type ResolvedOutput,
  type OutputResolverInput,
} from "./output.js";

export type Verbosity = "quiet" | "normal" | "verbose" | "debug" | "trace";

export interface CliContextInit {
  command: string;
  args: string[];
  flags: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  stdoutIsTty?: boolean;
  stderrIsTty?: boolean;
}

export interface CliContext {
  readonly command: string;
  readonly args: string[];
  readonly flags: Record<string, unknown>;
  readonly env: NodeJS.ProcessEnv;
  readonly output: ResolvedOutput;
  readonly palette: ReturnType<typeof paletteFor>;
  readonly glyphs: ReturnType<typeof glyphsFor>;
  readonly verbosity: Verbosity;
  readonly envelopeOn: boolean;
  readonly dryRun: boolean;
  readonly assumeYes: boolean;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
}

function pickVerbosity(flags: Record<string, unknown>): Verbosity {
  if (flags.trace) return "trace";
  if (flags.debug) return "debug";
  if (flags.verbose) return "verbose";
  if (flags.quiet) return "quiet";
  return "normal";
}

export function makeCliContext(init: CliContextInit): CliContext {
  const env = init.env ?? process.env;
  const stdoutIsTty = init.stdoutIsTty ?? Boolean(process.stdout?.isTTY);
  const stderrIsTty = init.stderrIsTty ?? Boolean(process.stderr?.isTTY);

  const resolverInput: OutputResolverInput = {
    format: (init.flags.format as string | undefined),
    json: Boolean(init.flags.json),
    plain: Boolean(init.flags.plain),
    noColor: Boolean(init.flags["no-color"]),
    color: Boolean(init.flags.color),
    csv: Boolean(init.flags.csv),
    md: Boolean(init.flags.md),
    xml: Boolean(init.flags.xml),
    files: Boolean(init.flags.files),
  };

  const output = resolveOutputMode(resolverInput, env, stdoutIsTty);
  const palette = paletteFor(output.color);
  const glyphs = glyphsFor(env);
  const verbosity = pickVerbosity(init.flags);
  const envelopeOn = jsonEnvelopeEnabled(env) || init.flags.format === "json";
  const dryRun = Boolean(init.flags["dry-run"]);
  const assumeYes = Boolean(init.flags.yes) || Boolean(init.flags.confirm);

  return {
    command: init.command,
    args: init.args,
    flags: init.flags,
    env,
    output,
    palette,
    glyphs,
    verbosity,
    envelopeOn,
    dryRun,
    assumeYes,
    stdoutIsTty,
    stderrIsTty,
  };
}
