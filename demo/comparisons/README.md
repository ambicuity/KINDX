# KINDX Competitor Comparison Framework

A runnable evaluation harness that benchmarks KINDX against 8 local knowledge tools on
retrieval quality, setup friction, and agent integration.

## Quick Start

```bash
# Run all available competitor tests
./run-all.sh

# Run specific tools only
./run-all.sh kindx chromadb lancedb

# Run just KINDX
./run-all.sh kindx
```

## Competitors Tested

| Tool | Test Type | Prerequisites |
|------|-----------|---------------|
| **KINDX** | Bash (CLI) | `npm install -g kindx` |
| **ChromaDB** | Python | `pip install chromadb` |
| **LanceDB** | Python | `pip install lancedb sentence-transformers` |
| **Orama** | TypeScript | `cd competitors/orama && npm install` |
| **Khoj** | Bash (REST API) | Docker or `pip install 'khoj[local]'`, server running |
| **AnythingLLM** | Bash (REST API) | Docker, server running, `ANYTHINGLLM_API_KEY` set |
| **PrivateGPT** | Bash (REST API) | Poetry install, server running |
| **LocalGPT** | Bash (REST API) | Clone + pip + Ollama, server running |
| **GPT4All** | Placeholder | Desktop app (no programmatic retrieval API) |

## Directory Structure

```
demo/comparisons/
├── README.md                          # This file
├── competitor-comparison.md           # Full comparison document (sourced claims)
├── mcp-comparison.md                  # MCP/agent integration deep dive
├── run-all.sh                         # Master orchestrator
├── shared-queries.json                # 18 test queries with expected documents
├── results-template.json              # Standard output format for test results
├── shared-corpus/
│   └── README.md                      # Points to specs/eval-docs/ (6 files)
├── competitors/
│   ├── kindx/
│   │   ├── setup.sh                   # npm install, create collection, embed
│   │   ├── test.sh                    # Tests BM25, vector, hybrid (18 queries × 3 modes)
│   │   └── teardown.sh               # Remove eval-bench collection
│   ├── chromadb/
│   │   ├── setup.sh                   # pip install chromadb
│   │   ├── test.py                    # Python: ephemeral client, vector search
│   │   └── teardown.sh               # Nothing to clean (ephemeral)
│   ├── lancedb/
│   │   ├── setup.sh                   # pip install lancedb sentence-transformers
│   │   ├── test.py                    # Python: BM25 + vector + hybrid
│   │   └── teardown.sh               # Remove /tmp/lancedb-eval
│   ├── orama/
│   │   ├── setup.sh                   # npm install @orama/orama
│   │   ├── test.ts                    # TypeScript: BM25 full-text search
│   │   └── teardown.sh               # Remove node_modules
│   ├── khoj/
│   │   ├── setup.sh                   # Docker compose or pip install
│   │   ├── test.sh                    # REST API: upload + vector search
│   │   └── teardown.sh               # Docker compose down
│   ├── anythingllm/
│   │   ├── setup.sh                   # Docker run
│   │   ├── test.sh                    # REST API: upload + vector search
│   │   └── teardown.sh               # Docker stop
│   ├── privategpt/
│   │   ├── setup.sh                   # Clone + poetry install
│   │   ├── test.sh                    # REST API: ingest + vector search
│   │   └── teardown.sh               # Stop server
│   ├── localgpt/
│   │   ├── setup.sh                   # Clone + pip + Ollama
│   │   ├── test.sh                    # REST API: ingest + hybrid search
│   │   └── teardown.sh               # Stop server
│   └── gpt4all/
│       ├── setup.sh                   # Desktop installer instructions
│       ├── test.sh                    # Placeholder (desktop-only)
│       └── teardown.sh               # Manual close instructions
├── analysis/
│   ├── compare-results.py             # Compare all results, print tables
│   └── generate-report.py            # Generate Markdown report from results
└── results/                           # Created at runtime (gitignored)
    ├── kindx.json
    ├── chromadb.json
    ├── ...
    ├── comparison.md
    └── report.md
```

## Shared Test Corpus

All tests use the same 6 evaluation documents from `specs/eval-docs/`:

| File | Topic |
|------|-------|
| `api-design-principles.md` | REST API design, versioning, HTTP methods |
| `distributed-systems-overview.md` | CAP theorem, consensus, Raft, Paxos |
| `machine-learning-primer.md` | ML basics, overfitting, F1/precision/recall |
| `product-launch-retrospective.md` | Project Phoenix, beta bugs, post-mortem |
| `remote-work-policy.md` | WFH guidelines, VPN, team gatherings |
| `startup-fundraising-memo.md` | Series A, investor pitch, Sequoia |

## Test Queries

18 queries across 3 difficulty levels and 3 types:

- **Easy (6):** Direct keyword matches → tests BM25
- **Medium (6):** Semantic understanding needed → tests vector search
- **Hard (6):** Vague/indirect phrasing → tests hybrid search + ranking quality

See `shared-queries.json` for the full query set with expected documents.

## Results Format

Each test writes a JSON file to `results/` following `results-template.json`:

```json
{
  "tool": "toolname",
  "version": "x.y.z",
  "timestamp": "ISO-8601",
  "setup": {
    "total_setup_steps": 3,
    "install_time_seconds": 10,
    "index_time_seconds": 5,
    "models_downloaded_mb": 50
  },
  "capabilities": {
    "bm25": true,
    "vector": true,
    "hybrid": true,
    ...
  },
  "results": [
    {
      "query_id": 1,
      "mode": "hybrid",
      "latency_ms": 15,
      "top_results": ["file1.md", "file2.md"],
      "hit_at_1": true,
      "hit_at_3": true
    }
  ],
  "aggregate": {
    "hybrid": { "hit_at_1": 0.83, "hit_at_3": 0.94, "mrr": 0.89, "median_latency_ms": 15 }
  }
}
```

## Analysis

After running tests, analysis scripts produce comparison tables:

```bash
# Print comparison tables to stdout
python3 analysis/compare-results.py results/

# Generate Markdown report
python3 analysis/generate-report.py results/ results/report.md
```

The `run-all.sh` orchestrator calls both automatically after tests complete.

## Adding a New Competitor

1. Create `competitors/<name>/` with `setup.sh`, `test.sh` (or `test.py`/`test.ts`), and `teardown.sh`
2. Add prerequisite checks to `run-all.sh` in the `case` block
3. Add the name to `ALL_COMPETITORS` array in `run-all.sh`
4. Ensure the test outputs results in the standard JSON format to `results/<name>.json`

## Documents

- [competitor-comparison.md](./competitor-comparison.md) — Full comparison with sourced claims
- [mcp-comparison.md](./mcp-comparison.md) — MCP/agent integration deep dive
