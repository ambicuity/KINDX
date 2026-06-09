/**
 * cli/help.ts — render `kindx --help` and per-command help from the
 * declarative registry. The output is grouped by command domain
 * (search, collections, memory, mcp, diagnostics, backup, migration, dev)
 * with consistent spacing and a global-flags section.
 */

import { paletteFor } from "./output.js";
import { COMMANDS, commandByName, groupedCommands, type CommandSpec, type SubcommandSpec } from "./registry.js";

const GLOBAL_FLAGS_HELP: { name: string; description: string }[] = [
  { name: "--help, -h",          description: "Show usage" },
  { name: "--version, -v",       description: "Show version" },
  { name: "--index <name>",      description: "Use a named index (default: index)" },
  { name: "--workspace <name>",  description: "Alias for --index" },
  { name: "--config <path>",     description: "Override config file path" },
  { name: "--profile <name>",    description: "Use a named config profile" },
  { name: "--format <mode>",     description: "pretty|cards|table|lines|plain|json|csv|md|xml|files" },
  { name: "--plain",             description: "Plain text output (no ANSI, no decoration)" },
  { name: "--json",              description: "Legacy alias for --format json" },
  { name: "--no-color, --color", description: "Force-disable / force-enable ANSI colors" },
  { name: "--verbose, --quiet",  description: "Verbosity adjustments" },
  { name: "--debug, --trace",    description: "Extra debug output" },
  { name: "--timeout <ms>",      description: "Cap long-running operations" },
  { name: "--limit, -n <n>",     description: "Max results / items returned" },
  { name: "--collection, -c <n>",description: "Filter to one or more collections (repeatable)" },
  { name: "--yes, -y",           description: "Skip confirmation prompts" },
  { name: "--dry-run",           description: "Plan but do not modify state" },
  { name: "--interactive, -i",   description: "Open TUI variant for the command (when supported)" },
];

export interface HelpRenderOptions {
  color: boolean;
  /** Width used to align command names; default 22. */
  nameColumn?: number;
}

export function renderRootHelp(opts: HelpRenderOptions): string {
  const palette = paletteFor(opts.color);
  const nameCol = opts.nameColumn ?? 22;
  const out: string[] = [];

  out.push(palette.bold("kindx — local-first hybrid search for personal knowledge"));
  out.push("");
  out.push(palette.bold("Usage:") + "  kindx <command> [options]");
  out.push("");

  out.push(palette.bold("Quickstart:"));
  out.push("  kindx init                          # register + index + embed in one shot");
  out.push("  kindx search \"query\"                # full-text search");
  out.push("  kindx query \"how does auth work\"    # hybrid search with reranking");
  out.push("  kindx tui                            # interactive search UI");
  out.push("  kindx status --format json           # machine-readable health snapshot");
  out.push("");

  for (const group of groupedCommands()) {
    out.push(palette.bold(group.title + ":"));
    for (const cmd of group.commands) {
      out.push(`  ${palette.cyan(cmd.name.padEnd(nameCol))} ${cmd.summary}`);
    }
    out.push("");
  }

  out.push(palette.bold("Global options:"));
  for (const f of GLOBAL_FLAGS_HELP) {
    out.push(`  ${palette.dim(f.name.padEnd(28))} ${f.description}`);
  }
  out.push("");

  out.push(palette.dim("Run `kindx <command> --help` for command-specific options."));
  out.push(palette.dim("Docs: https://github.com/ambicuity/KINDX"));
  return out.join("\n");
}

export function renderCommandHelp(
  cmdName: string,
  opts: HelpRenderOptions,
): string | undefined {
  const spec = commandByName(cmdName);
  if (!spec) return undefined;
  return renderCommandHelpSpec(spec, opts);
}

