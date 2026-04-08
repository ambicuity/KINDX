#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import statistics
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp
from typing import Any

import chromadb
import lancedb
import numpy as np
import pyarrow as pa
from sklearn.feature_extraction.text import TfidfVectorizer


@dataclass(frozen=True)
class EvalQuery:
    query: str
    expected_doc: str
    difficulty: str


EVAL_QUERIES: list[EvalQuery] = [
    EvalQuery("API versioning", "api-design", "easy"),
    EvalQuery("Series A fundraising", "fundraising", "easy"),
    EvalQuery("CAP theorem", "distributed-systems", "easy"),
    EvalQuery("overfitting machine learning", "machine-learning", "easy"),
    EvalQuery("remote work VPN", "remote-work", "easy"),
    EvalQuery("Project Phoenix retrospective", "product-launch", "easy"),
    EvalQuery("how to structure REST endpoints", "api-design", "medium"),
    EvalQuery("raising money for startup", "fundraising", "medium"),
    EvalQuery("consistency vs availability tradeoffs", "distributed-systems", "medium"),
    EvalQuery("how to prevent models from memorizing data", "machine-learning", "medium"),
    EvalQuery("working from home guidelines", "remote-work", "medium"),
    EvalQuery("what went wrong with the launch", "product-launch", "medium"),
    EvalQuery("nouns not verbs", "api-design", "hard"),
    EvalQuery("Sequoia investor pitch", "fundraising", "hard"),
    EvalQuery("Raft algorithm leader election", "distributed-systems", "hard"),
    EvalQuery("F1 score precision recall", "machine-learning", "hard"),
    EvalQuery("quarterly team gathering travel", "remote-work", "hard"),
    EvalQuery("beta program 47 bugs", "product-launch", "hard"),
    EvalQuery("how much runway before running out of money", "fundraising", "fusion"),
    EvalQuery("datacenter replication sync strategy", "distributed-systems", "fusion"),
    EvalQuery("splitting data for training and testing", "machine-learning", "fusion"),
    EvalQuery("JSON response codes error messages", "api-design", "fusion"),
    EvalQuery("video calls camera async messaging", "remote-work", "fusion"),
    EvalQuery("CI/CD pipeline testing coverage", "product-launch", "fusion"),
]


def load_docs(eval_dir: Path) -> list[dict[str, str]]:
    docs: list[dict[str, str]] = []
    for path in sorted(eval_dir.glob("*.md")):
        text = path.read_text()
        title = text.splitlines()[0].removeprefix("# ").strip()
        docs.append({
            "id": path.stem,
            "path": path.name,
            "title": title,
            "text": text,
        })
    return docs


