# Cursor IDE + KINDX Integration

Use KINDX as an MCP server inside Cursor so the assistant can search your codebase, docs, and notes locally.

## Prerequisites

- **Cursor** with MCP support
- **Node.js 20+**
- **KINDX** installed globally:

```bash
npm install -g @ambicuity/kindx
```

## Step 1: Register the folders you want to search

```bash
kindx collection add . --name my-project
kindx update -c my-project
kindx embed
```

For a larger workspace, add multiple collections:

```bash
kindx collection add ~/code/my-monorepo/packages/backend --name backend
kindx collection add ~/code/my-monorepo/docs --name docs
kindx update
kindx embed
```

## Step 2: Configure Cursor

Create `<project-root>/.cursor/mcp.json`:

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

If Cursor does not inherit the right `PATH`, replace `"kindx"` with the full path from `which kindx`.

## Step 3: What Cursor gets

Once connected, Cursor can call:

- `query` to search using lexical and semantic sub-queries
- `get` to read one file
- `multi_get` to read several files at once
- `status` to inspect collection health

## Example workflow

If you ask Cursor:

> Search the codebase for JWT validation middleware and the docs that explain it.

KINDX can be queried with:

```json
{
  "searches": [
    { "type": "lex", "query": "JWT validation middleware" },
    { "type": "vec", "query": "how do we validate auth tokens across services" }
  ],
  "collections": ["my-project"],
  "limit": 5
}
```

If a result looks promising, Cursor can follow up with `get` using the returned `file` or `docid`.

## Tips

- Keep collections focused instead of indexing your whole home directory.
- Re-run `kindx update` after file changes and `kindx embed` after new semantic content is added.
- Use natural language queries when you want concept search, and quoted lexical queries when you know the exact term.
