# Autonomous Agent Frameworks + KINDX

Use KINDX's MCP HTTP transport to give an autonomous agent loop access to local retrieval over your indexed files.

## Prerequisites

- **Node.js 20+**
- **KINDX** installed and indexed:

```bash
npm install -g @ambicuity/kindx
kindx collection add ~/knowledge --name knowledge-base
kindx update -c knowledge-base
kindx embed
```

## Start the HTTP transport

```bash
kindx mcp --http --port 8181
```

The MCP endpoint is `http://localhost:8181/mcp`. A health check is also exposed at `http://localhost:8181/health`.

## Available tools

- `query`
- `get`
- `multi_get`
- `status`

## Minimal Python client

```python
#!/usr/bin/env python3
import json
from typing import Any

import requests

MCP_URL = "http://localhost:8181/mcp"
HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


def initialize_session() -> str:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "kindx-agent", "version": "0.1.0"},
        },
    }
    response = requests.post(MCP_URL, headers=HEADERS, json=payload, timeout=15)
    response.raise_for_status()
    session_id = response.headers.get("mcp-session-id")
    if not session_id:
        raise RuntimeError("Missing mcp-session-id header from initialize response")
    return session_id


def call_tool(session_id: str, name: str, arguments: dict[str, Any]) -> Any:
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments,
        },
    }
    headers = {**HEADERS, "mcp-session-id": session_id}
    response = requests.post(MCP_URL, headers=headers, json=payload, timeout=15)
    response.raise_for_status()
    return response.json()["result"]


if __name__ == "__main__":
    session = initialize_session()
    search = call_tool(
        session,
        "query",
        {
            "searches": [
                {"type": "lex", "query": "\"database connections\""},
                {"type": "vec", "query": "how do we configure database connections"},
            ],
            "collections": ["knowledge-base"],
            "limit": 5,
        },
    )
    print(json.dumps(search, indent=2))
```

## Retrieval pattern for autonomous agents

1. Start an MCP session with `initialize`.
2. Call `query` before planning or executing an action.
3. Follow up with `get` or `multi_get` for the most relevant sources.
4. Use `status` to confirm the local index is healthy.

This keeps the agent grounded in local source material while staying inside the standard MCP protocol.