def ensure_clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def run_cmd(args: list[str], env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(args, capture_output=True, text=True, env=env, check=True)
    return proc.stdout


def first_match(results: list[str], expected_doc: str, top_k: int) -> bool:
    return any(expected_doc in item.lower() for item in results[:top_k])


def summarize_hits(rows: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {"overall": {}, "by_difficulty": {}}
    for top_k in (1, 3, 5):
        summary["overall"][f"hit@{top_k}"] = round(
            sum(1 for row in rows if row[f"hit@{top_k}"]) / len(rows), 3
        )
    for difficulty in sorted({row["difficulty"] for row in rows}):
        bucket = [row for row in rows if row["difficulty"] == difficulty]
        summary["by_difficulty"][difficulty] = {
            f"hit@{top_k}": round(sum(1 for row in bucket if row[f"hit@{top_k}"]) / len(bucket), 3)
            for top_k in (1, 3, 5)
        }
    return summary


def benchmark_kindx(mode: str, root: Path, top_k: int) -> dict[str, Any]:
    bench_home = Path(mkdtemp(prefix=f"kindx-bench-{mode}-"))
    env = os.environ.copy()
    cache_home = env.get("KINDX_BENCH_CACHE_HOME") or env.get("XDG_CACHE_HOME") or str(bench_home / "cache")
    env.update({
        "KINDX_CONFIG_DIR": str(bench_home / "config"),
        "XDG_CACHE_HOME": cache_home,
        "INDEX_PATH": str(bench_home / "index.sqlite"),
    })
    Path(env["KINDX_CONFIG_DIR"]).mkdir(parents=True, exist_ok=True)
    Path(env["XDG_CACHE_HOME"]).mkdir(parents=True, exist_ok=True)

    add_start = time.perf_counter()
    run_cmd(["kindx", "collection", "add", str(root / "specs" / "eval-docs"), "--name", "eval-bench"], env)
    if mode == "query":
        run_cmd(["kindx", "embed"], env)
    index_seconds = time.perf_counter() - add_start

    rows: list[dict[str, Any]] = []
    latencies_ms: list[float] = []
    for item in EVAL_QUERIES:
        started = time.perf_counter()
        output = run_cmd(["kindx", mode, item.query, "-c", "eval-bench", "--json", "-n", str(top_k)], env)
        elapsed_ms = (time.perf_counter() - started) * 1000
        latencies_ms.append(elapsed_ms)
        parsed = json.loads(output)
        files = [entry["file"] for entry in parsed]
        row = {
            "query": item.query,
            "difficulty": item.difficulty,
            "expected_doc": item.expected_doc,
            "top_results": files,
            "latency_ms": round(elapsed_ms, 2),
        }
        for k in (1, 3, 5):
            row[f"hit@{k}"] = first_match(files, item.expected_doc, k)
        rows.append(row)

    return {
        "tool": f"kindx-{mode}",
        "index_seconds": round(index_seconds, 3),
        "median_latency_ms": round(statistics.median(latencies_ms), 2),
        "p95_latency_ms": round(np.percentile(latencies_ms, 95), 2),
        "summary": summarize_hits(rows),
        "rows": rows,
    }


def benchmark_lancedb(root: Path, vectorizer: TfidfVectorizer, doc_matrix: np.ndarray, top_k: int) -> dict[str, Any]:
    bench_dir = Path(mkdtemp(prefix="lancedb-bench-"))
    db = lancedb.connect(str(bench_dir))
    docs = load_docs(root / "specs" / "eval-docs")
    dim = int(doc_matrix.shape[1])

    schema = pa.schema([
        pa.field("id", pa.string()),
        pa.field("path", pa.string()),
        pa.field("title", pa.string()),
        pa.field("text", pa.string()),
        pa.field("vector", pa.list_(pa.float32(), dim)),
    ])
    data = [{
        "id": doc["id"],
        "path": doc["path"],
        "title": doc["title"],
        "text": doc["text"],
        "vector": doc_matrix[idx].astype(np.float32).tolist(),
    } for idx, doc in enumerate(docs)]

    started = time.perf_counter()
    table = db.create_table("eval_docs", data=data, schema=schema, mode="overwrite")
    index_seconds = time.perf_counter() - started

    rows: list[dict[str, Any]] = []
    latencies_ms: list[float] = []
    for item in EVAL_QUERIES:
        query_vec = vectorizer.transform([item.query]).toarray()[0].astype(np.float32)
        started = time.perf_counter()
        res = table.search(query_vec).limit(top_k).to_list()
        elapsed_ms = (time.perf_counter() - started) * 1000
        latencies_ms.append(elapsed_ms)
        files = [entry["path"] for entry in res]
        row = {
            "query": item.query,
            "difficulty": item.difficulty,
            "expected_doc": item.expected_doc,
            "top_results": files,
            "latency_ms": round(elapsed_ms, 2),
        }
        for k in (1, 3, 5):
            row[f"hit@{k}"] = first_match(files, item.expected_doc, k)
        rows.append(row)

    return {
        "tool": "lancedb-tfidf",
        "index_seconds": round(index_seconds, 3),
        "median_latency_ms": round(statistics.median(latencies_ms), 2),
        "p95_latency_ms": round(np.percentile(latencies_ms, 95), 2),
        "summary": summarize_hits(rows),
        "rows": rows,
    }


def benchmark_chroma(root: Path, vectorizer: TfidfVectorizer, doc_matrix: np.ndarray, top_k: int) -> dict[str, Any]:
    bench_dir = Path(mkdtemp(prefix="chroma-bench-"))
    client = chromadb.PersistentClient(path=str(bench_dir))
    collection = client.create_collection("eval_docs")
    docs = load_docs(root / "specs" / "eval-docs")

    started = time.perf_counter()
    collection.add(
        ids=[doc["id"] for doc in docs],
        documents=[doc["text"] for doc in docs],
        metadatas=[{"path": doc["path"], "title": doc["title"]} for doc in docs],
        embeddings=[doc_matrix[idx].astype(float).tolist() for idx in range(len(docs))],
    )
    index_seconds = time.perf_counter() - started

    rows: list[dict[str, Any]] = []
    latencies_ms: list[float] = []
    for item in EVAL_QUERIES:
        query_vec = vectorizer.transform([item.query]).toarray()[0].astype(float).tolist()
        started = time.perf_counter()
        res = collection.query(query_embeddings=[query_vec], n_results=top_k)
        elapsed_ms = (time.perf_counter() - started) * 1000
        latencies_ms.append(elapsed_ms)
        metadatas = res.get("metadatas", [[]])[0] or []
        files = [meta["path"] for meta in metadatas]
        row = {
            "query": item.query,
            "difficulty": item.difficulty,
            "expected_doc": item.expected_doc,
            "top_results": files,
            "latency_ms": round(elapsed_ms, 2),
        }
        for k in (1, 3, 5):
            row[f"hit@{k}"] = first_match(files, item.expected_doc, k)
        rows.append(row)

    return {
        "tool": "chroma-tfidf",
        "index_seconds": round(index_seconds, 3),
        "median_latency_ms": round(statistics.median(latencies_ms), 2),
        "p95_latency_ms": round(np.percentile(latencies_ms, 95), 2),
        "summary": summarize_hits(rows),
        "rows": rows,
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    docs = load_docs(root / "specs" / "eval-docs")
    vectorizer = TfidfVectorizer(stop_words="english")
    doc_matrix = vectorizer.fit_transform([doc["text"] for doc in docs]).toarray()

    results = [
        benchmark_kindx("search", root, top_k=5),
        benchmark_kindx("query", root, top_k=5),
        benchmark_lancedb(root, vectorizer, doc_matrix, top_k=5),
        benchmark_chroma(root, vectorizer, doc_matrix, top_k=5),
    ]
    print(json.dumps({"corpus_docs": len(docs), "query_count": len(EVAL_QUERIES), "results": results}, indent=2))


if __name__ == "__main__":
    main()
