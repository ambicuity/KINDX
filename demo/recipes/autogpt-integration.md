# Autonomous Agent Frameworks + KINDX

Use KINDX's MCP HTTP endpoint to give any autonomous agent framework — AutoGPT, BabyAGI, custom agent loops — access to fast, private, local document search over your indexed files.

## Why KINDX for Autonomous Agents?

- **Zero-latency local search** — no network round-trips to a cloud vector database. Queries return in milliseconds.
- **No API costs** — KINDX runs entirely on your machine. No per-query charges, no usage limits.
- **Private data stays local** — your documents never leave your device. The agent sends queries to localhost, not the internet.
- **Hybrid search** — combines BM25 keyword matching with semantic understanding for higher relevance than either approach alone.

## Prerequisites

- **Node.js 20+**
- **KINDX** installed and configured:
  ```bash
  npm install -g @ambicuity/kindx
  kindx collection add knowledge-base ~/knowledge
  kindx embed
  ```

## Starting the MCP HTTP Server

KINDX can expose its MCP tools over HTTP, making it accessible to any framework that can send HTTP requests:

```bash
kindx mcp --http --port 8181
```

This starts an HTTP server on `http://localhost:8181` that speaks the Model Context Protocol. Keep this running in a terminal (or run it in the background).

To run it in the background:

```bash
kindx mcp --http --port 8181 &
```

## MCP HTTP Endpoint

The server accepts JSON-RPC requests at `http://localhost:8181`. All MCP tool calls follow the standard MCP JSON-RPC format.

### Available Tools

| Tool | Description |
|------|-------------|
| `kindx_search` | BM25 keyword search |
| `kindx_query` | Hybrid search with semantic reranking |
| `kindx_get` | Retrieve a specific document by path |
| `kindx_ls` | List all indexed files |
| `kindx_status` | Check health and collection info |

## Example curl Calls

### Hybrid search (recommended)

```bash
curl -s http://localhost:8181 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "kindx_query",
      "arguments": {
        "query": "how to configure database connections"
      }
    }
  }' | jq .
```

### BM25 keyword search

```bash
curl -s http://localhost:8181 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "kindx_search",
      "arguments": {
        "query": "DATABASE_URL connection string"
      }
    }
  }' | jq .
```

### Retrieve a specific document

```bash
curl -s http://localhost:8181 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "kindx_get",
      "arguments": {
        "path": "~/knowledge/runbooks/deploy.md"
      }
    }
  }' | jq .
```

### List indexed files

```bash
curl -s http://localhost:8181 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "kindx_ls",
      "arguments": {}
    }
  }' | jq .
```

### Check status

```bash
curl -s http://localhost:8181 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "kindx_status",
      "arguments": {}
    }
  }' | jq .
```

## Integration Pattern: Search Before Acting

The core pattern for autonomous agents is: **query KINDX for relevant knowledge before taking action**. This grounds the agent's decisions in your local documents and prevents hallucination about internal processes, configurations, and standards.

```
Agent receives task
    |
    v
Query KINDX for relevant context
    |
    v
Incorporate search results into prompt
    |
    v
LLM generates plan/action with grounded context
    |
    v
Execute action
    |
    v
Loop or complete
```

## Example: Generic Autonomous Agent Loop

Here's a complete Python example of an autonomous agent that uses KINDX for knowledge retrieval:

