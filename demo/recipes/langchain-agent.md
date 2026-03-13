# LangChain + KINDX Agent

Build a LangChain agent in Python that uses KINDX as a local search tool. The agent can answer questions by searching your on-device indexed documents — no cloud vector database needed.

## Prerequisites

- **Python 3.10+**
- **Node.js 20+**
- **KINDX** installed and configured:
  ```bash
  npm install -g @ambicuity/kindx
  kindx collection add my-docs ~/Documents
  kindx embed
  ```
- **OpenAI API key** (or any LangChain-supported LLM)

## Install Python Dependencies

```bash
pip install langchain langchain-community langchain-openai
```

## How It Works

KINDX runs as a local CLI tool. The LangChain integration wraps `kindx search --json` in a custom tool class, letting the agent invoke local hybrid search as part of its reasoning chain.

## Custom Tool Class

Here's a reusable tool class that wraps the KINDX CLI:

```python
import json
import subprocess
from typing import Optional

from langchain.tools import BaseTool
from pydantic import Field


class KindxSearchTool(BaseTool):
    """LangChain tool that searches local documents using KINDX."""

    name: str = "kindx_search"
    description: str = (
        "Search local documents, code, and notes using KINDX hybrid search. "
        "Input should be a natural language query. Returns relevant document "
        "snippets from the locally indexed collection."
    )
    collection: Optional[str] = Field(
        default=None,
        description="Optional collection name to search within.",
    )
    max_results: int = Field(
        default=5,
        description="Maximum number of results to return.",
    )

    def _run(self, query: str) -> str:
        """Execute a KINDX search via the CLI."""
        cmd = ["kindx", "search", "--json", query]

        if self.collection:
            cmd.extend(["--collection", self.collection])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode != 0:
                return f"KINDX search failed: {result.stderr.strip()}"

            results = json.loads(result.stdout)

            if not results:
                return "No results found for this query."

            # Format results for the LLM
            formatted = []
            for i, doc in enumerate(results[: self.max_results], 1):
                path = doc.get("path", "unknown")
                snippet = doc.get("snippet", doc.get("content", ""))
                score = doc.get("score", 0)
                formatted.append(
                    f"[{i}] {path} (score: {score:.3f})\n{snippet}"
                )

            return "\n\n".join(formatted)

        except subprocess.TimeoutExpired:
            return "KINDX search timed out after 30 seconds."
        except json.JSONDecodeError:
            return f"Failed to parse KINDX output: {result.stdout[:200]}"
        except FileNotFoundError:
            return (
                "KINDX CLI not found. Install it with: "
                "npm install -g @ambicuity/kindx"
            )
```

## Complete Runnable Script

Save this as `kindx_agent.py` and run it:

```python
#!/usr/bin/env python3
"""
LangChain agent with KINDX local document search.

Usage:
    export OPENAI_API_KEY="sk-..."
    python kindx_agent.py
"""

import json
import subprocess
from typing import Optional

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain.tools import BaseTool
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from pydantic import Field


# --- KINDX Tool ---

class KindxSearchTool(BaseTool):
    """Search local documents using KINDX hybrid search."""

    name: str = "kindx_search"
    description: str = (
        "Search local documents, code, and notes using KINDX hybrid search. "
        "Input should be a natural language query. Returns relevant document "
        "snippets from the locally indexed collection."
    )
    collection: Optional[str] = Field(default=None)
    max_results: int = Field(default=5)

    def _run(self, query: str) -> str:
        cmd = ["kindx", "search", "--json", query]
        if self.collection:
            cmd.extend(["--collection", self.collection])

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                return f"Search failed: {result.stderr.strip()}"

            results = json.loads(result.stdout)
            if not results:
                return "No results found."

            formatted = []
            for i, doc in enumerate(results[: self.max_results], 1):
                path = doc.get("path", "unknown")
                snippet = doc.get("snippet", doc.get("content", ""))
                score = doc.get("score", 0)
                formatted.append(
                    f"[{i}] {path} (score: {score:.3f})\n{snippet}"
                )
            return "\n\n".join(formatted)

        except subprocess.TimeoutExpired:
            return "Search timed out."
        except json.JSONDecodeError:
            return f"Parse error: {result.stdout[:200]}"
        except FileNotFoundError:
            return "kindx not found. Run: npm install -g @ambicuity/kindx"


class KindxGetTool(BaseTool):
    """Retrieve a specific document by path from KINDX."""

    name: str = "kindx_get"
    description: str = (
        "Retrieve the full contents of a specific file by its path. "
        "Use this after searching to read a complete document."
    )

    def _run(self, path: str) -> str:
        try:
            result = subprocess.run(
                ["kindx", "get", path],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode != 0:
                return f"Failed to retrieve {path}: {result.stderr.strip()}"
            return result.stdout

        except subprocess.TimeoutExpired:
            return f"Timed out retrieving {path}."
        except FileNotFoundError:
            return "kindx not found. Run: npm install -g @ambicuity/kindx"


# --- Agent Setup ---

def create_kindx_agent():
    """Create a LangChain agent with KINDX tools."""

    tools = [
        KindxSearchTool(),
        KindxGetTool(),
    ]

    llm = ChatOpenAI(model="gpt-4o", temperature=0)

    prompt = ChatPromptTemplate.from_messages([
        (
            "system",
            "You are a helpful assistant with access to a local document "
            "search engine called KINDX. Use the kindx_search tool to find "
            "relevant documents, and kindx_get to retrieve full file contents "
            "when needed. Always cite the source file paths in your answers.",
        ),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ])

    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(agent=agent, tools=tools, verbose=True)


# --- Main ---

def main():
    agent = create_kindx_agent()

    print("KINDX + LangChain Agent")
    print("Type your questions (Ctrl+C to exit)")
    print("-" * 40)

    while True:
        try:
            question = input("\nYou: ").strip()
            if not question:
                continue

            result = agent.invoke({"input": question})
            print(f"\nAgent: {result['output']}")

        except KeyboardInterrupt:
            print("\nGoodbye!")
            break


if __name__ == "__main__":
    main()
```

## Running the Agent

```bash
# Set your OpenAI API key
export OPENAI_API_KEY="sk-..."

# Make sure KINDX has indexed content
kindx status

# Run the agent
python kindx_agent.py
```

### Example Session

```
KINDX + LangChain Agent
Type your questions (Ctrl+C to exit)
----------------------------------------

You: What are our API rate limiting policies?

> Entering new AgentExecutor chain...

Invoking: `kindx_search` with `API rate limiting policies`

[1] ~/Documents/engineering/api-standards.md (score: 0.847)
## Rate Limiting
All public API endpoints must implement rate limiting...

[2] ~/Documents/runbooks/rate-limit-config.md (score: 0.723)
# Rate Limit Configuration
Production rate limits are set in...

Agent: Based on your internal documentation, your API rate limiting
policies are defined in `api-standards.md`. The key points are:
1. All public endpoints must implement rate limiting
2. Default limit is 100 requests per minute per API key
...

> Finished chain.
```

## Customization

### Search a specific collection

```python
tools = [
    KindxSearchTool(collection="engineering-docs"),
    KindxSearchTool(collection="codebase", name="code_search",
                    description="Search the codebase for code patterns."),
    KindxGetTool(),
]
```

### Use a different LLM

Replace `ChatOpenAI` with any LangChain-supported model:

```python
from langchain_anthropic import ChatAnthropic
llm = ChatAnthropic(model="claude-sonnet-4-20250514")
```

```python
from langchain_community.llms import Ollama
llm = Ollama(model="llama3")
```

### Adjust result count

```python
KindxSearchTool(max_results=10)
```
