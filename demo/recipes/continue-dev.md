# Continue.dev + KINDX Integration

Use KINDX as an MCP-backed context source inside Continue so you can search internal docs and code without leaving the editor.

## Prerequisites

- **Continue.dev** installed in VS Code or JetBrains
- **Node.js 20+**
- **KINDX** installed globally:

```bash
npm install -g @ambicuity/kindx
```

## Step 1: Index the content you want Continue to search

```bash
kindx collection add ~/work/docs --name internal-docs
kindx collection add ~/code/my-project --name project
kindx update
kindx embed
```

## Step 2: Add KINDX as an MCP server

Add KINDX to your Continue config:

```json
{
  "mcpServers": [
    {
      "name": "kindx",
      "command": "kindx",
      "args": ["mcp"]
    }
  ]
}
```

If your Continue version uses the `context_providers` format instead, point the MCP provider at the same command and args.

## Step 3: Tooling exposed to Continue

Continue can use:

- `query` for lex/vec/hyde search
- `get` for a single matching document
- `multi_get` for a batch of related files
- `status` for health and collection metadata

## Example workflow

If you ask:

> What is our standard pattern for error handling in API endpoints?

Continue can issue a search like:

```json
{
  "searches": [
    { "type": "lex", "query": "\"error handling\" API" },
    { "type": "vec", "query": "standard pattern for handling API endpoint errors" }
  ],
  "collections": ["internal-docs", "project"],
  "limit": 5
}
```

## Tips

- Run `kindx update` after big documentation or code changes.
- Run `kindx embed` after adding new content you want semantic search to understand.
- Use `kindx status` if Continue is connected but returns no relevant results.
