#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# run-eval.sh — KINDX retrieval evaluation benchmark
#
# Runs BM25, vector, and hybrid search evaluations against the eval corpus,
# collects timing data, and generates eval-results.json.
#
# Usage:
#   chmod +x run-eval.sh
#   ./run-eval.sh
#
# Requirements:
#   - kindx binary on PATH (or KINDX_BIN env var)
#   - specs/eval-docs/ directory with evaluation markdown documents
#   - jq (for JSON assembly)
# ----------------------------------------------------------------------------
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EVAL_DOCS="${PROJECT_ROOT}/specs/eval-docs"
RESULTS_FILE="${SCRIPT_DIR}/eval-results.json"
KINDX_BIN="${KINDX_BIN:-kindx}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMPDIR_BASE="${TMPDIR:-/tmp}"
WORK_DIR=""

# Number of runs per query for latency averaging
LATENCY_RUNS=5

# ── Canned Evaluation Queries ──────────────────────────────────────────────
# Format: "difficulty|query|expected_chunk_id"
# 6 queries per difficulty level = 24 total

QUERIES=(
  # Easy — exact keyword matches
  "easy|What is the default chunk size?|chunk-config-defaults"
  "easy|How do I install kindx?|installation-guide"
  "easy|What embedding model does kindx use?|embedding-model-spec"
  "easy|What is the SQLite schema for documents?|sqlite-schema-docs"
  "easy|How is BM25 scoring configured?|bm25-parameters"
  "easy|What CLI flags does kindx search accept?|cli-search-flags"

  # Medium — paraphrased, synonym matching
  "medium|How do I break documents into smaller pieces?|chunk-config-defaults"
  "medium|What are the system requirements for running kindx?|installation-guide"
  "medium|Which neural network converts text to vectors?|embedding-model-spec"
  "medium|Describe the database table structure|sqlite-schema-docs"
  "medium|How does term frequency ranking work?|bm25-parameters"
  "medium|What options are available for querying?|cli-search-flags"

  # Hard — semantic, no keyword overlap
  "hard|How can I control granularity of indexed passages?|chunk-config-defaults"
  "hard|What do I need before my first search works?|installation-guide"
  "hard|Explain the dimensionality of the semantic representation|embedding-model-spec"
  "hard|Where is the persistent state stored on disk?|sqlite-schema-docs"
  "hard|Why might a rare term score higher than a common one?|bm25-parameters"
  "hard|How do I narrow results to a specific folder?|cli-search-flags"

  # Fusion — multi-document reasoning
  "fusion|How do BM25 and vector scores get combined?|hybrid-rrf-algorithm"
  "fusion|What happens between chunking and the first search query?|embedding-pipeline"
  "fusion|Compare the latency of keyword vs semantic search|search-latency-tradeoffs"
  "fusion|How does the reranker improve on initial retrieval?|reranker-pipeline"
  "fusion|What storage formats are used for text vs vectors?|storage-architecture"
  "fusion|Trace a query from input to ranked results|end-to-end-search-flow"
)

# ── Helper Functions ────────────────────────────────────────────────────────

log() {
  echo "[eval] $(date +%H:%M:%S) $*"
}

