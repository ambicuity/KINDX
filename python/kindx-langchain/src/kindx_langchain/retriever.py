from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Dict, List, Optional
from urllib import request

try:
    from langchain_core.documents import Document
    from langchain_core.retrievers import BaseRetriever
except ImportError:
    @dataclass
    class Document:  # type: ignore[override]
        page_content: str
        metadata: Dict[str, Any]

    class BaseRetriever:  # type: ignore[override]
        def invoke(self, query: str) -> List[Document]:
            return self._get_relevant_documents(query)


class KindxRetriever(BaseRetriever):
    """LangChain-compatible retriever for a KINDX server."""

    url: str = "http://localhost:8181"
    collection: Optional[str] = None
    limit: int = 10
    token: Optional[str] = None
    timeout: float = 15.0

    def __init__(
        self,
        url: str = "http://localhost:8181",
        collection: Optional[str] = None,
        limit: int = 10,
        token: Optional[str] = None,
        timeout: float = 15.0,
    ) -> None:
        self.url = url.rstrip("/")
        self.collection = collection
        self.limit = limit
        self.token = token
        self.timeout = timeout

    def _post_json(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        endpoint = f"{self.url}{path}"
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        req = request.Request(endpoint, data=body, headers=headers, method="POST")
        with request.urlopen(req, timeout=self.timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}

    def _search(self, query: str) -> List[Dict[str, Any]]:
        payload: Dict[str, Any] = {
            "searches": [{"type": "vec", "query": query}],
            "limit": self.limit,
        }
        if self.collection:
            payload["collections"] = [self.collection]

        result = self._post_json("/query", payload)
        return result.get("results", [])

    def _to_document(self, item: Dict[str, Any]) -> Document:
        return Document(
            page_content=item.get("snippet", ""),
            metadata={
                "docid": item.get("docid"),
                "file": item.get("file"),
                "title": item.get("title"),
                "score": item.get("score"),
                "context": item.get("context"),
            },
        )

    def _get_relevant_documents(self, query: str, **_: Any) -> List[Document]:
        results = self._search(query)
        return [self._to_document(item) for item in results]
