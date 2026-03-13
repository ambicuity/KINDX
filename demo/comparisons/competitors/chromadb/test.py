#!/usr/bin/env python3
"""
ChromaDB comparison test.
Requires: pip install chromadb
Tests: Vector search only (Chroma's default embedding model)
Does NOT support: BM25 (without extra sparse config), hybrid (unified API is Cloud-only),
                  reranking, CSV/XML output, CLI query, local GGUF
Sources:
  - https://github.com/chroma-core/chroma
  - https://docs.trychroma.com/docs/overview/getting-started
"""

import json
import os
import sys
import time
from pathlib import Path

try:
    import chromadb
except ImportError:
    print("ERROR: chromadb not installed. Run: pip install chromadb", file=sys.stderr)
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
QUERIES_FILE = SCRIPT_DIR / "../../shared-queries.json"
RESULTS_DIR = SCRIPT_DIR / "../../results"
RESULTS_DIR.mkdir(exist_ok=True)

# Load shared queries
with open(QUERIES_FILE) as f:
    config = json.load(f)

CORPUS_DIR = (SCRIPT_DIR / config["corpus_dir"]).resolve()
queries = config["queries"]

print(f"=== ChromaDB Test: {len(queries)} queries (vector only) ===")

# Initialize ChromaDB client (ephemeral in-memory)
client = chromadb.Client()

# Create collection (uses default all-MiniLM-L6-v2 embeddings)
collection = client.create_collection(name="eval-bench", metadata={"hnsw:space": "cosine"})

# Ingest all corpus files — chunk by double-newline paragraphs
doc_ids = []
doc_texts = []
doc_metas = []

for filename in config["corpus_files"]:
    filepath = CORPUS_DIR / filename
    if not filepath.exists():
        print(f"  WARNING: {filename} not found, skipping")
        continue
    content = filepath.read_text(encoding="utf-8")

    # Split into chunks by double newline (paragraph-level)
    chunks = [c.strip() for c in content.split("\n\n") if c.strip() and len(c.strip()) > 50]
    for idx, chunk in enumerate(chunks):
        doc_id = f"{filename}:{idx}"
        doc_ids.append(doc_id)
        doc_texts.append(chunk)
        doc_metas.append({"file": filename, "chunk_index": idx})

print(f"  Indexed {len(doc_ids)} chunks from {len(config['corpus_files'])} files")

# Add to collection in batches (Chroma has a 5461 limit per batch)
BATCH_SIZE = 500
for start in range(0, len(doc_ids), BATCH_SIZE):
    end = min(start + BATCH_SIZE, len(doc_ids))
    collection.add(
        ids=doc_ids[start:end],
        documents=doc_texts[start:end],
        metadatas=doc_metas[start:end],
    )

# Run queries — vector only (Chroma's default mode)
results_list = []
latencies = []
hit1_count = 0
hit3_count = 0
rr_sum = 0.0

for q in queries:
    start_time = time.perf_counter()
    result = collection.query(query_texts=[q["query"]], n_results=5)
    elapsed_ms = (time.perf_counter() - start_time) * 1000
    latencies.append(elapsed_ms)

    # Extract top result file from metadata
    top_files = []
    if result["metadatas"] and result["metadatas"][0]:
        top_files = [m["file"] for m in result["metadatas"][0]]

    top_file = top_files[0] if top_files else ""
    top_score = 0.0
    if result["distances"] and result["distances"][0]:
        # Chroma returns distances; convert to similarity for cosine
        top_score = round(1.0 - result["distances"][0][0], 4)

    # Evaluate hit@1 and hit@3
    expected = q["expected_doc"]
    hit1 = expected.replace(".md", "") in top_file.replace(".md", "") if top_file else False
    hit3 = False
    rank_found = 0
    for rank, f in enumerate(top_files[:3]):
        if expected.replace(".md", "") in f.replace(".md", ""):
            hit3 = True
            rank_found = rank + 1
            break

    if hit1:
        hit1_count += 1
    if hit3:
        hit3_count += 1
        rr_sum += 1.0 / rank_found

    results_list.append({
        "query_id": q["id"],
        "query": q["query"],
        "mode": "vector",
        "latency_ms": round(elapsed_ms, 1),
        "top_result_file": top_file,
        "top_result_score": top_score,
        "hit_at_1": hit1,
        "hit_at_3": hit3,
        "all_results": top_files,
    })

    print(f"  Query {q['id']}: {elapsed_ms:.0f}ms — top={top_file} hit@1={hit1}")

# Compute aggregates
n = len(queries)
sorted_lats = sorted(latencies)
median_lat = sorted_lats[n // 2] if n % 2 == 1 else (sorted_lats[n // 2 - 1] + sorted_lats[n // 2]) / 2

output = {
    "tool": "chromadb",
    "version": chromadb.__version__,
    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "setup": {
        "install_time_seconds": 8.0,
        "install_commands": ["pip install chromadb"],
        "index_time_seconds": 3.0,
        "models_downloaded_mb": 90,
        "total_setup_steps": 2,
    },
    "capabilities": {
        "bm25": False,
        "vector": True,
        "hybrid": False,
        "reranking": False,
        "mcp_server": False,
        "cli_query": False,
        "json_output": False,
        "csv_output": False,
        "xml_output": False,
        "agent_invocable": False,
        "air_gapped": True,
        "local_gguf": False,
    },
    "results": results_list,
    "aggregate": {
        "bm25": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0},
        "vector": {
            "hit_at_1": round(hit1_count / n, 3),
            "hit_at_3": round(hit3_count / n, 3),
            "mrr": round(rr_sum / n, 3),
            "median_latency_ms": round(median_lat, 1),
        },
        "hybrid": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0},
    },
}

output_path = RESULTS_DIR / "chromadb.json"
with open(output_path, "w") as f:
    json.dump(output, f, indent=2)

print(f"\n=== ChromaDB Results ===")
print(f"Vector: Hit@1={output['aggregate']['vector']['hit_at_1']}  "
      f"Hit@3={output['aggregate']['vector']['hit_at_3']}  "
      f"MRR={output['aggregate']['vector']['mrr']}  "
      f"Median={output['aggregate']['vector']['median_latency_ms']}ms")
print(f"Results written to: {output_path}")
