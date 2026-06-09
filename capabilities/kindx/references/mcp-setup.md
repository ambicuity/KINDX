# KINDX MCP Server Setup

## Install

```bash
npm install -g @ambicuity/kindx
kindx collection add ~/path/to/markdown --name myknowledge
kindx embed
```

## How auto-invocation works

Once kindx is configured in your MCP client and you've added at least one collection, agents will automatically call `query` before answering questions that might be informed by your local notes — no need to say "search my notes". The contract is delivered via MCP `initialize.instructions`.

To disable: run kindx with `KINDX_AUTO_INVOKE=off` in its environment.

## Configure MCP Client

**Recommended:** run `kindx init` once after install. It detects every supported MCP client on this machine and wires kindx in (and optionally appends a fenced auto-invocation block to your project's AGENTS.md/CLAUDE.md).

```bash
kindx init --client auto      # auto-detect & wire all detected clients + current project
kindx init --client all       # wire every supported client
kindx init --client cursor    # wire just one
kindx init --dry-run --client all   # preview without changes
```

Supported clients: Claude Code, Claude Desktop, Cursor, Continue, OpenCode, Codex CLI, Copilot CLI, Zed. Ollama support is via a separate bridge — see `references/ollama-bridge.md`.

If you prefer to wire manually, the per-client config snippets below still work.

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "kindx": { "command": "kindx", "args": ["mcp"] }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "kindx": { "command": "kindx", "args": ["mcp"] }
  }
}
```

**OpenClaw** (`~/.openclaw/openclaw.json`):
```json
{
  "mcp": {
    "servers": {
      "kindx": { "command": "kindx", "args": ["mcp"] }
    }
  }
}
```

## HTTP Mode

```bash
kindx mcp --http              # Port 8181
kindx mcp --http --daemon     # Background
kindx mcp stop                # Stop daemon
```

## Tools

### structured_search

Search with pre-expanded queries.

```json
{
  "searches": [
    { "type": "lex", "query": "keyword phrases" },
    { "type": "vec", "query": "natural language question" },
    { "type": "hyde", "query": "hypothetical answer passage..." }
  ],
  "limit": 10,
  "collection": "optional",
  "minScore": 0.0
}
```

| Type | Method | Input |
|------|--------|-------|
| `lex` | BM25 | Keywords (2-5 terms) |
| `vec` | Vector | Question |
| `hyde` | Vector | Answer passage (50-100 words) |

### get

Retrieve document by path or `#docid`.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path or `#docid` |
| `full` | bool? | Return full content |
| `lineNumbers` | bool? | Add line numbers |

### multi_get

Retrieve multiple documents.

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string | Glob or comma-separated list |
| `maxBytes` | number? | Skip large files (default 10KB) |

### status

Index health and collections. No params.

## Troubleshooting

- **Not starting**: `which kindx`, `kindx mcp` manually
- **No results**: `kindx collection list`, `kindx embed`
- **Slow first search**: Normal, models loading (~3GB)
