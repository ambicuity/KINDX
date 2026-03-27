# KINDX Agent Integration Templates

These templates assume a running KINDX HTTP server:

```bash
kindx mcp --http --port 8181
```

If you use auth, set `KINDX_MCP_TOKEN` before starting the server and include the same bearer token in your agent config.

## OpenDevin

```json
{
  "mcpServers": {
    "kindx": {
      "transport": "streamable-http",
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer ${KINDX_MCP_TOKEN}"
      }
    }
  }
}
```

## Goose

```json
{
  "tools": [
    {
      "name": "kindx",
      "type": "mcp",
      "transport": {
        "type": "http",
        "url": "http://localhost:8181/mcp",
        "headers": {
          "Authorization": "Bearer ${KINDX_MCP_TOKEN}"
        }
      }
    }
  ]
}
```

## Claude Code

```json
{
  "mcpServers": {
    "kindx": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8181/mcp"
      ],
      "env": {
        "KINDX_MCP_TOKEN": "${KINDX_MCP_TOKEN}"
      }
    }
  }
}
```

## Validation Checklist

1. Call `status` first to confirm the server is reachable.
2. Call `query` with a known lex query and verify non-empty `structuredContent.results`.
3. Use `get` with one returned `file` path and confirm resource payload returns markdown text.
