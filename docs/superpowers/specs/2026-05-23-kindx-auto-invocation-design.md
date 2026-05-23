# KINDX Auto-Invocation Design

**Status:** Draft
**Author:** Brainstorming session, 2026-05-23
**Scope:** Make MCP-aware agents call kindx tools (`query`, `get`, `multi_get`, `memory_*`) automatically — without the user typing "/kindx" or asking for a search — across the full ecosystem (Claude Code, Claude Desktop, Cursor, Continue, OpenCode, Codex, Copilot, Zed, Ollama bridge, and any future MCP host).

## Problem

Today, agents only invoke kindx when they decide to. Two facts make that decision unreliable:

1. **`buildInstructions()` (engine/protocol.ts:594) describes *what* kindx is**, not *when to use it*. The text reads as a reference card, not a directive. Agents treat kindx as "available if asked".
2. **Tool descriptions lead with syntax**, not trigger conditions. `query`'s description (engine/protocol.ts:907) starts with sub-query mechanics; nothing tells the agent "call this before answering a user question".

Result: users repeatedly have to say "search my notes for X" instead of just asking "what did I write about X". This negates the value of having a local knowledge index wired in.

## Goal

When the user asks any non-trivial question in a session where a kindx MCP server is connected and has at least one collection, the agent issues a `query` call **before** synthesising an answer — automatically, without explicit invocation.

Secondary: agents auto-call `memory_search` at the start of turns that reference prior state ("we", "earlier", "you remember"), and persist with `memory_put` after the user states a preference, decision, or fact.

## Non-goals

- No protocol-level notifications or per-turn server pushes (brittle, client-coverage poor).
- No Claude Code-specific UserPromptSubmit hook in v1 — deferred to v2 if measurements show v1 under-fires.
- No automatic `kindx embed` invocation as part of `kindx init`; user still runs it explicitly.
- No edits to mcp-setup.md examples until `kindx init` ships and is proven.

## Approach

Three coordinated layers, all required:

1. **Sharper MCP `initialize` instructions** — universal, every client honors it.
2. **Reframed tool descriptions** — universal, biases agents toward auto-invoke.
3. **`kindx init` installer** — operational backstop that wires MCP configs across clients AND drops a fenced auto-invocation block into project AGENTS.md/CLAUDE.md/.cursorrules so hosts that bury MCP instructions still see the contract.

