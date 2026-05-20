# kindx-langchain

> **Status: thin adapter.** This package is a LangChain retriever wrapper around the KINDX HTTP API. It is not a full Python product. For production integrations call the HTTP API directly. See [PYTHON.md](../../PYTHON.md) at the repo root for the full decision.

---

`kindx-langchain` provides `KindxRetriever`, a lightweight retriever that queries a running KINDX HTTP/MCP server and returns LangChain-style documents.

```python
from kindx_langchain import KindxRetriever

retriever = KindxRetriever(url="http://localhost:8181", collection="docs", limit=5)
docs = retriever.invoke("authentication flow")
```
