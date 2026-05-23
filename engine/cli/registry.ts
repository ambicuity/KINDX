/**
 * cli/registry.ts — declarative metadata for every top-level KINDX command.
 *
 * The registry is the single source of truth for grouped `--help` output,
 * shell completion (future), and the TUI's command palette. It is *not* the
 * dispatcher — engine/kindx.ts still owns the switch/case routing — but it
 * supplies enough metadata to render rich help and identify deprecated or
 * developer-only commands.
 */

export type CommandDomain =
  | "search"        // Search and retrieval
  | "collections"   // Collections and indexing
  | "memory"        // Memory store
  | "mcp"           // MCP / server
  | "diagnostics"   // Diagnostics and maintenance
  | "backup"        // Backup / restore
  | "migration"    // Migration
  | "dev";          // Developer / debug tooling

export interface CommandFlag {
  name: string;
  short?: string;
  description: string;
}

export interface CommandSpec {
  name: string;
  /** Optional aliases that still dispatch to this command. */
  aliases?: string[];
  domain: CommandDomain;
  summary: string;
  /** Usage signature shown above the description, e.g. "kindx query <query>". */
  usage: string;
  description?: string;
  examples?: string[];
  /** Command-specific flags worth documenting in --help. */
  flags?: CommandFlag[];
  hidden?: boolean;
}

const DOMAIN_TITLES: Record<CommandDomain, string> = {
  search: "Search and retrieval",
  collections: "Collections and indexing",
  memory: "Memory",
  mcp: "MCP / server",
  diagnostics: "Diagnostics and maintenance",
  backup: "Backup and restore",
  migration: "Migration",
  dev: "Developer / debug tooling",
};

const DOMAIN_ORDER: CommandDomain[] = [
  "search",
  "collections",
  "memory",
  "mcp",
  "diagnostics",
  "backup",
  "migration",
  "dev",
];

