# kindx-langchain

`kindx-langchain` provides `KindxRetriever`, a lightweight retriever that queries a running KINDX HTTP/MCP server and returns LangChain-style documents.

```python
from kindx_langchain import KindxRetriever

retriever = KindxRetriever(url="http://localhost:8181", collection="docs", limit=5)
docs = retriever.invoke("authentication flow")
```
