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

export interface SubcommandSpec {
  /** Canonical subcommand name (e.g. "add", "list", "rm"). */
  name: string;
  /** Aliases that also dispatch to this subcommand (e.g. "ls" → "list"). */
  aliases?: string[];
  /** One-line description shown in the subcommand summary table. */
  summary: string;
  /** Argument signature, e.g. "<name> --path <dir> --pattern <glob>". */
  usage?: string;
  /** Subcommand-specific flags worth documenting in `<cmd> <sub> --help`. */
  flags?: CommandFlag[];
  examples?: string[];
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
  /**
   * Subcommands this command dispatches to. When present, `kindx <cmd> --help`
   * and `kindx <cmd>` (no subcommand) render the subcommand summary table;
   * `kindx <cmd> <sub> --help` renders the per-subcommand detail block.
   */
  subcommands?: SubcommandSpec[];
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
    subcommands: [
      {
        name: "list",
        summary: "List configured collections",
        usage: "kindx collection list",
      },
      {
        name: "add",
        summary: "Register a new collection (defaults to current directory)",
        usage: "kindx collection add [path] [--name <name>] [--mask <glob>]",
        examples: [
          "kindx collection add ~/notes --name notes",
          "kindx collection add . --mask '**/*.md'",
        ],
      },
      {
        name: "remove",
        aliases: ["rm"],
        summary: "Remove a collection from the index",
        usage: "kindx collection remove <name>",
      },
      {
        name: "rename",
        aliases: ["mv"],
        summary: "Rename a collection",
        usage: "kindx collection rename <old-name> <new-name>",
      },
      {
        name: "update-cmd",
        aliases: ["set-update"],
        summary: "Set the command to run before indexing (e.g. `git pull`)",
        usage: "kindx collection update-cmd <name> [command]",
      },
    ],
  },
  {
    name: "context",
    domain: "collections",
    summary: "Attach human-written context summaries to paths",
    usage: "kindx context <add|list|rm> [...]",
    subcommands: [
      {
        name: "add",
        summary: "Attach context text to a path (defaults to current directory)",
        usage: "kindx context add [path] \"text\"",
        examples: [
          "kindx context add \"Context for current directory\"",
          "kindx context add / \"Global context for all collections\"",
          "kindx context add kindx://journals/2024 \"Context for 2024 journals\"",
        ],
      },
      {
        name: "list",
        summary: "List all attached contexts",
        usage: "kindx context list",
      },
      {
        name: "rm",
        summary: "Remove the context attached to a path",
        usage: "kindx context rm <path>",
      },
    ],
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
    subcommands: [
      {
        name: "put",
        summary: "Store a scoped key/value entry (overwrites by default)",
        usage: "kindx memory put --scope <s> --key <k> --value <v> [--tags <a,b>]",
      },
      {
        name: "search",
        summary: "Search memory entries within a scope (FTS + recency)",
        usage: "kindx memory search --scope <s> <query> [--limit <n>]",
      },
      {
        name: "history",
        summary: "Show all versions of a key in a scope",
        usage: "kindx memory history --scope <s> --key <k>",
      },
      {
        name: "stats",
        summary: "Summarize entries-per-scope and last-access times",
        usage: "kindx memory stats [--format json]",
      },
      {
        name: "embed",
        summary: "Generate embeddings for memory entries lacking them",
        usage: "kindx memory embed [--scope <s>]",
      },
      {
        name: "consolidate",
        summary: "Merge duplicate / similar entries within a scope",
        usage: "kindx memory consolidate --scope <s> [--dry-run]",
      },
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
    subcommands: [
      {
        name: "(default)",
        summary: "Start the MCP server (stdio by default; --http for HTTP/SSE)",
        usage: "kindx mcp [--http] [--daemon] [--port <n>]",
      },
      {
        name: "status",
        summary: "Show running daemon status, port, and PID",
        usage: "kindx mcp status [--format json]",
      },
      {
        name: "stop",
        summary: "Stop a running --daemon MCP server",
        usage: "kindx mcp stop",
      },
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
    subcommands: [
      {
        name: "create",
        summary: "Snapshot the index DB to a file (defaults to standard location)",
        usage: "kindx backup create [path]",
      },
      {
        name: "verify",
        summary: "Check a backup file for integrity and encryption status",
        usage: "kindx backup verify <backup-file>",
      },
      {
        name: "restore",
        summary: "Restore a backup over the current index DB",
        usage: "kindx backup restore <backup-file> [--force]",
      },
    ],
  },

  // ── Migration ──────────────────────────────────────────────────────────
  {
    name: "migrate",
    domain: "migration",
    summary: "Migrate from another store (chroma | openclaw)",
    usage: "kindx migrate <chroma|openclaw> <path>",
  },

  // ── Named indexes & multi-tenancy ──────────────────────────────────────
  {
    name: "index",
    domain: "diagnostics",
    summary: "Manage named indexes (list | create | delete | migrate)",
    usage: "kindx index <subcommand> [...]",
    subcommands: [
      {
        name: "list",
        aliases: ["ls"],
        summary: "List all named indexes",
        usage: "kindx index list",
      },
      {
        name: "create",
        summary: "Create a new named index",
        usage: "kindx index create <name> [--description <desc>]",
      },
      {
        name: "delete",
        aliases: ["rm"],
        summary: "Permanently delete a named index (requires --force)",
        usage: "kindx index delete <name> --force",
      },
      {
        name: "migrate",
        summary: "Copy a collection's data between two named indexes",
        usage: "kindx index migrate <collection> --from <src> --to <dst>",
      },
    ],
  },
  {
    name: "tenant",
    domain: "diagnostics",
    summary: "RBAC: tenants, tokens, and per-collection grants",
    usage: "kindx tenant <subcommand> [...]",
    subcommands: [
      {
        name: "add",
        summary: "Create a tenant (shows the bearer token once)",
        usage: "kindx tenant add <id> [collections...] --role <admin|editor|viewer> [--name <name>]",
      },
      {
        name: "remove",
        aliases: ["rm"],
        summary: "Remove a tenant",
        usage: "kindx tenant remove <id>",
      },
      {
        name: "list",
        aliases: ["ls"],
        summary: "List all tenants",
        usage: "kindx tenant list",
      },
      {
        name: "show",
        summary: "Show a tenant's details (without revealing the token)",
        usage: "kindx tenant show <id>",
      },
      {
        name: "rotate",
        summary: "Rotate a tenant's bearer token (shows the new one once)",
        usage: "kindx tenant rotate <id>",
      },
      {
        name: "grant",
        summary: "Grant access to one or more collections",
        usage: "kindx tenant grant <id> <col1> [col2 ...]",
      },
      {
        name: "revoke",
        summary: "Revoke access to one or more collections",
        usage: "kindx tenant revoke <id> <col1> [col2 ...]",
      },
      {
        name: "disable",
        summary: "Disable a tenant (rejects future auth attempts)",
        usage: "kindx tenant disable <id>",
      },
      {
        name: "enable",
        summary: "Re-enable a previously disabled tenant",
        usage: "kindx tenant enable <id>",
      },
      {
        name: "status",
        summary: "Show RBAC enablement and role summary",
        usage: "kindx tenant status [--format json]",
      },
    ],
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

/**
 * Suggest up to `limit` command names that are close to `input` (Levenshtein
 * distance ≤ `maxDistance`). Used by the dispatcher's `Unknown command`
 * branch to print a "Did you mean: …?" hint.
 *
 * Returns an empty array when `input` is empty, when it exactly matches a
 * registered command (the dispatcher would have routed it), or when no
 * command is within distance.
 */
import { levenshtein } from "../repository/docid.js";
export function suggestCommandNames(input: string, maxDistance: number = 2, limit: number = 3): string[] {
  if (!input) return [];
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return [];
  // Build the candidate set: every primary name + every alias, deduplicated.
  // Hidden commands are NOT excluded — `tui` is hidden in the help registry
  // but is still a valid command that users may misspell.
  const candidates = new Set<string>();
  for (const c of COMMANDS) {
    candidates.add(c.name);
    for (const a of c.aliases ?? []) candidates.add(a);
  }
  // Exact match means dispatch would have routed it — no suggestion needed.
  if (candidates.has(cleaned)) return [];
  const scored: { name: string; d: number }[] = [];
  for (const name of candidates) {
    const d = levenshtein(cleaned, name, maxDistance);
    if (d > 0 && d <= maxDistance) scored.push({ name, d });
  }
  scored.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
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
