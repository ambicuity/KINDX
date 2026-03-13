# Screenshot 09: Claude Desktop Integration

## Description

Shows Claude Desktop using KINDX through MCP to answer a question with grounded citations from a local collection.

## Command

Configuration file at `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Expected Screen Content

### Claude Desktop Window

**User message:**

```text
What does our documentation say about error handling in the API?
```

**Claude response:**

```text
Based on your documentation, here is the pattern I found for API error handling:

- Every error response includes a machine-readable error code and a human-readable message.
- Validation failures may include field-level details.
- 4xx responses should include actionable guidance for the caller.
- 5xx responses should log full stack traces server-side but return a generic client message.

Sources:
  kindx://my-docs/api-reference.md
  kindx://my-docs/style-guide.md
  kindx://my-docs/error-handling.md
```

**Tool use indicator (shown in Claude Desktop UI):**

```text
Used tool: query
  searches: [{ "type": "lex", "query": "error handling API" }, { "type": "vec", "query": "how does the API report errors" }]
  collections: ["my-docs"]
  limit: 5
```

## Annotations

- **MCP tool use indicator:** Claude Desktop shows when it called KINDX's `query` tool automatically.
- **Grounded answer:** Claude synthesizes an answer from retrieved files instead of dumping raw search output.
- **Source attribution:** `kindx://` paths let the user inspect the supporting documents directly.
- **Minimal config:** The integration is a single `kindx` MCP server entry using `args: ["mcp"]`.