Approaches considered and rejected: protocol-level notifications (Approach C — overengineered, requires client cooperation that doesn't exist outside Claude Code/Desktop today).

## Design

### 1. Instructions template (engine/protocol.ts:594, `buildInstructions`)

Layered, top-down, in order:

1. **Identity** — one line: `KINDX is your local search index over <N> markdown docs across collections: <comma-sep>.`
2. **AUTO-INVOCATION CONTRACT** *(new, load-bearing)*:
   > Before answering any user turn that is not a greeting, a pure code-generation request with no reference to user files, or a trivial yes/no, call `query` first. Auto-invoke is default-on. Skip if: (a) user says "don't search", (b) you already have results from a query this turn, (c) request is exclusively about writing new code with no need to consult prior notes. Set `KINDX_AUTO_INVOKE=off` on the server to disable this contract.
3. **Decision table** (6 rows):
   | User turn shape | First call |
   |---|---|
   | "what did I write about X" / "find …" / "show me …" | `query` (lex+vec) |
   | "open `<path>`" / mentions a specific file | `get` |
   | Question that could be answered by existing notes | `query` (vec+hyde) |
   | New code, no file reference | skip kindx |
   | Greeting / chitchat | skip kindx |
   | Memory-related ("remember that", "what did we decide") | `memory_search` then `memory_put` |
4. **Cost discipline** — "Default `query` returns top 3 snippets (~600 tokens). Pull bodies with `get` only when a snippet looks relevant."
5. **Collections list** — kept as-is from current implementation (protocol.ts:621).
6. **Vector readiness note** — kept as-is (protocol.ts:633).
7. **Workspace memory prefetch** — kept as-is (protocol.ts:641).
8. **Layered project instructions** (AGENTS.md/SOUL.md/CLAUDE.md) — kept, rendered *after* the contract so they augment rather than dilute.
9. **Search & retrieval reference** — condensed; long examples move into tool descriptions.

**Conditional emission:** If `status.collections.length === 0`, replace the contract with one line ("kindx is installed but has no collections — run `kindx collection add <path>` to enable auto-search"). Prevents wasted `query` calls on an empty index.

**Hard size ceiling:** 8 KB post-render, truncated with `[instructions truncated — see kindx://capabilities]` marker if exceeded.

### 2. Tool description rewrites (engine/protocol.ts:903–2248)

Each `description:` field gets the structure:
```
<one-line WHEN-TO-USE imperative>

## When to use
- <bullets matching trigger shapes>
- <skip conditions>

## How to call
<existing description body, condensed where redundant with instructions>
```

Concrete one-liners:

| Tool | New leading sentence |
|------|----------------------|
| `query` | *Call this first* whenever the user asks a question, references their notes/docs/codebase, or you need context grounded in the user's local knowledge. Default: top 3 snippets. |
| `get` | Call after `query` to read the full body of a result that looked promising. Also call when the user mentions a specific file path. |
| `multi_get` | Call when you need multiple related docs at once (glob or comma-separated list from prior `query` results). |
| `status` | Call once per session if `instructions` did not list collections. Rarely needed mid-turn. |
| `memory_search` | Call at the start of any turn that says "we", "earlier", "you remember", "the project", or that resumes ongoing work. |
| `memory_put` | Call after the user states a preference, decision, or fact you'll need next session. Do not echo memory back; just persist. |
| `memory_history`, `memory_stats`, `memory_mark_accessed`, `memory_delete`, `memory_bulk`, `memory_feedback` | Diagnostic — only call when the user asks about memory itself. |

**Default budget change** (tight triage): `query.limit` default drops from 10 to **3**. `maxSnippetLines` default of 4. Agents that want more set explicitly. Documented in the new description that `get` is how to expand.

### 3. `kindx init` subcommand

CLI surface:
```
kindx init [--client <name|all|auto>] [--project <path>] [--global] [--dry-run] [--force]
```

- `--client auto` (default): probe known config locations, prompt-confirm wiring each detected.
- `--client claude-code|claude-desktop|cursor|continue|opencode|codex|copilot|zed|ollama-bridge|all`: explicit target(s), comma-separated.
- `--global`: only wire client configs, don't touch project files.
- `--project <path>` (default `.`): which project to drop AGENTS.md/CLAUDE.md/.cursorrules block into.
- `--dry-run`: print diff, change nothing.
- `--force`: overwrite an existing kindx block or MCP entry without prompting.

**Client adapter map** (single file each in engine/init/adapters/):

| Client | Config path | Wire format |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `mcpServers.kindx` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.kindx` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` | `mcpServers.kindx` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers.kindx` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.kindx` |
| Continue | `~/.continue/config.json` | `mcpServers.kindx` |
| OpenCode | `~/.opencode/config.json` | `mcp.servers.kindx` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.kindx]` |
| Copilot CLI | `~/.copilot/mcp.json` | `mcpServers.kindx` |
| Zed | `~/.config/zed/settings.json` | `context_servers.kindx` |
| Ollama (local + cloud) | n/a directly | docs for an `ollama-bridge` shim (no auto-wire in v1) |

Each adapter implements `detect()`, `read()`, `write()`, `format()`. JSONC-aware parsing for Cursor/Zed so comments survive. Atomic writes (temp file + rename); one timestamped backup per touch at `<path>.kindx.bak.<timestamp>`.

**Fenced project-file block** (idempotent marker):
```
<!-- kindx:auto-invocation:start v=1 -->
... (rendered "WHEN TO CALL KINDX" contract, mirror of §1.2) ...
<!-- kindx:auto-invocation:end -->
```

Target files (in order of preference): AGENTS.md, CLAUDE.md, .cursorrules, GEMINI.md. Detection by marker; replace in place if present, append if absent. Files are created only with `--force` or interactive confirmation.

**Idempotency:** detects existing MCP-server entries by `kindx` key and project fences by marker. Diffs and prompts on conflict; never silently overwrites unless `--force`.

### 4. Failure modes

| Condition | Behavior |
|---|---|
| No collections registered | Contract block replaced with one-line "no collections — run `kindx collection add`". Prevents wasted `query` calls. |
| Vector index not built | Existing note at protocol.ts:633 kept; contract still emitted but adds "lex-only mode — do not call `vec`/`hyde`". |
| MCP client unreachable | Out of scope for server; `kindx mcp --health-check` flag added (exits 0/1) so client probes work. |
| Auto-invoke disabled (`KINDX_AUTO_INVOKE=off`) | Contract block omitted entirely; rest of instructions unchanged. Documented in contract body. |
| `kindx init` writes to wrong file | Atomic write + timestamped backup; `--dry-run` preview; explicit `--force` to overwrite. |
| Token blowout from instructions | 8 KB hard cap with truncation marker. `query.limit` default of 3 keeps tool responses small. |

### 5. Testing

- **Unit (engine/protocol.test.ts):** snapshot `buildInstructionsForTest` across five states — empty index, collections only, vectors ready, auto-invoke off, layered AGENTS.md present.
- **Unit (engine/init/*.test.ts):** per-adapter parse → write → re-parse round-trip; fence idempotency (append once, re-run is no-op, `--force` overwrites).
- **Integration smoke:** in-process stdio server; send MCP `initialize`; assert contract appears in `instructions` response and `query` description leads with "Call this first".
- **Manual matrix (docs/auto-invocation-validation.md):** scripted prompts ("what did I write about <topic>") across Claude Code, Cursor, Continue, Codex, OpenCode — record whether agent auto-fires `query`. Refreshed per release.

### 6. Telemetry (opt-in, local-only)

- `session.queryLog` records a `trigger` field per tool call: `user-explicit` | `agent-auto` | `unknown`, inferred from whether the user's verbatim turn requested a search.
- New CLI: `kindx status --auto-invoke-rate` summarizes the local session log so users can see whether the contract is firing in their setup.
- `kindx://capabilities` resource gains `autoInvocation: { contractEmitted: bool, lastTurnTrigger?: string }`.

