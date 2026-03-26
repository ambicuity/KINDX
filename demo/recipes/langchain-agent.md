# LangChain + KINDX Agent

Build a LangChain agent that shells out to the local KINDX CLI for search and document retrieval.

## Prerequisites

- **Python 3.10+**
- **Node.js 20+**
- **KINDX** installed and indexed:

```bash
npm install -g @ambicuity/kindx
kindx collection add ~/Documents --name my-docs
kindx update -c my-docs
kindx embed
```

- **An LLM provider supported by LangChain**

## Install Python dependencies

```bash
pip install langchain langchain-openai
```

## Runnable example

```python
#!/usr/bin/env python3
import json
import subprocess
from typing import Optional

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain.tools import BaseTool
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from pydantic import Field


class KindxCliQueryTool(BaseTool):
    name: str = "kindx_cli_query"
    description: str = (
        "Search local documents with KINDX. Input should be a natural-language question "
        "or a keyword-heavy lookup."
    )
    collection: Optional[str] = Field(default=None)
    max_results: int = Field(default=5)

    def _run(self, query: str) -> str:
        cmd = ["kindx", "query", query, "--json", "-n", str(self.max_results)]
        if self.collection:
            cmd.extend(["-c", self.collection])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return result.stderr.strip() or "KINDX query failed."
        try:
            docs = json.loads(result.stdout)
        except json.JSONDecodeError:
            return result.stdout[:500]
        if not docs:
            return "No results found."
        lines = []
        for i, doc in enumerate(docs, 1):
            lines.append(
                f"[{i}] {doc['file']} ({doc['title']}, score={doc['score']})\n{doc['snippet']}"
            )
        return "\n\n".join(lines)


class KindxCliGetTool(BaseTool):
    name: str = "kindx_cli_get"
    description: str = "Retrieve a full KINDX document by file path or docid."

    def _run(self, file: str) -> str:
        result = subprocess.run(
            ["kindx", "get", file],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return result.stderr.strip() or f"Failed to retrieve {file}"
        return result.stdout


tools = [
    KindxCliQueryTool(collection="my-docs", max_results=5),
    KindxCliGetTool(),
]

prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are a helpful assistant with access to a local KINDX index. "
            "Use kindx_cli_query to find relevant documents, then use kindx_cli_get "
            "when you need the full source.",
        ),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ]
)

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

print(executor.invoke({"input": "What are our API rate limiting policies?"})["output"])
```

## Notes

- `kindx query ... --json` returns an array of result objects with `docid`, `file`, `title`, `score`, and `snippet`.
- `kindx get <file-or-docid>` reads the full source when the agent needs more context.
- If you want purely lexical retrieval, swap `query` for `search` in the tool implementation.
