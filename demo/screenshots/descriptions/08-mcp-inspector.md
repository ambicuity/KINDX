# Screenshot 08: MCP Inspector

## Description

Shows the MCP Inspector tool connected to the KINDX server, displaying the available tools, their schemas, and a sample tool invocation. The MCP Inspector is a developer tool for testing and debugging MCP servers.

## Command

```bash
$ kindx serve
```

Then, in a separate terminal:

```bash
$ npx @modelcontextprotocol/inspector kindx serve
```

## Expected Terminal Output

**KINDX server (terminal 1):**
```
$ kindx serve
KINDX MCP Server running on stdio
  Collections: my-docs (34 docs)
  Tools: kindx_search, kindx_vsearch, kindx_query, kindx_collections
  Ready for connections
```

**MCP Inspector (terminal 2 / browser UI):**

The Inspector shows a web interface with the following panels:

### Tools Panel

```
Available Tools (4):

kindx_search
  Description: BM25 keyword search across a document collection
  Parameters:
    collection (string, required): Collection name to search
    query (string, required): Search query text
    top (number, optional): Number of results to return (default: 5)

kindx_vsearch
  Description: Vector similarity search using semantic embeddings
  Parameters:
    collection (string, required): Collection name to search
    query (string, required): Search query text
    top (number, optional): Number of results to return (default: 5)

kindx_query
  Description: Hybrid search combining BM25 and vector retrieval
  Parameters:
    collection (string, required): Collection name to search
    query (string, required): Search query text
    top (number, optional): Number of results to return (default: 5)
    explain (boolean, optional): Show retrieval trace (default: false)

kindx_collections
  Description: List all available document collections
  Parameters: (none)
```

### Test Invocation Panel

```
Tool: kindx_search
Input:
{
  "collection": "my-docs",
  "query": "authentication",
  "top": 3
}

Response:
{
  "content": [
    {
      "type": "text",
      "text": "BM25 Search: \"authentication\" (3 results)\n\n  #1  [11.3] kindx://my-docs/security.md\n      \"Authentication is handled via JWT tokens issued by the /auth/login endpoint...\"\n\n  #2  [8.9] kindx://my-docs/api-reference.md\n      \"All authenticated endpoints require a Bearer token in the Authorization header...\"\n\n  #3  [5.4] kindx://my-docs/middleware.md\n      \"The authentication middleware validates tokens and attaches the user context...\""
    }
  ]
}
```

## Annotations

- **4 tools exposed:** KINDX registers four MCP tools -- three search modes and a collection listing utility. These are the tools AI agents see and can call.
- **Tool schemas:** Each tool has typed parameters with descriptions. The `collection` and `query` parameters are required; `top` and `explain` are optional with sensible defaults.
- **`kindx_collections` tool:** A parameter-free tool that lets agents discover which collections are available before searching. This enables dynamic collection selection.
- **MCP response format:** Results are returned as `content` blocks with `type: "text"`. This follows the MCP tool response specification and is compatible with all MCP clients.
- **Inspector test panel:** The Inspector allows sending test invocations to the server and viewing raw responses, making it useful for debugging tool behavior.
- **stdio transport:** KINDX uses stdio transport (standard MCP protocol). The Inspector connects to it by wrapping the `kindx serve` command.
