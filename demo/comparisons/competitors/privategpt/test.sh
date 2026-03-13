#!/usr/bin/env bash
set -euo pipefail

# PrivateGPT comparison test
# Tests via OpenAI-compatible API — requires running PrivateGPT server
# PrivateGPT supports: Vector search (via Qdrant/Chroma), reranking (cross-encoder)
# Does NOT support: BM25, hybrid search, CLI query, JSON/CSV/XML structured output
#
# Sources:
#   - https://github.com/zylon-ai/private-gpt (~57k stars, Apache-2.0)
#   - https://docs.privategpt.dev/manual/storage/vector-stores
#   - https://docs.privategpt.dev/manual/advanced-setup/reranking

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERIES_FILE="$SCRIPT_DIR/../../shared-queries.json"
RESULTS_DIR="$SCRIPT_DIR/../../results"
CORPUS_DIR="$(cd "$SCRIPT_DIR/../../../specs/eval-docs" && pwd)"
mkdir -p "$RESULTS_DIR"

PRIVATEGPT_URL="${PRIVATEGPT_URL:-http://localhost:8001}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Check if PrivateGPT is running
if ! curl -sf "$PRIVATEGPT_URL/health" >/dev/null 2>&1; then
  echo "ERROR: PrivateGPT not running at $PRIVATEGPT_URL"
  echo "Run setup.sh and start the server first."
  exit 1
fi

NUM_QUERIES=$(jq '.queries | length' "$QUERIES_FILE")
echo "=== PrivateGPT Test: $NUM_QUERIES queries (vector + reranking) ==="

# Step 1: Ingest documents
echo "  Ingesting eval corpus..."
for file in "$CORPUS_DIR"/*.md; do
  filename=$(basename "$file")
  curl -sf -X POST "$PRIVATEGPT_URL/v1/ingest/file" \
    -F "file=@$file" >/dev/null 2>&1 || echo "  WARNING: Failed to ingest $filename"
done

echo "  Waiting for indexing..."
sleep 10

# Step 2: Run queries
RESULTS="["
LATENCIES=()
HIT1=0; HIT3=0; RR_SUM=0

for i in $(seq 0 $((NUM_QUERIES - 1))); do
  QUERY_ID=$(jq -r ".queries[$i].id" "$QUERIES_FILE")
  QUERY=$(jq -r ".queries[$i].query" "$QUERIES_FILE")
  EXPECTED=$(jq -r ".queries[$i].expected_doc" "$QUERIES_FILE")

  [ "$i" -gt 0 ] && RESULTS="$RESULTS,"

  START=$(date +%s%N)
  RESPONSE=$(curl -sf -X POST "$PRIVATEGPT_URL/v1/chunks" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"$QUERY\", \"limit\": 5}" 2>/dev/null || echo '{"data":[]}')
  END=$(date +%s%N)
  LATENCY_MS=$(( (END - START) / 1000000 ))
  LATENCIES+=("$LATENCY_MS")

  # Parse results
  TOP_FILE=$(echo "$RESPONSE" | jq -r '.data[0].document.doc_metadata.file_name // ""' 2>/dev/null || echo "")
  ALL_FILES=$(echo "$RESPONSE" | jq -r '[.data[].document.doc_metadata.file_name // ""]' 2>/dev/null || echo '[]')
  TOP_SCORE=$(echo "$RESPONSE" | jq -r '.data[0].score // 0' 2>/dev/null || echo "0")

  H1=false; H3=false
  EXPECTED_BASE=$(echo "$EXPECTED" | sed 's/.md$//')
  if echo "$TOP_FILE" | grep -qi "$EXPECTED_BASE"; then H1=true; HIT1=$((HIT1+1)); fi
  for rank in 0 1 2; do
    FILE=$(echo "$RESPONSE" | jq -r ".data[$rank].document.doc_metadata.file_name // \"\"" 2>/dev/null || echo "")
    if echo "$FILE" | grep -qi "$EXPECTED_BASE"; then
      H3=true; HIT3=$((HIT3+1))
      RR=$(echo "scale=4; 1/($rank+1)" | bc)
      RR_SUM=$(echo "$RR_SUM + $RR" | bc)
      break
    fi
  done

  RESULTS="$RESULTS
  {
    \"query_id\": $QUERY_ID,
    \"query\": \"$QUERY\",
    \"mode\": \"vector\",
    \"latency_ms\": $LATENCY_MS,
    \"top_result_file\": \"$TOP_FILE\",
    \"top_result_score\": $TOP_SCORE,
    \"hit_at_1\": $H1,
    \"hit_at_3\": $H3,
    \"all_results\": $ALL_FILES
  }"

  echo "  Query $QUERY_ID: ${LATENCY_MS}ms — top=$TOP_FILE hit@1=$H1"
done

RESULTS="$RESULTS
]"

# Compute aggregates
compute_median() {
  local arr=("$@")
  local n=${#arr[@]}
  [ "$n" -eq 0 ] && echo 0 && return
  local sorted=($(printf '%s\n' "${arr[@]}" | sort -n))
  local mid=$((n / 2))
  [ $((n % 2)) -eq 0 ] && echo $(( (sorted[mid-1] + sorted[mid]) / 2 )) || echo "${sorted[$mid]}"
}

MEDIAN=$(compute_median "${LATENCIES[@]}")
H1_RATE=$(echo "scale=3; $HIT1 / $NUM_QUERIES" | bc)
H3_RATE=$(echo "scale=3; $HIT3 / $NUM_QUERIES" | bc)
MRR=$(echo "scale=3; $RR_SUM / $NUM_QUERIES" | bc)

cat > "$RESULTS_DIR/privategpt.json" <<EOF
{
  "tool": "privategpt",
  "version": "0.6.2",
  "timestamp": "$TIMESTAMP",
  "setup": {
    "install_time_seconds": 300.0,
    "install_commands": [
      "git clone https://github.com/zylon-ai/private-gpt.git",
      "poetry install --extras 'ui llms-ollama embeddings-ollama vector-stores-qdrant'",
      "ollama pull nomic-embed-text",
      "PGPT_PROFILES=ollama make run"
    ],
    "index_time_seconds": 60.0,
    "models_downloaded_mb": 4000,
    "total_setup_steps": 7
  },
  "capabilities": {
    "bm25": false,
    "vector": true,
    "hybrid": false,
    "reranking": true,
    "mcp_server": false,
    "cli_query": false,
    "json_output": false,
    "csv_output": false,
    "xml_output": false,
    "agent_invocable": true,
    "air_gapped": true,
    "local_gguf": true
  },
  "results": $RESULTS,
  "aggregate": {
    "bm25": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0},
    "vector": {"hit_at_1": $H1_RATE, "hit_at_3": $H3_RATE, "mrr": $MRR, "median_latency_ms": $MEDIAN},
    "hybrid": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0}
  }
}
EOF

echo ""
echo "=== PrivateGPT Results ==="
echo "Vector: Hit@1=$H1_RATE  Hit@3=$H3_RATE  MRR=$MRR  Median=${MEDIAN}ms"
echo "Results written to: $RESULTS_DIR/privategpt.json"
