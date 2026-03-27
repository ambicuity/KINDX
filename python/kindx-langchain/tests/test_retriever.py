import json
import unittest
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from kindx_langchain import KindxRetriever


class _FakeResponse:
    def __init__(self, payload: dict):
        self._raw = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return self._raw


class KindxRetrieverTests(unittest.TestCase):
    @patch("kindx_langchain.retriever.request.urlopen")
    def test_invoke_returns_documents(self, mock_urlopen):
        mock_urlopen.return_value = _FakeResponse(
            {
                "results": [
                    {
                        "docid": "#abc123",
                        "file": "specs/eval-docs/intro.md",
                        "title": "Intro",
                        "score": 0.88,
                        "context": "docs",
                        "snippet": "KINDX introduction",
                    }
                ]
            }
        )

        retriever = KindxRetriever(url="http://localhost:8181", collection="docs", limit=2)
        docs = retriever.invoke("what is kindx")

        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].metadata["docid"], "#abc123")
        self.assertIn("KINDX", docs[0].page_content)


if __name__ == "__main__":
    unittest.main()
