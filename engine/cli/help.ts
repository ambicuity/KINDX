/**
 * cli/help.ts — render `kindx --help` and per-command help from the
 * declarative registry. The output is grouped by command domain
 * (search, collections, memory, mcp, diagnostics, backup, migration, dev)
 * with consistent spacing and a global-flags section.
 */

import { paletteFor } from "./output.js";
import { COMMANDS, commandByName, groupedCommands, type CommandSpec } from "./registry.js";

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