No external transmission. No analytics endpoint.

## Open questions

None at design time. v2 considerations (deferred):

- Whether to ship a Claude Code UserPromptSubmit hook in addition to the contract. Decide after measuring v1 auto-invoke rates.
- Whether `kindx init` should offer to run `kindx embed` after registering a collection. Currently it only prompts.
- Ollama bridge: out of scope for v1 (Ollama has no native MCP); ship docs only.

## Files changed (estimated)

- `engine/protocol.ts` — rewrite `buildInstructions()` (~+80 net lines), reword tool descriptions (~10 tool blocks, ~+150 net lines), change `query.limit` default 10→3 and add `maxSnippetLines` default 4. Honor `KINDX_AUTO_INVOKE=off` env var by omitting the contract block.
- `engine/kindx.ts` — new `case "init"` in CLI dispatcher near line 4640; new `--health-check` flag on `kindx mcp` that probes the store and exits 0/1.
- `engine/init/` *(new)* — `index.ts`, `clients.ts`, `fence.ts`, `adapters/*.ts` (~9 adapter files), ~20 unit tests.
- `engine/protocol.test.ts` — 5 new snapshot tests.
- `docs/auto-invocation-validation.md` *(new)* — manual matrix template.
- `capabilities/kindx/references/mcp-setup.md` — point users to `kindx init` as the primary path; keep manual config as fallback.
- `capabilities/kindx/SKILL.md` — note that auto-invocation is default-on as of this version.

## Rollout

1. Land instructions + tool-description rewrite first (single PR). Ship behind no flag — `KINDX_AUTO_INVOKE=off` is the opt-out.
2. Ship `kindx init` second (separate PR) — adapters one by one, starting with Claude Code, Cursor, Codex (the three most common).
3. Publish auto-invocation-validation.md results on the third release after landing both.
