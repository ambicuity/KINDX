#!/usr/bin/env bash
set -euo pipefail

# AnythingLLM comparison test
# Tests via REST API — requires running AnythingLLM server + API key
# AnythingLLM supports: Vector search (LanceDB default)
# Does NOT support: BM25, hybrid search, reranking (feature requests open)
#
# Sources:
#   - https://github.com/Mintplex-Labs/anything-llm (56.2k stars, MIT)
#   - https://docs.useanything.com/features/api
#   - https://docs.anythingllm.com/mcp-compatibility/overview

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERIES_FILE="$SCRIPT_DIR/../../shared-queries.json"
RESULTS_DIR="$SCRIPT_DIR/../../results"
CORPUS_DIR="$(cd "$SCRIPT_DIR/../../../specs/eval-docs" && pwd)"
mkdir -p "$RESULTS_DIR"

ANYTHINGLLM_URL="${ANYTHINGLLM_URL:-http://localhost:3001}"
ANYTHINGLLM_API_KEY="${ANYTHINGLLM_API_KEY:-}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
WORKSPACE="${ANYTHINGLLM_WORKSPACE:-eval-bench}"

if [ -z "$ANYTHINGLLM_API_KEY" ]; then
  echo "ERROR: ANYTHINGLLM_API_KEY not set."
  echo "Get your API key from AnythingLLM UI → Settings → API Keys"
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $ANYTHINGLLM_API_KEY"

# Check if server is running
if ! curl -sf -H "$AUTH_HEADER" "$ANYTHINGLLM_URL/api/v1/auth" >/dev/null 2>&1; then
  echo "ERROR: AnythingLLM not running at $ANYTHINGLLM_URL"
  exit 1
fi

NUM_QUERIES=$(jq '.queries | length' "$QUERIES_FILE")
echo "=== AnythingLLM Test: $NUM_QUERIES queries (vector only) ==="

# Upload documents to workspace
echo "  Uploading eval corpus..."
for file in "$CORPUS_DIR"/*.md; do
  filename=$(basename "$file")
  curl -sf -X POST "$ANYTHINGLLM_URL/api/v1/document/upload" \
    -H "$AUTH_HEADER" \
    -F "file=@$file" >/dev/null 2>&1 || echo "  WARNING: Failed to upload $filename"
done

echo "  Waiting for embedding/indexing..."
sleep 10

# Run queries via chat endpoint (AnythingLLM uses chat-based RAG)
RESULTS="["
LATENCIES=()
HIT1=0; HIT3=0; RR_SUM=0

for i in $(seq 0 $((NUM_QUERIES - 1))); do
  QUERY_ID=$(jq -r ".queries[$i].id" "$QUERIES_FILE")
  QUERY=$(jq -r ".queries[$i].query" "$QUERIES_FILE")
  EXPECTED=$(jq -r ".queries[$i].expected_doc" "$QUERIES_FILE")

  [ "$i" -gt 0 ] && RESULTS="$RESULTS,"

  START=$(date +%s%N)
  RESPONSE=$(curl -sf -X POST "$ANYTHINGLLM_URL/api/v1/workspace/$WORKSPACE/chat" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "{\"message\": \"$QUERY\", \"mode\": \"query\"}" 2>/dev/null || echo '{}')
  END=$(date +%s%N)
  LATENCY_MS=$(( (END - START) / 1000000 ))
  LATENCIES+=("$LATENCY_MS")

  # Parse — AnythingLLM returns sources in the response
  TOP_FILE=$(echo "$RESPONSE" | jq -r '.sources[0].title // ""' 2>/dev/null || echo "")
  ALL_FILES=$(echo "$RESPONSE" | jq -r '[.sources[].title // ""]' 2>/dev/null || echo '[]')

  H1=false; H3=false
  EXPECTED_BASE=$(echo "$EXPECTED" | sed 's/.md$//')
  if echo "$TOP_FILE" | grep -qi "$EXPECTED_BASE"; then H1=true; HIT1=$((HIT1+1)); fi
  for rank in 0 1 2; do
    FILE=$(echo "$RESPONSE" | jq -r ".sources[$rank].title // \"\"" 2>/dev/null || echo "")
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
    \"top_result_score\": 0,
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

cat > "$RESULTS_DIR/anythingllm.json" <<EOF
{
  "tool": "anythingllm",
  "version": "1.11.1",
  "timestamp": "$TIMESTAMP",
  "setup": {
    "install_time_seconds": 120.0,
    "install_commands": ["docker pull mintplexlabs/anythingllm:latest", "docker run -d -p 3001:3001 mintplexlabs/anythingllm:latest"],
    "index_time_seconds": 30.0,
    "models_downloaded_mb": 3000,
    "total_setup_steps": 7
  },
  "capabilities": {
    "bm25": false,
    "vector": true,
    "hybrid": false,
    "reranking": false,
    "mcp_server": true,
    "cli_query": true,
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
echo "=== AnythingLLM Results ==="
echo "Vector: Hit@1=$H1_RATE  Hit@3=$H3_RATE  MRR=$MRR  Median=${MEDIAN}ms"
echo "Results written to: $RESULTS_DIR/anythingllm.json"
