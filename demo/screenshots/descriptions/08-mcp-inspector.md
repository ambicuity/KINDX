# Screenshot 08: MCP Inspector

## Description

Shows the MCP Inspector connected to KINDX over stdio and displaying the current tool surface.

## Command

```bash
$ kindx mcp
```

Then, in a separate terminal:

```bash
$ npx @modelcontextprotocol/inspector kindx mcp
```

## Expected Terminal Output

**KINDX server (terminal 1):**

```text
$ kindx mcp
KINDX MCP server ready on stdio
  Tools: query, get, multi_get, status
```

**MCP Inspector (terminal 2 / browser UI):**

### Tools Panel

```text
Available Tools (4):

query
  Description: Search the knowledge base with one or more lex/vec/hyde sub-queries
  Parameters:
    searches (array, required)
    limit (number, optional)
    collections (array, optional)

get
  Description: Retrieve a single document by file path or docid

multi_get
  Description: Retrieve multiple documents by glob or comma-separated paths

status
  Description: Show collection and index health information
```

### Test Invocation Panel

```text
Tool: query
Input:
{
  "searches": [
    { "type": "lex", "query": "authentication" },
    { "type": "vec", "query": "how does auth work" }
  ],
  "collections": ["my-docs"],
  "limit": 3
}

Response:
{
  "structuredContent": {
    "results": [
      {
        "docid": "#762e73",
        "file": "kindx://my-docs/security.md",
        "title": "Authentication Guide",
        "score": 0.82,
        "snippet": "Authentication is handled via JWT tokens issued by the /auth/login endpoint..."
      }
    ]
  }
}
```

## Annotations

- **Current tool surface:** KINDX exposes `query`, `get`, `multi_get`, and `status`.
- **Typed search input:** `query` accepts `lex`, `vec`, and `hyde` sub-queries plus optional collection filters.
- **Structured output:** Search responses include machine-readable result objects rather than only formatted text.
- **stdio transport:** The Inspector connects by wrapping `kindx mcp`, not an old `serve` subcommand.