```python
#!/usr/bin/env python3
"""
Autonomous agent with KINDX local knowledge search.

Start the KINDX HTTP server first:
    kindx mcp --http --port 8181

Then run:
    export OPENAI_API_KEY="sk-..."
    python kindx_agent_loop.py "Deploy the new payment service"
"""

import json
import sys
from typing import Any

import requests
from openai import OpenAI

KINDX_URL = "http://localhost:8181"
MAX_ITERATIONS = 10


def kindx_call(tool_name: str, arguments: dict) -> Any:
    """Call a KINDX MCP tool via the HTTP endpoint."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
        },
    }
    try:
        resp = requests.post(
            KINDX_URL,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=15,
        )
        resp.raise_for_status()
        result = resp.json()
        return result.get("result", result)
    except requests.RequestException as e:
        return {"error": str(e)}


def search_knowledge(query: str) -> str:
    """Search local knowledge base using KINDX hybrid search."""
    result = kindx_call("kindx_query", {"query": query})
    if isinstance(result, dict) and "error" in result:
        return f"Search error: {result['error']}"
    return json.dumps(result, indent=2)


def get_document(path: str) -> str:
    """Retrieve a specific document from KINDX."""
    result = kindx_call("kindx_get", {"path": path})
    if isinstance(result, dict) and "error" in result:
        return f"Retrieval error: {result['error']}"
    return json.dumps(result, indent=2)


def run_agent(task: str):
    """Run an autonomous agent loop with KINDX knowledge grounding."""
    client = OpenAI()

    print(f"Task: {task}")
    print("=" * 60)

    # Step 1: Search for relevant context before planning
    print("\n[Agent] Searching knowledge base for relevant context...")
    context = search_knowledge(task)
    print(f"[Agent] Found context:\n{context[:500]}...")

    messages = [
        {
            "role": "system",
            "content": (
                "You are an autonomous agent completing a task. You have "
                "access to a local knowledge base via KINDX search. Use the "
                "provided context to make informed decisions. At each step, "
                "output a JSON object with:\n"
                '  - "thought": your reasoning\n'
                '  - "action": what to do next (search / read_doc / execute / complete)\n'
                '  - "action_input": input for the action\n'
                '  - "status": "in_progress" or "complete"\n'
            ),
        },
        {
            "role": "user",
            "content": (
                f"Task: {task}\n\n"
                f"Relevant knowledge from local docs:\n{context}\n\n"
                "Plan and execute this task step by step."
            ),
        },
    ]

    for iteration in range(MAX_ITERATIONS):
        print(f"\n--- Iteration {iteration + 1} ---")

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            temperature=0,
        )

        assistant_msg = response.choices[0].message.content
        print(f"[Agent] {assistant_msg}")

        messages.append({"role": "assistant", "content": assistant_msg})

        # Parse agent output
        try:
            step = json.loads(assistant_msg)
        except json.JSONDecodeError:
            # If the agent didn't return JSON, treat it as complete
            print("[Agent] Task complete (non-JSON response).")
            break

        if step.get("status") == "complete":
            print("\n[Agent] Task completed!")
            print(f"Final output: {step.get('thought', 'Done')}")
            break

        # Handle agent actions
        action = step.get("action", "")
        action_input = step.get("action_input", "")

        if action == "search":
            print(f"[Agent] Searching KINDX: {action_input}")
            result = search_knowledge(action_input)
            messages.append({
                "role": "user",
                "content": f"Search results:\n{result}",
            })

        elif action == "read_doc":
            print(f"[Agent] Reading document: {action_input}")
            result = get_document(action_input)
            messages.append({
                "role": "user",
                "content": f"Document contents:\n{result}",
            })

        elif action == "execute":
            print(f"[Agent] Would execute: {action_input}")
            # In a real agent, you'd execute the action here.
            # For safety, we just acknowledge it.
            messages.append({
                "role": "user",
                "content": (
                    f"Action '{action_input}' acknowledged. "
                    "Continue to the next step."
                ),
            })

        else:
            messages.append({
                "role": "user",
                "content": "Unrecognized action. Please continue.",
            })

    else:
        print(f"\n[Agent] Reached max iterations ({MAX_ITERATIONS}).")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python kindx_agent_loop.py <task description>")
        sys.exit(1)

    run_agent(" ".join(sys.argv[1:]))
```

### Running the Example

```bash
# Terminal 1: Start KINDX HTTP server
kindx mcp --http --port 8181

# Terminal 2: Run the agent
export OPENAI_API_KEY="sk-..."
python kindx_agent_loop.py "What are the steps to deploy the payment service to production?"
```

### Example Output

```
Task: What are the steps to deploy the payment service to production?
============================================================

[Agent] Searching knowledge base for relevant context...
[Agent] Found context:
[results from ~/knowledge/runbooks/deploy-payment.md]...

--- Iteration 1 ---
[Agent] {"thought": "Found the deployment runbook. Let me read the full document.",
         "action": "read_doc",
         "action_input": "~/knowledge/runbooks/deploy-payment.md",
         "status": "in_progress"}
[Agent] Reading document: ~/knowledge/runbooks/deploy-payment.md

--- Iteration 2 ---
[Agent] {"thought": "I now have the complete deployment procedure...",
         "action": "complete",
         "action_input": "",
         "status": "complete"}

[Agent] Task completed!
```

## Adapting for Other Frameworks

### AutoGPT

Add KINDX as a plugin or custom command that calls the HTTP endpoint. In your AutoGPT plugins directory, create a module that wraps the `kindx_call` function above.

### BabyAGI

Insert a KINDX search step in the task execution chain. Before the execution agent runs, query KINDX for relevant context and prepend it to the task prompt.

### CrewAI

Define a KINDX tool for your crew:

```python
from crewai.tools import tool

@tool("Search Local Knowledge")
def search_local_knowledge(query: str) -> str:
    """Search the local knowledge base using KINDX hybrid search."""
    # Use the kindx_call function from above
    result = kindx_call("kindx_query", {"query": query})
    return json.dumps(result, indent=2)
```

### Any HTTP Client

The pattern is the same regardless of language or framework. Send a JSON-RPC POST to `http://localhost:8181` with the tool name and arguments. Parse the JSON response. That's it.

## Tips

- **Start the HTTP server before your agent.** If the agent can't reach KINDX, it should fail gracefully rather than hallucinate.
- **Use `kindx_query` for most searches.** It combines keyword and semantic search for the best results.
- **Cache frequent queries** if your agent loop asks similar questions repeatedly.
- **Index everything the agent might need** — runbooks, configs, architecture docs, code. The more knowledge KINDX has, the better the agent's decisions.
- **Keep embeddings up to date** by running `kindx embed` regularly, especially after adding new documents.
