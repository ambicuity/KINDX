# Claude Desktop + KINDX Integration

Connect KINDX to Claude Desktop so Claude can search your local documents over MCP without sending the indexed corpus to a remote retrieval service.

## Prerequisites

- **Node.js 20+**
- **Claude Desktop** installed and running
- **KINDX** installed globally:

```bash
npm install -g @ambicuity/kindx
```

## Step 1: Register and index a collection

```bash
kindx collection add ~/Documents --name my-docs
kindx update -c my-docs
kindx embed
```

`kindx embed` processes every collection with pending documents, so you do not pass the collection name to that command.

## Step 2: Add KINDX to Claude Desktop

Edit the Claude Desktop config file for your platform:

| Platform | Config path |
|----------|-------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |
| WSL | `~/.config/claude/claude_desktop_config.json` |

Add this MCP server entry:

```json
{
  "mcpServers": {
    "kindx": {
      "command": "kindx",
      "args": ["mcp"]
    }
  }
}
```

If Claude Desktop cannot find `kindx`, replace `"kindx"` with the full path from `which kindx`.

## Step 3: Verify the available tools

After restarting Claude Desktop, the KINDX server should expose these tools:

- `query` for lex/vec/hyde search
- `get` for a single document by file path or docid
- `multi_get` for a batch of matching documents
- `status` for collection and index health

## Example conversation

**You:** What do my meeting notes say about the Q3 roadmap?

Claude can answer by issuing a `query` call like:

```json
{
  "searches": [
    { "type": "lex", "query": "\"Q3 roadmap\"" },
    { "type": "vec", "query": "meeting notes about the Q3 roadmap" }
  ],
  "collections": ["my-docs"],
  "limit": 5
}
```

If Claude needs the full source, it can follow up with:

```json
{
  "file": "kindx://my-docs/meetings/2026-01-15-planning.md"
}
```

## Troubleshooting

- **`kindx: command not found`**: Use the full binary path in the config file.
- **No results**: Run `kindx status`, then `kindx update -c my-docs` and `kindx embed`.
- **Slow first semantic query**: The local embedding model loads on first use; warm it up with `kindx embed`.
- **No tools in Claude Desktop**: Restart the app after saving the config file and check the JSON for syntax errors.
