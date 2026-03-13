# Claude Desktop + KINDX Integration

Connect KINDX to Claude Desktop so Claude can search your local documents, code, and notes with hybrid BM25 + semantic search — all on-device, zero cloud dependency.

## Prerequisites

- **Node.js 20+** — verify with `node --version`
- **Claude Desktop** — installed and running ([download](https://claude.ai/download))

## Step 1: Install KINDX

```bash
npm install -g @ambicuity/kindx
```

Verify the installation:

```bash
kindx --version
```

> **Tip:** If you get an `EACCES` error, see the [npm global install docs](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) or use a Node version manager like `nvm`.

## Step 2: Create a Collection

A collection tells KINDX which folder(s) to index.

```bash
# Add a collection pointing at your Documents folder
kindx collection add my-docs ~/Documents

# Verify it was registered
kindx status
```

Collections are stored in `~/.config/kindx/collections.yml`. You can add as many as you like:

```bash
kindx collection add work-notes ~/work/notes
kindx collection add project-x ~/code/project-x
```

## Step 3: Build Embeddings

Generate the vector embeddings that power semantic search:

```bash
kindx embed
```

This downloads a small local model on first run and indexes every document in your collections. Re-run it whenever you add new files.

## Step 4: Configure Claude Desktop

Edit the Claude Desktop config file for your platform:

| Platform | Config path |
|----------|-------------|
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Linux** | `~/.config/claude/claude_desktop_config.json` |
| **WSL** | `~/.config/claude/claude_desktop_config.json` |

Add the KINDX MCP server entry. If the file doesn't exist yet, create it with this content:

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

If you already have other MCP servers configured, add the `"kindx"` key inside the existing `"mcpServers"` object.

> **Important:** After saving the config, **restart Claude Desktop** for the changes to take effect.

## Step 5: Verify the Connection

Open Claude Desktop. You should see a hammer icon (MCP tools indicator) in the chat input area. Click it to confirm that KINDX tools are listed:

- **kindx_search** — BM25 keyword search
- **kindx_query** — hybrid search with reranking
- **kindx_get** — retrieve a specific document by path
- **kindx_ls** — list indexed files
- **kindx_status** — check KINDX health and collection info

## Example Conversation

Here's what a typical interaction looks like once everything is connected:

> **You:** What do my meeting notes say about the Q3 roadmap?
>
> **Claude:** Let me search your documents for that.
>
> *Claude calls `kindx_query` with query "Q3 roadmap meeting notes"*
>
> **Claude:** I found relevant content in two files:
>
> 1. **~/Documents/meetings/2026-01-15-planning.md** — Contains the Q3 roadmap discussion where the team agreed to prioritize the mobile app rewrite and API v2 migration.
> 2. **~/Documents/meetings/2026-02-03-review.md** — Follow-up review noting that the mobile app rewrite was moved to Q4 due to resource constraints.
>
> Would you like me to pull up the full contents of either file?

> **You:** Show me the full planning doc.
>
> *Claude calls `kindx_get` with the file path*
>
> **Claude:** Here are the complete contents of that meeting note: ...

## Troubleshooting

### "kindx: command not found"

Claude Desktop cannot find the `kindx` binary. This usually means the npm global bin directory is not in the PATH that Claude Desktop inherits.

**Fix (option A):** Use the full path to the binary in your config:

```json
{
  "mcpServers": {
    "kindx": {
      "command": "/usr/local/bin/kindx",
      "args": ["mcp"]
    }
  }
}
```

Find your path with `which kindx`.

**Fix (option B):** If you use `nvm`, point to the specific Node version:

```json
{
  "mcpServers": {
    "kindx": {
      "command": "/home/you/.nvm/versions/node/v20.11.0/bin/kindx",
      "args": ["mcp"]
    }
  }
}
```

### "No collections configured"

You haven't added any collections yet. Run:

```bash
kindx collection add my-docs ~/Documents
kindx embed
```

Then restart Claude Desktop.

### "Models not downloaded" or slow first query

KINDX downloads the embedding model on first use. If this was interrupted or hasn't happened yet:

```bash
kindx embed
```

This ensures the model is fully downloaded and all documents are indexed. The first run may take a few minutes depending on the size of your collections.

### Claude Desktop doesn't show the MCP tools icon

1. Double-check that the config JSON is valid (no trailing commas, correct nesting).
2. Confirm the config file is in the correct location for your platform.
3. Fully quit and reopen Claude Desktop (not just close the window).
4. Check Claude Desktop logs for MCP connection errors.

### Search returns no results

- Verify your collection has files: `kindx ls`
- Re-run embedding: `kindx embed`
- Check collection status: `kindx status`
