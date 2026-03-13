# Continue.dev + KINDX Integration

Use KINDX as a context provider in [Continue.dev](https://continue.dev) to search your local documentation, codebase, and notes from within VS Code or JetBrains — completely on-device.

## Prerequisites

- **Continue.dev extension** installed in VS Code or JetBrains
- **Node.js 20+**
- **KINDX** installed globally: `npm install -g @ambicuity/kindx`

## Step 1: Index Your Documentation

Set up a collection for the docs or code you want Continue to search:

```bash
# Index internal documentation
kindx collection add internal-docs ~/work/docs

# Index your project source
kindx collection add project ~/code/my-project

# Build embeddings
kindx embed
```

## Step 2: Configure Continue

Continue reads its configuration from `.continue/config.json` in your home directory (or project root depending on your setup).

Add KINDX as an MCP server in your Continue config. Open `.continue/config.json` and add the following:

```json
{
  "models": [...],
  "mcpServers": [
    {
      "name": "kindx",
      "command": "kindx",
      "args": ["mcp"]
    }
  ]
}
```

If `kindx` is not on your default PATH, use the full path:

```json
{
  "mcpServers": [
    {
      "name": "kindx",
      "command": "/usr/local/bin/kindx",
      "args": ["mcp"]
    }
  ]
}
```

### Alternative: Context Provider Configuration

If your version of Continue uses the `context_providers` format, add KINDX there instead:

```json
{
  "models": [...],
  "context_providers": [
    {
      "name": "kindx",
      "provider": "mcp",
      "params": {
        "command": "kindx",
        "args": ["mcp"]
      }
    }
  ]
}
```

## Step 3: Restart Continue

After saving the config, reload the Continue extension (or restart your editor) so it connects to the KINDX MCP server.

## Use Case: Documentation Search During Coding

The primary advantage of this integration is seamless access to internal documentation while you write code. Instead of switching windows to search a wiki or docs site, ask Continue directly.

### Example Workflow

Imagine you're implementing a new API endpoint and need to follow your team's internal conventions:

> **You (in Continue chat):** What's our standard pattern for error handling in API endpoints? Check the internal docs.
>
> *Continue calls `kindx_query` with "API endpoint error handling standard pattern"*
>
> **Continue:** Based on your internal documentation (`~/work/docs/api-standards.md`), the standard pattern is:
>
> 1. Wrap handler logic in a try-catch block
> 2. Use the `AppError` class from `@internal/errors` for known error types
> 3. Let unexpected errors propagate to the global error middleware
> 4. Always include a correlation ID from `req.correlationId`
>
> Here's the standard template:
> ```typescript
> export async function handleRequest(req: Request, res: Response, next: NextFunction) {
>   try {
>     // handler logic
>   } catch (error) {
>     if (error instanceof AppError) {
>       return res.status(error.statusCode).json({ error: error.message, correlationId: req.correlationId });
>     }
>     next(error);
>   }
> }
> ```

### Another Example: Checking Architecture Decisions

> **You:** Before I add a new microservice, what does our architecture decision record say about service boundaries?
>
> *Continue calls `kindx_search` with "architecture decision record service boundaries microservice"*
>
> **Continue:** ADR-007 (`~/work/docs/adrs/007-service-boundaries.md`) establishes that new services should...

## Available KINDX Tools

Once connected, Continue can use these MCP tools:

- **kindx_query** — Hybrid search (BM25 + semantic) with reranking. Best for natural language questions.
- **kindx_search** — BM25 keyword search. Best for exact term matching.
- **kindx_get** — Retrieve a full document by path.
- **kindx_ls** — List all indexed files.
- **kindx_status** — Check collection and index health.

## Full Sample Config

Here's a complete `.continue/config.json` showing KINDX alongside a typical Continue setup:

```json
{
  "models": [
    {
      "title": "Claude Sonnet",
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKey": "..."
    }
  ],
  "mcpServers": [
    {
      "name": "kindx",
      "command": "kindx",
      "args": ["mcp"]
    }
  ],
  "slashCommands": [
    {
      "name": "edit",
      "description": "Edit highlighted code"
    }
  ],
  "customCommands": [
    {
      "name": "search-docs",
      "description": "Search internal documentation with KINDX",
      "prompt": "Use the kindx_query tool to search for: {{{ input }}}"
    }
  ]
}
```

## Tips

- **Keep embeddings fresh.** Run `kindx embed` after adding or updating docs. Consider adding it to a git hook or a cron job.
- **Target your indexes.** Index specific doc folders rather than broad directories for faster, more relevant results.
- **Use `kindx_query` for questions, `kindx_search` for exact terms.** Continue will generally pick the right tool, but you can guide it by being specific in your prompts.
- **Combine with other context providers.** KINDX handles your custom docs; Continue's built-in providers handle open files and codebase symbols. They complement each other.

## Troubleshooting

- **Continue doesn't show KINDX tools:** Reload the extension after editing `config.json`. Check the Continue output panel for MCP connection errors.
- **"command not found":** Use the full path to the `kindx` binary in the config.
- **No search results:** Run `kindx status` to check collections, then `kindx embed` to rebuild.