die() {
  echo "[eval] ERROR: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    log "Cleaning up temp directory: ${WORK_DIR}"
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

# Time a command in milliseconds; stores result in global ELAPSED_MS
time_ms() {
  local start end
  start=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  "$@" > /dev/null 2>&1
  end=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  ELAPSED_MS=$(( (end - start) / 1000000 ))
}

# Compute median from a space-separated list of numbers
median() {
  local sorted
  sorted=$(echo "$@" | tr ' ' '\n' | sort -n)
  local count
  count=$(echo "$sorted" | wc -l | tr -d ' ')
  local mid=$(( (count + 1) / 2 ))
  echo "$sorted" | sed -n "${mid}p"
}

# Compute a percentile (p95, p99) from a space-separated list
percentile() {
  local pct=$1
  shift
  local sorted
  sorted=$(echo "$@" | tr ' ' '\n' | sort -n)
  local count
  count=$(echo "$sorted" | wc -l | tr -d ' ')
  local idx=$(( (count * pct + 99) / 100 ))
  [[ $idx -lt 1 ]] && idx=1
  echo "$sorted" | sed -n "${idx}p"
}

# ── Preflight Checks ───────────────────────────────────────────────────────

log "KINDX Retrieval Evaluation Benchmark"
log "====================================="

# Check for kindx binary
if ! command -v "${KINDX_BIN}" &> /dev/null; then
  die "kindx binary not found. Set KINDX_BIN or add kindx to PATH."
fi
log "Using kindx: $(command -v "${KINDX_BIN}")"
log "Version: $(${KINDX_BIN} --version 2>/dev/null || echo 'unknown')"

# Check for eval docs
if [[ ! -d "${EVAL_DOCS}" ]]; then
  die "Eval docs not found at ${EVAL_DOCS}. Run from project root."
fi
DOC_COUNT=$(find "${EVAL_DOCS}" -name '*.md' -type f | wc -l | tr -d ' ')
log "Found ${DOC_COUNT} eval documents in ${EVAL_DOCS}"

# Check for jq
if ! command -v jq &> /dev/null; then
  die "jq is required for JSON generation. Install with: brew install jq"
fi

# ── Create Temp Collection ──────────────────────────────────────────────────

WORK_DIR=$(mktemp -d "${TMPDIR_BASE}/kindx-eval.XXXXXX")
COLLECTION_DIR="${WORK_DIR}/collection"
log "Temp directory: ${WORK_DIR}"

log "Creating eval collection..."
${KINDX_BIN} init "${COLLECTION_DIR}" 2>/dev/null || true

# Copy eval docs into collection
cp "${EVAL_DOCS}"/*.md "${COLLECTION_DIR}/" 2>/dev/null || \
  die "Failed to copy eval documents"

# ── Index and Embed ─────────────────────────────────────────────────────────

log "Indexing documents..."
time_ms ${KINDX_BIN} index "${COLLECTION_DIR}"
INDEX_TIME_MS=${ELAPSED_MS}
log "Indexing completed in ${INDEX_TIME_MS}ms"

log "Generating embeddings..."
time_ms ${KINDX_BIN} embed "${COLLECTION_DIR}"
EMBED_TIME_MS=${ELAPSED_MS}
log "Embedding completed in ${EMBED_TIME_MS}ms"

# ── Run Evaluations ─────────────────────────────────────────────────────────

declare -A MODE_HITS_1 MODE_HITS_3 MODE_HITS_5 MODE_TOTAL
declare -A MODE_RR_SUM  # for MRR calculation
declare -A LATENCY_SAMPLES

for mode in bm25 vector hybrid hybrid_rerank; do
  MODE_HITS_1[$mode]=0
  MODE_HITS_3[$mode]=0
  MODE_HITS_5[$mode]=0
  MODE_TOTAL[$mode]=0
  MODE_RR_SUM[$mode]=0
  LATENCY_SAMPLES[$mode]=""
done

run_search() {
  local mode=$1
  local query=$2
  local search_flags=""

  case "${mode}" in
    bm25)          search_flags="--mode bm25" ;;
    vector)        search_flags="--mode vector" ;;
    hybrid)        search_flags="--mode hybrid" ;;
    hybrid_rerank) search_flags="--mode hybrid --rerank" ;;
  esac

  ${KINDX_BIN} search ${search_flags} --top 5 --json \
    "${COLLECTION_DIR}" "${query}" 2>/dev/null
}

log ""
log "Running search evaluations (${#QUERIES[@]} queries x 4 modes x ${LATENCY_RUNS} runs)..."
log ""

query_num=0
for entry in "${QUERIES[@]}"; do
  IFS='|' read -r difficulty query expected_id <<< "${entry}"
  query_num=$((query_num + 1))

  log "  Query ${query_num}/24 [${difficulty}]: ${query:0:50}..."

  for mode in bm25 vector hybrid hybrid_rerank; do
    # Accuracy evaluation (single run)
    results=$(run_search "${mode}" "${query}" || echo "[]")

    # Check hits at various k
    for k in 1 3 5; do
      hit=$(echo "${results}" | jq -r \
        --arg eid "${expected_id}" \
        --argjson k "${k}" \
        '[.[:$k] | .[].chunk_id] | if any(. == $eid) then "1" else "0" end' \
        2>/dev/null || echo "0")

      case $k in
        1) MODE_HITS_1[$mode]=$(( ${MODE_HITS_1[$mode]} + hit )) ;;
        3) MODE_HITS_3[$mode]=$(( ${MODE_HITS_3[$mode]} + hit )) ;;
        5) MODE_HITS_5[$mode]=$(( ${MODE_HITS_5[$mode]} + hit )) ;;
      esac
    done

    # Reciprocal rank
    rank=$(echo "${results}" | jq -r \
      --arg eid "${expected_id}" \
      '[.[] | .chunk_id] | to_entries | map(select(.value == $eid)) | if length > 0 then (.[0].key + 1) else 0 end' \
      2>/dev/null || echo "0")

    if [[ "${rank}" -gt 0 ]]; then
      # Bash doesn't do float math; accumulate as fixed-point (x1000)
      rr=$(( 1000 / rank ))
      MODE_RR_SUM[$mode]=$(( ${MODE_RR_SUM[$mode]} + rr ))
    fi

    MODE_TOTAL[$mode]=$(( ${MODE_TOTAL[$mode]} + 1 ))

    # Latency measurement (multiple runs)
    for ((run=1; run<=LATENCY_RUNS; run++)); do
      time_ms run_search "${mode}" "${query}"
      LATENCY_SAMPLES[$mode]="${LATENCY_SAMPLES[$mode]} ${ELAPSED_MS}"
    done
  done
done

# ── Compute Metrics ─────────────────────────────────────────────────────────

log ""
log "Computing metrics..."

compute_metric() {
  local hits=$1
  local total=$2
  if [[ $total -eq 0 ]]; then
    echo "0.000"
  else
    # Fixed-point division with 3 decimal places
    printf "%.3f" "$(echo "scale=3; ${hits} / ${total}" | bc)"
  fi
}

# ── Generate Results JSON ───────────────────────────────────────────────────

log "Generating ${RESULTS_FILE}..."

# Build latency stats per mode
build_latency_json() {
  local mode=$1
  local samples="${LATENCY_SAMPLES[$mode]}"
  local med p95 p99

  med=$(median ${samples})
  p95=$(percentile 95 ${samples})
  p99=$(percentile 99 ${samples})

  cat <<LATJSON
{
      "median_ms": ${med},
      "p95_ms": ${p95},
      "p99_ms": ${p99}
    }
LATJSON
}

# Assemble final JSON using jq
jq -n \
  --arg date "${TIMESTAMP}" \
  --arg version "$(${KINDX_BIN} --version 2>/dev/null || echo 'unknown')" \
  --argjson doc_count "${DOC_COUNT}" \
  --argjson query_count "${#QUERIES[@]}" \
  --argjson index_time "${INDEX_TIME_MS}" \
  --argjson embed_time "${EMBED_TIME_MS}" \
  --argjson bm25_h1 "${MODE_HITS_1[bm25]}" \
  --argjson bm25_h3 "${MODE_HITS_3[bm25]}" \
  --argjson bm25_h5 "${MODE_HITS_5[bm25]}" \
  --argjson bm25_total "${MODE_TOTAL[bm25]}" \
  --argjson vec_h1 "${MODE_HITS_1[vector]}" \
  --argjson vec_h3 "${MODE_HITS_3[vector]}" \
  --argjson vec_h5 "${MODE_HITS_5[vector]}" \
  --argjson vec_total "${MODE_TOTAL[vector]}" \
  --argjson hyb_h1 "${MODE_HITS_1[hybrid]}" \
  --argjson hyb_h3 "${MODE_HITS_3[hybrid]}" \
  --argjson hyb_h5 "${MODE_HITS_5[hybrid]}" \
  --argjson hyb_total "${MODE_TOTAL[hybrid]}" \
  --argjson rr_h1 "${MODE_HITS_1[hybrid_rerank]}" \
  --argjson rr_h3 "${MODE_HITS_3[hybrid_rerank]}" \
  --argjson rr_h5 "${MODE_HITS_5[hybrid_rerank]}" \
  --argjson rr_total "${MODE_TOTAL[hybrid_rerank]}" \
  '{
    meta: {
      test_date: $date,
      kindx_version: $version,
      generated_by: "run-eval.sh",
      hardware: {
        cpu: "detected at runtime",
        ram_gb: "detected at runtime"
      },
      corpus: {
        documents: $doc_count,
        queries: $query_count
      },
      timing: {
        index_ms: $index_time,
        embed_ms: $embed_time
      }
    },
    results: {
      bm25: {
        hit_at_1: ($bm25_h1 / $bm25_total),
        hit_at_3: ($bm25_h3 / $bm25_total),
        hit_at_5: ($bm25_h5 / $bm25_total)
      },
      vector: {
        hit_at_1: ($vec_h1 / $vec_total),
        hit_at_3: ($vec_h3 / $vec_total),
        hit_at_5: ($vec_h5 / $vec_total)
      },
      hybrid_rrf: {
        hit_at_1: ($hyb_h1 / $hyb_total),
        hit_at_3: ($hyb_h3 / $hyb_total),
        hit_at_5: ($hyb_h5 / $hyb_total)
      },
      hybrid_rerank: {
        hit_at_1: ($rr_h1 / $rr_total),
        hit_at_3: ($rr_h3 / $rr_total),
        hit_at_5: ($rr_h5 / $rr_total)
      }
    }
  }' > "${RESULTS_FILE}"

# ── Print Summary ───────────────────────────────────────────────────────────

log ""
log "====================================="
log "Evaluation Complete"
log "====================================="
log ""
log "Results written to: ${RESULTS_FILE}"
log ""
log "Quick Summary:"
log "  BM25          Hit@1=$(compute_metric ${MODE_HITS_1[bm25]} ${MODE_TOTAL[bm25]})  Hit@3=$(compute_metric ${MODE_HITS_3[bm25]} ${MODE_TOTAL[bm25]})  Hit@5=$(compute_metric ${MODE_HITS_5[bm25]} ${MODE_TOTAL[bm25]})"
log "  Vector        Hit@1=$(compute_metric ${MODE_HITS_1[vector]} ${MODE_TOTAL[vector]})  Hit@3=$(compute_metric ${MODE_HITS_3[vector]} ${MODE_TOTAL[vector]})  Hit@5=$(compute_metric ${MODE_HITS_5[vector]} ${MODE_TOTAL[vector]})"
log "  Hybrid (RRF)  Hit@1=$(compute_metric ${MODE_HITS_1[hybrid]} ${MODE_TOTAL[hybrid]})  Hit@3=$(compute_metric ${MODE_HITS_3[hybrid]} ${MODE_TOTAL[hybrid]})  Hit@5=$(compute_metric ${MODE_HITS_5[hybrid]} ${MODE_TOTAL[hybrid]})"
log "  Hybrid+Rerank Hit@1=$(compute_metric ${MODE_HITS_1[hybrid_rerank]} ${MODE_TOTAL[hybrid_rerank]})  Hit@3=$(compute_metric ${MODE_HITS_3[hybrid_rerank]} ${MODE_TOTAL[hybrid_rerank]})  Hit@5=$(compute_metric ${MODE_HITS_5[hybrid_rerank]} ${MODE_TOTAL[hybrid_rerank]})"
log ""
log "Latency (median):"
log "  BM25:          $(median ${LATENCY_SAMPLES[bm25]})ms"
log "  Vector:        $(median ${LATENCY_SAMPLES[vector]})ms"
log "  Hybrid (RRF):  $(median ${LATENCY_SAMPLES[hybrid]})ms"
log "  Hybrid+Rerank: $(median ${LATENCY_SAMPLES[hybrid_rerank]})ms"
log ""
log "Full reports: eval-report.md, latency-report.md"
