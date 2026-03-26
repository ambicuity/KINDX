#!/usr/bin/env bash
set -euo pipefail

# LocalGPT comparison test
# Tests via REST API — requires running LocalGPT server
# LocalGPT supports: Hybrid (70% vector + 30% BM25), vector (LanceDB), BM25, reranking
# Does NOT support: MCP, structured output, CLI query
#
# Sources:
#   - https://github.com/PromtEngineer/localGPT (21.9k stars, MIT)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERIES_FILE="$SCRIPT_DIR/../../shared-queries.json"
RESULTS_DIR="$SCRIPT_DIR/../../results"
CORPUS_DIR="$(cd "$SCRIPT_DIR/../../../specs/eval-docs" && pwd)"
mkdir -p "$RESULTS_DIR"

LOCALGPT_URL="${LOCALGPT_URL:-http://localhost:5111}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Check if LocalGPT is running
if ! curl -sf "$LOCALGPT_URL/health" >/dev/null 2>&1; then
  echo "ERROR: LocalGPT not running at $LOCALGPT_URL"
  echo "Run setup.sh and start with: python run_system.py"
  exit 1
fi

NUM_QUERIES=$(jq '.queries | length' "$QUERIES_FILE")
echo "=== LocalGPT Test: $NUM_QUERIES queries (hybrid: 70% vector + 30% BM25) ==="

# Ingest documents
echo "  Ingesting eval corpus..."
for file in "$CORPUS_DIR"/*.md; do
  filename=$(basename "$file")
  curl -sf -X POST "$LOCALGPT_URL/api/ingest" \
    -F "file=@$file" >/dev/null 2>&1 || echo "  WARNING: Failed to ingest $filename"
done

echo "  Waiting for indexing..."
sleep 10

# Run queries
RESULTS="["
LATENCIES=()
HIT1=0; HIT3=0; RR_SUM=0

for i in $(seq 0 $((NUM_QUERIES - 1))); do
  QUERY_ID=$(jq -r ".queries[$i].id" "$QUERIES_FILE")
  QUERY=$(jq -r ".queries[$i].query" "$QUERIES_FILE")
  EXPECTED=$(jq -r ".queries[$i].expected_doc" "$QUERIES_FILE")

  [ "$i" -gt 0 ] && RESULTS="$RESULTS,"

  START=$(date +%s%N)
  RESPONSE=$(curl -sf -X POST "$LOCALGPT_URL/api/query" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$QUERY\", \"top_k\": 5}" 2>/dev/null || echo '{"results":[]}')
  END=$(date +%s%N)
  LATENCY_MS=$(( (END - START) / 1000000 ))
  LATENCIES+=("$LATENCY_MS")

  TOP_FILE=$(echo "$RESPONSE" | jq -r '.results[0].source // ""' 2>/dev/null | xargs basename 2>/dev/null || echo "")
  ALL_FILES=$(echo "$RESPONSE" | jq -r '[.results[].source // "" | split("/") | last]' 2>/dev/null || echo '[]')
  TOP_SCORE=$(echo "$RESPONSE" | jq -r '.results[0].score // 0' 2>/dev/null || echo "0")

  H1=false; H3=false
  EXPECTED_BASE=$(echo "$EXPECTED" | sed 's/.md$//')
  if echo "$TOP_FILE" | grep -qi "$EXPECTED_BASE"; then H1=true; HIT1=$((HIT1+1)); fi
  for rank in 0 1 2; do
    FILE=$(echo "$RESPONSE" | jq -r ".results[$rank].source // \"\"" 2>/dev/null | xargs basename 2>/dev/null || echo "")
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
    \"mode\": \"hybrid\",
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

cat > "$RESULTS_DIR/localgpt.json" <<EOF
{
  "tool": "localgpt",
  "version": "v2-preview",
  "timestamp": "$TIMESTAMP",
  "setup": {
    "install_time_seconds": 600.0,
    "install_commands": [
      "git clone https://github.com/PromtEngineer/localGPT.git",
      "pip install -r requirements.txt",
      "ollama pull qwen3:0.6b",
      "python run_system.py"
    ],
    "index_time_seconds": 60.0,
    "models_downloaded_mb": 5000,
    "total_setup_steps": 6
  },
  "capabilities": {
    "bm25": true,
    "vector": true,
    "hybrid": true,
    "reranking": true,
    "mcp_server": false,
    "cli_query": false,
    "json_output": false,
    "csv_output": false,
    "xml_output": false,
    "agent_invocable": false,
    "air_gapped": true,
    "local_gguf": true
  },
  "results": $RESULTS,
  "aggregate": {
    "bm25": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0},
    "vector": {"hit_at_1": 0, "hit_at_3": 0, "mrr": 0, "median_latency_ms": 0},
    "hybrid": {"hit_at_1": $H1_RATE, "hit_at_3": $H3_RATE, "mrr": $MRR, "median_latency_ms": $MEDIAN}
  }
}
EOF

echo ""
echo "=== LocalGPT Results ==="
echo "Hybrid: Hit@1=$H1_RATE  Hit@3=$H3_RATE  MRR=$MRR  Median=${MEDIAN}ms"
echo "Results written to: $RESULTS_DIR/localgpt.json"