function renderCommandHelpSpec(
  spec: CommandSpec,
  opts: HelpRenderOptions,
): string {
  const palette = paletteFor(opts.color);
  const out: string[] = [];
  out.push(palette.bold(`kindx ${spec.name}`) + palette.dim(`  — ${spec.summary}`));
  out.push("");
  out.push(palette.bold("Usage:"));
  out.push(`  ${spec.usage}`);

  if (spec.description) {
    out.push("");
    out.push(spec.description);
  }

  if (spec.flags && spec.flags.length > 0) {
    out.push("");
    out.push(palette.bold("Options:"));
    for (const f of spec.flags) {
      const label = f.short ? `${f.name}, ${f.short}` : f.name;
      out.push(`  ${palette.dim(label.padEnd(28))} ${f.description}`);
    }
  }

  if (spec.examples && spec.examples.length > 0) {
    out.push("");
    out.push(palette.bold("Examples:"));
    for (const ex of spec.examples) {
      out.push(`  ${palette.cyan(ex)}`);
    }
  }

  if (spec.aliases && spec.aliases.length > 0) {
    out.push("");
    out.push(palette.dim(`Aliases: ${spec.aliases.join(", ")}`));
  }

  return out.join("\n");
}

export function listCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

/**
 * Render the subcommand summary block for `kindx <cmd> --help` (or for the
 * "no subcommand" branch of a dispatcher). Returns `undefined` when the
 * command isn't in the registry or has no `subcommands` array.
 */
export function renderSubcommandList(
  cmdName: string,
  opts: HelpRenderOptions,
): string | undefined {
  const spec = commandByName(cmdName);
  if (!spec || !spec.subcommands || spec.subcommands.length === 0) return undefined;
  const palette = paletteFor(opts.color);
  // Width auto-fits the longest subcommand-name (including aliases) so the
  // summary column lines up cleanly.
  const labels = spec.subcommands.map((s) => subcommandLabel(s));
  const nameCol = Math.max(...labels.map((l) => l.length), 14) + 2;

  const out: string[] = [];
  out.push(palette.bold(`kindx ${spec.name}`) + palette.dim(`  — ${spec.summary}`));
  out.push("");
  out.push(palette.bold("Usage:"));
  out.push(`  ${spec.usage}`);
  out.push("");
  out.push(palette.bold("Subcommands:"));
  for (let i = 0; i < spec.subcommands.length; i++) {
    const sub = spec.subcommands[i]!;
    const label = labels[i]!.padEnd(nameCol);
    out.push(`  ${palette.cyan(label)} ${sub.summary}`);
  }
  out.push("");
  out.push(palette.dim(`Run \`kindx ${spec.name} <subcommand> --help\` for per-subcommand options.`));
  return out.join("\n");
}

/**
 * Render the detail block for `kindx <cmd> <sub> --help`. Returns `undefined`
 * when either the command or the subcommand isn't registered.
 */
export function renderSubcommandHelp(
  cmdName: string,
  subName: string,
  opts: HelpRenderOptions,
): string | undefined {
  const spec = commandByName(cmdName);
  if (!spec || !spec.subcommands) return undefined;
  const sub = spec.subcommands.find(
    (s) => s.name === subName || (s.aliases ?? []).includes(subName),
  );
  if (!sub) return undefined;
  const palette = paletteFor(opts.color);
  const out: string[] = [];
  out.push(palette.bold(`kindx ${spec.name} ${sub.name}`) + palette.dim(`  — ${sub.summary}`));
  out.push("");
  if (sub.usage) {
    out.push(palette.bold("Usage:"));
    out.push(`  ${sub.usage}`);
  }
  if (sub.flags && sub.flags.length > 0) {
    out.push("");
    out.push(palette.bold("Options:"));
    for (const f of sub.flags) {
      const label = f.short ? `${f.name}, ${f.short}` : f.name;
      out.push(`  ${palette.dim(label.padEnd(28))} ${f.description}`);
    }
  }
  if (sub.examples && sub.examples.length > 0) {
    out.push("");
    out.push(palette.bold("Examples:"));
    for (const ex of sub.examples) out.push(`  ${palette.cyan(ex)}`);
  }
  if (sub.aliases && sub.aliases.length > 0) {
    out.push("");
    out.push(palette.dim(`Aliases: ${sub.aliases.join(", ")}`));
  }
  return out.join("\n");
}

function subcommandLabel(sub: SubcommandSpec): string {
  if (sub.aliases && sub.aliases.length > 0) {
    return `${sub.name} (${sub.aliases.join(", ")})`;
  }
  return sub.name;
}