export const COMMANDS: CommandSpec[] = [
  // ── Search & retrieval ─────────────────────────────────────────────────
  {
    name: "query",
    domain: "search",
    summary: "Hybrid search with auto-expansion + LLM reranking (recommended)",
    usage: "kindx query <text> | <typed-document>",
    examples: [
      "kindx query \"how does auth work\"",
      "kindx query $'lex: CAP theorem\\nvec: consistency'",
      "kindx query \"auth\" --format cards",
      "kindx query \"auth\" --interactive",
    ],
    flags: [
      { name: "--explain", description: "Include retrieval score traces" },
      { name: "--format", description: "pretty|cards|table|lines|plain|json|csv|md|xml|files" },
      { name: "--collection", short: "-c", description: "Filter to one or more collections" },
      { name: "--limit", short: "-n", description: "Max results (default 5)" },
      { name: "--interactive", short: "-i", description: "Open TUI search instead of one-shot" },
    ],
  },
  {
    name: "search",
    domain: "search",
    summary: "Full-text BM25 search (no LLM)",
    usage: "kindx search <text>",
    examples: ["kindx search \"http hardening\""],
  },
  {
    name: "vsearch",
    aliases: ["vector-search"],
    domain: "search",
    summary: "Vector similarity search only",
    usage: "kindx vsearch <text>",
  },
  {
    name: "get",
    domain: "search",
    summary: "Show a single indexed document",
    usage: "kindx get <file>[:line] [--from <line>] [-l <n>] [--line-numbers]",
  },
  {
    name: "multi-get",
    domain: "search",
    summary: "Batch fetch via glob or comma-separated list",
    usage: "kindx multi-get <pattern> [-l <n>] [--max-bytes <n>]",
  },
  {
    name: "history",
    domain: "search",
    summary: "Show document version history",
    usage: "kindx history <file>",
  },
  {
    name: "diff",
    domain: "search",
    summary: "Diff two versions of a document",
    usage: "kindx diff <file> [--from <v>] [--to <v>]",
  },
  {
    name: "ls",
    domain: "search",
    summary: "List indexed files",
    usage: "kindx ls [collection[/path]]",
  },

  // ── Collections & indexing ─────────────────────────────────────────────
  {
    name: "init",
    domain: "collections",
    summary: "Guided one-shot setup (collection → index → embed)",
    usage: "kindx init [path] [--name <name>] [--mask <glob>]",
    examples: ["kindx init", "kindx init ~/notes --name notes"],
  },
  {
    name: "collection",
    domain: "collections",
    summary: "Manage collections (add | list | remove | rename | show | update-cmd | include | exclude)",
    usage: "kindx collection <subcommand> [...]",
  },
  {
    name: "context",
    domain: "collections",
    summary: "Attach human-written context summaries to paths",
    usage: "kindx context <add|list|rm> [...]",
  },
  {
    name: "update",
    domain: "collections",
    summary: "Re-index collections (optionally `git pull` first)",
    usage: "kindx update [--pull]",
  },
  {
    name: "embed",
    domain: "collections",
    summary: "Generate/refresh vector embeddings",
    usage: "kindx embed [-f] [--resume]",
  },
  {
    name: "watch",
    domain: "collections",
    summary: "Real-time incremental indexing daemon",
    usage: "kindx watch [collection ...]",
  },
  {
    name: "pull",
    domain: "collections",
    summary: "Download/check the default local GGUF models",
    usage: "kindx pull [--refresh]",
  },

  // ── Memory ─────────────────────────────────────────────────────────────
  {
    name: "memory",
    domain: "memory",
    summary: "Scoped agent memory (put | search | history | stats | mark-accessed | embed | consolidate)",
    usage: "kindx memory <subcommand> [...]",
    examples: [
      "kindx memory put --scope my --key url --value https://...",
      "kindx memory search --scope my \"deploy\"",
    ],
  },

  // ── MCP / server ───────────────────────────────────────────────────────
  {
    name: "mcp",
    domain: "mcp",
    summary: "MCP server (stdio default, --http for HTTP/SSE)",
    usage: "kindx mcp [--http] [--daemon] [--port <n>] | kindx mcp stop | kindx mcp status",
    examples: [
      "kindx mcp",
      "kindx mcp --http --daemon --port 8181",
      "kindx mcp status --format json",
      "kindx mcp stop",
    ],
  },

  // ── Diagnostics & maintenance ──────────────────────────────────────────
  {
    name: "status",
    domain: "diagnostics",
    summary: "Index health + collection inventory",
    usage: "kindx status [--format json|pretty]",
  },
  {
    name: "doctor",
    domain: "diagnostics",
    summary: "Run deterministic health checks (ok/warn/error/skip)",
    usage: "kindx doctor [--format json]",
  },
  {
    name: "repair",
    domain: "diagnostics",
    summary: "Integrity check (`--check-only` is dry-run)",
    usage: "kindx repair --check-only",
  },
  {
    name: "scheduler",
    domain: "diagnostics",
    summary: "Shard sync checkpoint and queue status",
    usage: "kindx scheduler status [--format json]",
  },
  {
    name: "cleanup",
    domain: "diagnostics",
    summary: "Clear caches, vacuum DB",
    usage: "kindx cleanup [--cache]",
  },
  {
    name: "verify-wipe",
    domain: "diagnostics",
    summary: "Scan for residual local index artifacts",
    usage: "kindx verify-wipe [--format json]",
  },

  // ── Backup / restore ───────────────────────────────────────────────────
  {
    name: "backup",
    domain: "backup",
    summary: "Manage SQLite backups (create | verify | restore)",
    usage: "kindx backup <subcommand> [path]",
  },

  // ── Migration ──────────────────────────────────────────────────────────
  {
    name: "migrate",
    domain: "migration",
    summary: "Migrate from another store (chroma | openclaw)",
    usage: "kindx migrate <chroma|openclaw> <path>",
  },

  // ── Dev / tooling ──────────────────────────────────────────────────────
  {
    name: "tui",
    domain: "dev",
    summary: "Interactive terminal UI (requires a real TTY)",
    usage: "kindx tui",
  },
  {
    name: "skill",
    domain: "dev",
    summary: "Show or install the packaged KINDX Claude Code skill",
    usage: "kindx skill install",
  },
];

export function commandByName(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || (c.aliases ?? []).includes(name));
}

export function groupedCommands(): { domain: CommandDomain; title: string; commands: CommandSpec[] }[] {
  const groups: { domain: CommandDomain; title: string; commands: CommandSpec[] }[] = [];
  for (const domain of DOMAIN_ORDER) {
    const commands = COMMANDS.filter((c) => c.domain === domain && !c.hidden);
    if (commands.length > 0) {
      groups.push({ domain, title: DOMAIN_TITLES[domain], commands });
    }
  }
  return groups;
}
