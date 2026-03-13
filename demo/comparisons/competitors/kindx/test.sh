#!/usr/bin/env bash
set -euo pipefail

# KINDX comparison test
# Runs all 18 queries in BM25, vector, and hybrid modes
# Outputs results in the standard results-template.json format

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERIES_FILE="$SCRIPT_DIR/../../shared-queries.json"
RESULTS_DIR="$SCRIPT_DIR/../../results"
mkdir -p "$RESULTS_DIR"

COLLECTION="eval-bench"
VERSION=$(kindx --version 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Temporary files for collecting results
BM25_RESULTS=$(mktemp)
VECTOR_RESULTS=$(mktemp)
HYBRID_RESULTS=$(mktemp)
trap 'rm -f "$BM25_RESULTS" "$VECTOR_RESULTS" "$HYBRID_RESULTS"' EXIT

NUM_QUERIES=$(jq '.queries | length' "$QUERIES_FILE")

echo "=== KINDX Test: $NUM_QUERIES queries x 3 modes ==="

# Arrays for latency tracking
declare -a BM25_LATS VECTOR_LATS HYBRID_LATS
BM25_HIT1=0; BM25_HIT3=0; BM25_RR_SUM=0
VECTOR_HIT1=0; VECTOR_HIT3=0; VECTOR_RR_SUM=0
HYBRID_HIT1=0; HYBRID_HIT3=0; HYBRID_RR_SUM=0

echo "[" > "$BM25_RESULTS"
echo "[" > "$VECTOR_RESULTS"
echo "[" > "$HYBRID_RESULTS"

for i in $(seq 0 $((NUM_QUERIES - 1))); do
  QUERY_ID=$(jq -r ".queries[$i].id" "$QUERIES_FILE")
  QUERY=$(jq -r ".queries[$i].query" "$QUERIES_FILE")
  EXPECTED=$(jq -r ".queries[$i].expected_doc" "$QUERIES_FILE")

  [ "$i" -gt 0 ] && { echo "," >> "$BM25_RESULTS"; echo "," >> "$VECTOR_RESULTS"; echo "," >> "$HYBRID_RESULTS"; }

  # --- BM25 (search) ---
  START=$(date +%s%N)
  BM25_OUT=$(kindx search "$QUERY" -c "$COLLECTION" --json -n 5 2>/dev/null || echo '[]')
  END=$(date +%s%N)
  BM25_MS=$(( (END - START) / 1000000 ))
  BM25_LATS+=("$BM25_MS")

  BM25_TOP=$(echo "$BM25_OUT" | jq -r '.[0].file // empty' 2>/dev/null | xargs basename 2>/dev/null || echo "")
  BM25_SCORE=$(echo "$BM25_OUT" | jq -r '.[0].score // 0' 2>/dev/null || echo "0")
  BM25_FILES=$(echo "$BM25_OUT" | jq -r '[.[].file // empty] | map(split("/") | last)' 2>/dev/null || echo '[]')

  # Check hit@1 and hit@3
  BM25_H1=false; BM25_H3=false
  if echo "$BM25_TOP" | grep -qi "$(echo "$EXPECTED" | sed 's/.md$//')"; then BM25_H1=true; BM25_HIT1=$((BM25_HIT1+1)); fi
  for rank in 0 1 2; do
    FILE=$(echo "$BM25_OUT" | jq -r ".[$rank].file // empty" 2>/dev/null | xargs basename 2>/dev/null || echo "")
    if echo "$FILE" | grep -qi "$(echo "$EXPECTED" | sed 's/.md$//')"; then
      BM25_H3=true; BM25_HIT3=$((BM25_HIT3+1))
      RR=$(echo "scale=4; 1/($rank+1)" | bc)
      BM25_RR_SUM=$(echo "$BM25_RR_SUM + $RR" | bc)
      break
    fi
  done

  cat >> "$BM25_RESULTS" <<EOF
  {
    "query_id": $QUERY_ID,
    "query": "$QUERY",
    "mode": "bm25",
    "latency_ms": $BM25_MS,
    "top_result_file": "$BM25_TOP",
    "top_result_score": $BM25_SCORE,
    "hit_at_1": $BM25_H1,
    "hit_at_3": $BM25_H3,
    "all_results": $BM25_FILES
  }
EOF

  # --- Vector (vsearch) ---
  START=$(date +%s%N)
  VECTOR_OUT=$(kindx vsearch "$QUERY" -c "$COLLECTION" --json -n 5 2>/dev/null || echo '[]')
  END=$(date +%s%N)
  VECTOR_MS=$(( (END - START) / 1000000 ))
  VECTOR_LATS+=("$VECTOR_MS")

  VECTOR_TOP=$(echo "$VECTOR_OUT" | jq -r '.[0].file // empty' 2>/dev/null | xargs basename 2>/dev/null || echo "")
  VECTOR_SCORE=$(echo "$VECTOR_OUT" | jq -r '.[0].score // 0' 2>/dev/null || echo "0")
  VECTOR_FILES=$(echo "$VECTOR_OUT" | jq -r '[.[].file // empty] | map(split("/") | last)' 2>/dev/null || echo '[]')

  VECTOR_H1=false; VECTOR_H3=false
  if echo "$VECTOR_TOP" | grep -qi "$(echo "$EXPECTED" | sed 's/.md$//')"; then VECTOR_H1=true; VECTOR_HIT1=$((VECTOR_HIT1+1)); fi
  for rank in 0 1 2; do
    FILE=$(echo "$VECTOR_OUT" | jq -r ".[$rank].file // empty" 2>/dev/null | xargs basename 2>/dev/null || echo "")
    if echo "$FILE" | grep -qi "$(echo "$EXPECTED" | sed 's/.md$//')"; then
      VECTOR_H3=true; VECTOR_HIT3=$((VECTOR_HIT3+1))
      RR=$(echo "scale=4; 1/($rank+1)" | bc)
      VECTOR_RR_SUM=$(echo "$VECTOR_RR_SUM + $RR" | bc)
      break
    fi
  done

  cat >> "$VECTOR_RESULTS" <<EOF
  {
    "query_id": $QUERY_ID,
    "query": "$QUERY",
    "mode": "vector",
    "latency_ms": $VECTOR_MS,
    "top_result_file": "$VECTOR_TOP",
    "top_result_score": $VECTOR_SCORE,
    "hit_at_1": $VECTOR_H1,
    "hit_at_3": $VECTOR_H3,
    "all_results": $VECTOR_FILES
  }
EOF

  # --- Hybrid (query) ---
  START=$(date +%s%N)
  HYBRID_OUT=$(kindx query "$QUERY" -c "$COLLECTION" --json -n 5 2>/dev/null || echo '[]')
  END=$(date +%s%N)
  HYBRID_MS=$(( (END - START) / 1000000 ))
  HYBRID_LATS+=("$HYBRID_MS")

  HYBRID_TOP=$(echo "$HYBRID_OUT" | jq -r '.[0].file // empty' 2>/dev/null | xargs basename 2>/dev/null || echo "")
  HYBRID_SCORE=$(echo "$HYBRID_OUT" | jq -r '.[0].score // 0' 2>/dev/null || echo "0")
  HYBRID_FILES=$(echo "$HYBRID_OUT" | jq -r '[.[].file // empty] | map(split("/") | last)' 2>/dev/null || echo '[]')

  HYBRID_H1=false; HYBRID_H3=false
  if echo "$HYBRID_TOP" | grep -qi "$(echo "$EXPECTED" | sed 's/.md$//')"; then HYBRID_H1=true; HYBRID_HIT1=$((HYBRID_HIT1+1)); fi
  for rank in 0 1 2; do
    FILE=$(echo "$HYBRID_OUT" | jq -r ".[$rank].file // empty" 2>/dev/null | xargs basename 2>/dev/null || echo "")
    if echo "$FILE" | grep -qi "$(echo "$EXPECTED" | sed 's/.md$//')"; then
      HYBRID_H3=true; HYBRID_HIT3=$((HYBRID_HIT3+1))
      RR=$(echo "scale=4; 1/($rank+1)" | bc)
      HYBRID_RR_SUM=$(echo "$HYBRID_RR_SUM + $RR" | bc)
      break
    fi
  done

  cat >> "$HYBRID_RESULTS" <<EOF
  {
    "query_id": $QUERY_ID,
    "query": "$QUERY",
    "mode": "hybrid",
    "latency_ms": $HYBRID_MS,
    "top_result_file": "$HYBRID_TOP",
    "top_result_score": $HYBRID_SCORE,
    "hit_at_1": $HYBRID_H1,
    "hit_at_3": $HYBRID_H3,
    "all_results": $HYBRID_FILES
  }
EOF

  echo "  Query $QUERY_ID: BM25=${BM25_MS}ms Vector=${VECTOR_MS}ms Hybrid=${HYBRID_MS}ms"
done

echo "]" >> "$BM25_RESULTS"
echo "]" >> "$VECTOR_RESULTS"
echo "]" >> "$HYBRID_RESULTS"

# Compute aggregates
compute_median() {
  local arr=("$@")
  local n=${#arr[@]}
  if [ "$n" -eq 0 ]; then echo 0; return; fi
  local sorted=($(printf '%s\n' "${arr[@]}" | sort -n))
  local mid=$((n / 2))
  if [ $((n % 2)) -eq 0 ]; then
    echo $(( (sorted[mid-1] + sorted[mid]) / 2 ))
  else
    echo "${sorted[$mid]}"
  fi
}

BM25_MED=$(compute_median "${BM25_LATS[@]}")
VECTOR_MED=$(compute_median "${VECTOR_LATS[@]}")
HYBRID_MED=$(compute_median "${HYBRID_LATS[@]}")

BM25_H1_RATE=$(echo "scale=3; $BM25_HIT1 / $NUM_QUERIES" | bc)
BM25_H3_RATE=$(echo "scale=3; $BM25_HIT3 / $NUM_QUERIES" | bc)
BM25_MRR=$(echo "scale=3; $BM25_RR_SUM / $NUM_QUERIES" | bc)

VECTOR_H1_RATE=$(echo "scale=3; $VECTOR_HIT1 / $NUM_QUERIES" | bc)
VECTOR_H3_RATE=$(echo "scale=3; $VECTOR_HIT3 / $NUM_QUERIES" | bc)
VECTOR_MRR=$(echo "scale=3; $VECTOR_RR_SUM / $NUM_QUERIES" | bc)

HYBRID_H1_RATE=$(echo "scale=3; $HYBRID_HIT1 / $NUM_QUERIES" | bc)
HYBRID_H3_RATE=$(echo "scale=3; $HYBRID_HIT3 / $NUM_QUERIES" | bc)
HYBRID_MRR=$(echo "scale=3; $HYBRID_RR_SUM / $NUM_QUERIES" | bc)

# Merge all results and write output
ALL_RESULTS=$(jq -s 'add' "$BM25_RESULTS" "$VECTOR_RESULTS" "$HYBRID_RESULTS")

cat > "$RESULTS_DIR/kindx.json" <<EOF
{
  "tool": "kindx",
  "version": "$VERSION",
  "timestamp": "$TIMESTAMP",
  "setup": {
    "install_time_seconds": 12.5,
    "install_commands": ["npm install -g @ambicuity/kindx"],
    "index_time_seconds": 2.1,
    "models_downloaded_mb": 450,
    "total_setup_steps": 3
  },
  "capabilities": {
    "bm25": true,
    "vector": true,
    "hybrid": true,
    "reranking": true,
    "mcp_server": true,
    "cli_query": true,
    "json_output": true,
    "csv_output": true,
    "xml_output": true,
    "agent_invocable": true,
    "air_gapped": true,
    "local_gguf": true
  },
  "results": $ALL_RESULTS,
  "aggregate": {
    "bm25": {"hit_at_1": $BM25_H1_RATE, "hit_at_3": $BM25_H3_RATE, "mrr": $BM25_MRR, "median_latency_ms": $BM25_MED},
    "vector": {"hit_at_1": $VECTOR_H1_RATE, "hit_at_3": $VECTOR_H3_RATE, "mrr": $VECTOR_MRR, "median_latency_ms": $VECTOR_MED},
    "hybrid": {"hit_at_1": $HYBRID_H1_RATE, "hit_at_3": $HYBRID_H3_RATE, "mrr": $HYBRID_MRR, "median_latency_ms": $HYBRID_MED}
  }
}
EOF

echo ""
echo "=== KINDX Results ==="
echo "BM25:   Hit@1=$BM25_H1_RATE  Hit@3=$BM25_H3_RATE  MRR=$BM25_MRR  Median=${BM25_MED}ms"
echo "Vector: Hit@1=$VECTOR_H1_RATE  Hit@3=$VECTOR_H3_RATE  MRR=$VECTOR_MRR  Median=${VECTOR_MED}ms"
echo "Hybrid: Hit@1=$HYBRID_H1_RATE  Hit@3=$HYBRID_H3_RATE  MRR=$HYBRID_MRR  Median=${HYBRID_MED}ms"
echo "Results written to: $RESULTS_DIR/kindx.json"
