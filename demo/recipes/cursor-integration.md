# Cursor IDE + KINDX Integration

Use KINDX as an MCP server inside Cursor to give the AI assistant hybrid search over your codebase, documentation, and local files — entirely on-device.

## Prerequisites

- **Cursor IDE** (latest version with MCP support)
- **Node.js 20+**
- **KINDX** installed globally: `npm install -g @ambicuity/kindx`

## Step 1: Set Up a Collection

Index the folders you want Cursor's AI to search:

```bash
# Index the current project
kindx collection add my-project .

# Or index a monorepo
kindx collection add monorepo ~/code/my-monorepo

# Build embeddings
kindx embed
```

## Step 2: Add MCP Server in Cursor

Cursor reads MCP server configuration from `.cursor/mcp.json` in your project root.

Create the file at `<project-root>/.cursor/mcp.json`:

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

> **Note:** If `kindx` is not on the default PATH that Cursor inherits, use the full path (find it with `which kindx`):
> ```json
> {
>   "mcpServers": {
>     "kindx": {
>       "command": "/usr/local/bin/kindx",
>       "args": ["mcp"]
>     }
>   }
> }
> ```

## Step 3: Restart Cursor

After saving `.cursor/mcp.json`, restart Cursor (or reload the window) so it picks up the new MCP server.

## How Cursor Uses KINDX

Once connected, Cursor's AI assistant has access to these MCP tools:

| Tool | Purpose |
|------|---------|
| `kindx_search` | BM25 keyword search across indexed files |
| `kindx_query` | Hybrid search (BM25 + semantic) with reranking |
| `kindx_get` | Retrieve a specific file's contents |
| `kindx_ls` | List all indexed files |
| `kindx_status` | Check KINDX health and collection stats |

The AI will automatically choose the right tool based on your question.

## Use Case: Monorepo Code Search

KINDX is especially powerful in large monorepos where Cursor's built-in search may not surface the most relevant results. Hybrid search combines exact keyword matching with semantic understanding.

### Example: Finding Authentication Patterns

> **You:** Search my codebase for authentication patterns — I need to understand how we handle JWT validation across services.
>
> *Cursor calls `kindx_query` with query "JWT authentication validation middleware"*
>
> **Cursor:** I found authentication-related code in several locations:
>
> 1. `packages/auth/src/middleware.ts` — Central JWT validation middleware
> 2. `packages/api-gateway/src/auth.ts` — Gateway-level token verification
> 3. `packages/user-service/src/guards/jwt.guard.ts` — Service-specific JWT guard
> 4. `docs/architecture/auth-flow.md` — Architecture doc describing the auth flow
>
> The common pattern is...

### Example: Understanding Data Models

> **You:** How is the `Order` entity defined and where is it used?
>
> *Cursor calls `kindx_search` with query "Order entity class model"*
>
> **Cursor:** The `Order` entity is defined in `packages/orders/src/entities/order.entity.ts` and is referenced in 12 files across the orders and billing packages...

## Tips for Effective Usage

### 1. Index only what matters

Keep collections focused. Rather than indexing your entire home directory, target specific project directories:

```bash
kindx collection add backend ~/code/monorepo/packages/backend
kindx collection add docs ~/code/monorepo/docs
kindx collection add shared ~/code/monorepo/packages/shared
```

### 2. Re-embed after significant changes

When you add new files or make large refactors, update the index:

```bash
kindx embed
```

### 3. Use natural language queries

KINDX's hybrid search understands intent. Instead of exact symbol names, try:

- "How do we handle rate limiting?" instead of `rateLimit`
- "Error handling patterns in the API layer" instead of `try catch`
- "Database connection setup" instead of `createConnection`

### 4. Combine with Cursor's built-in features

KINDX complements Cursor's native code intelligence. Use KINDX for broad conceptual searches across the codebase, and Cursor's built-in go-to-definition and references for precise symbol navigation.

### 5. Commit the config file

Add `.cursor/mcp.json` to version control so your entire team gets KINDX integration automatically:

```bash
git add .cursor/mcp.json
git commit -m "chore: add KINDX MCP server config for Cursor"
```

## Troubleshooting

- **Tools not appearing:** Restart Cursor after adding the config file.
- **"command not found":** Use the full path to `kindx` in the config.
- **Empty results:** Run `kindx status` to confirm collections exist, then `kindx embed` to rebuild the index.
- **Slow first query:** The embedding model downloads on first use. Run `kindx embed` in a terminal first to ensure it's ready.
