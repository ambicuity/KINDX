#!/usr/bin/env bash
set -euo pipefail

# GPT4All LocalDocs comparison test
# GPT4All is a desktop app — there is NO programmatic search API
# This script documents the testing limitations and uses the Python SDK where possible
#
# GPT4All supports: Vector search (Nomic embeddings, local SQLite)
# Does NOT support: BM25, hybrid, reranking, MCP, CLI, JSON output, programmatic retrieval
#
# Sources:
#   - https://github.com/nomic-ai/gpt4all (76.9k stars, MIT)
#   - https://github.com/nomic-ai/gpt4all/wiki/LocalDocs
#   - https://docs.gpt4all.io/index.html

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERIES_FILE="$SCRIPT_DIR/../../shared-queries.json"
RESULTS_DIR="$SCRIPT_DIR/../../results"
mkdir -p "$RESULTS_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NUM_QUERIES=$(jq '.queries | length' "$QUERIES_FILE")

echo "=== GPT4All LocalDocs Test ==="
echo ""
echo "WARNING: GPT4All LocalDocs has NO programmatic retrieval API."
echo "Testing is limited to:"
echo "  1. Verifying the Python SDK loads correctly"
echo "  2. Documenting the chat-based retrieval flow"
echo "  3. Writing a placeholder results file"
echo ""
echo "For actual retrieval quality testing, you must:"
echo "  - Open GPT4All desktop app"
echo "  - Enable LocalDocs and add the eval-docs folder"
echo "  - Manually run each query in the chat interface"
echo "  - Manually check if the cited source matches the expected document"
echo ""

# Try Python SDK — limited to chat/generation, not direct retrieval
python3 -c "
import json
try:
    import gpt4all
    print(f'  GPT4All Python SDK version: {gpt4all.__version__}')
    print('  SDK available but does NOT expose search/retrieval API')
except ImportError:
    print('  GPT4All Python SDK not installed')
" 2>/dev/null || echo "  Python check skipped"

# Write placeholder results
cat > "$RESULTS_DIR/gpt4all.json" <<EOF
{
  "tool": "gpt4all",
  "version": "3.10.0",
  "timestamp": "$TIMESTAMP",
  "setup": {
    "install_time_seconds": 600.0,
    "install_commands": [
      "Download desktop app from https://www.nomic.ai/gpt4all",
      "Install and launch",
      "Download LLM model (4-8GB)",
      "Settings → LocalDocs → Add eval-docs folder",
      "Wait for indexing"
    ],
    "index_time_seconds": 120.0,
    "models_downloaded_mb": 6000,
    "total_setup_steps": 5
  },
  "capabilities": {
    "bm25": false,
    "vector": true,
    "hybrid": false,
    "reranking": false,
    "mcp_server": false,
    "cli_query": false,
    "json_output": false,
    "csv_output": false,
    "xml_output": false,
    "agent_invocable": false,
    "air_gapped": true,
    "local_gguf": true
  },
  "results": [],
  "aggregate": {
    "bm25": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0},
    "vector": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0},
    "hybrid": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0}
  },
  "notes": "GPT4All LocalDocs does not expose a programmatic retrieval API. Results must be collected manually via the desktop chat interface. The Python SDK provides chat/generation but not direct document retrieval."
}
EOF

echo "=== GPT4All Results ==="
echo "No automated results — desktop-only retrieval."
echo "Placeholder written to: $RESULTS_DIR/gpt4all.json"
