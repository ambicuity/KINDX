# Screenshot 09: Claude Desktop Integration

## Description

Shows Claude Desktop in a conversation where it uses KINDX search tools to answer a question about the user's local documents. The screenshot captures the config setup and a live conversation demonstrating retrieval-augmented responses.

## Command

Configuration file at `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kindx": {
      "command": "kindx",
      "args": ["serve"]
    }
  }
}
```

## Expected Screen Content

### Claude Desktop Window

**User message:**
```
What does our documentation say about error handling in the API?
```

**Claude response:**
```
Based on your documentation, here's what I found about API error handling:

Your API uses a consistent error response format across all endpoints. Every
error response includes three fields:

1. **`error`** - A machine-readable error code (e.g., `VALIDATION_FAILED`,
   `NOT_FOUND`, `RATE_LIMITED`)
2. **`message`** - A human-readable description of what went wrong
3. **`details`** (optional) - Additional context, such as which field failed
   validation

Example error response from your API reference:

    {
      "error": "VALIDATION_FAILED",
      "message": "The 'email' field must be a valid email address",
      "details": { "field": "email", "value": "not-an-email" }
    }

Your style guide also specifies that:
- 4xx errors should include actionable guidance for the client
- 5xx errors should log full stack traces server-side but return generic
  messages to clients
- Rate limiting returns 429 with a `Retry-After` header

Sources:
  kindx://my-docs/api-reference.md
  kindx://my-docs/style-guide.md
  kindx://my-docs/error-handling.md
```

**Tool use indicator (shown in Claude Desktop UI):**
```
Used tool: kindx_query
  collection: "my-docs"
  query: "error handling API"
  top: 5
```

## Annotations

- **MCP tool use indicator:** Claude Desktop shows when tools are invoked. The `kindx_query` tool was called automatically -- Claude decided to search the user's documents based on the question.
- **Hybrid search selection:** Claude chose `kindx_query` (hybrid mode) rather than `kindx_search` (BM25 only) or `kindx_vsearch` (vector only), getting the benefits of both retrieval methods.
- **Source attribution:** Claude includes `kindx://` URIs at the end of its response, letting the user trace every claim back to a specific document.
- **Synthesized answer:** Claude doesn't just dump search results -- it reads the retrieved documents and synthesizes a structured, coherent answer with formatting and examples.
- **Three-line config:** The entire integration requires only adding the `kindx` entry to `claude_desktop_config.json`. No authentication, no API keys, no server management.
- **Local execution:** The entire flow -- Claude's tool call, KINDX's search, document retrieval -- happens locally. No document content is sent to any external service beyond the conversation with Claude.
