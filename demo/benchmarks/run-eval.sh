#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# run-eval.sh — public KINDX CLI evaluation benchmark
#
# Runs the public CLI commands (`search`, `vsearch`, `query`) against the
# bundled eval corpus using an isolated KINDX home. By default it writes a
# local results file so the committed benchmark snapshot is not overwritten.
# ----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EVAL_DOCS="${PROJECT_ROOT}/specs/eval-docs"
KINDX_BIN="${KINDX_BIN:-kindx}"
RESULTS_FILE="${RESULTS_FILE:-${SCRIPT_DIR}/eval-results.local.json}"
TMPDIR_BASE="${TMPDIR:-/tmp}"
WORK_DIR=""
COLLECTION="kindx-eval"
LATENCY_RUNS="${LATENCY_RUNS:-3}"
QUERY_LIMIT="${QUERY_LIMIT:-0}"

# Format: "difficulty|query|expected_file_substring"
QUERIES=(
  "easy|API versioning|api-design-principles"
  "easy|Series A fundraising|startup-fundraising-memo"
  "easy|CAP theorem|distributed-systems-overview"
  "easy|overfitting machine learning|machine-learning-primer"
  "easy|remote work VPN|remote-work-policy"
  "easy|Project Phoenix retrospective|product-launch-retrospective"

  "medium|how to structure REST endpoints|api-design-principles"
  "medium|raising money for startup|startup-fundraising-memo"
  "medium|consistency vs availability tradeoffs|distributed-systems-overview"
  "medium|how to prevent models from memorizing data|machine-learning-primer"
  "medium|working from home guidelines|remote-work-policy"
  "medium|what went wrong with the launch|product-launch-retrospective"

  "hard|nouns not verbs|api-design-principles"
  "hard|Sequoia investor pitch|startup-fundraising-memo"
  "hard|Raft algorithm leader election|distributed-systems-overview"
  "hard|F1 score precision recall|machine-learning-primer"
  "hard|quarterly team gathering travel|remote-work-policy"
  "hard|beta program 47 bugs|product-launch-retrospective"

  "fusion|compare API versioning and error handling conventions|api-design-principles"
  "fusion|what happened after the Project Phoenix launch|product-launch-retrospective"
  "fusion|how should a startup prepare for Series A fundraising|startup-fundraising-memo"
  "fusion|what consistency tradeoffs matter in distributed systems|distributed-systems-overview"
  "fusion|how do teams balance remote work policy and travel|remote-work-policy"
  "fusion|which techniques reduce overfitting in machine learning|machine-learning-primer"
)

MODES=(bm25 vector hybrid)

if [[ "${QUERY_LIMIT}" -gt 0 ]]; then
  QUERIES=("${QUERIES[@]:0:${QUERY_LIMIT}}")
fi

log() {
  echo "[eval] $(date +%H:%M:%S) $*"
}

die() {
  echo "[eval] ERROR: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

time_ms() {
  local start end
  start=$(python3 -c 'import time; print(int(time.time()*1000))')
  "$@" >/dev/null 2>&1
  end=$(python3 -c 'import time; print(int(time.time()*1000))')
  ELAPSED_MS=$(( end - start ))
}

median() {
  printf '%s\n' "$@" | awk 'NF' | sort -n | awk '
    { a[NR] = $1 }
    END {
      if (NR == 0) exit 1;
      mid = int((NR + 1) / 2);
      print a[mid];
    }
  '
}

percentile() {
  local pct=$1
  shift
  printf '%s\n' "$@" | awk 'NF' | sort -n | awk -v pct="$pct" '
    { a[NR] = $1 }
    END {
      if (NR == 0) exit 1;
      idx = int((NR * pct + 99) / 100);
      if (idx < 1) idx = 1;
      if (idx > NR) idx = NR;
      print a[idx];
    }
  '
}

float_div() {
  python3 - "$1" "$2" <<'PY'
import sys
num = float(sys.argv[1])
den = float(sys.argv[2])
print(f"{(num / den) if den else 0:.3f}")
PY
}

ndcg_at_5() {
  python3 - "$1" <<'PY'
import math
import sys
rank = int(sys.argv[1])
if 1 <= rank <= 5:
    print(f"{1 / math.log2(rank + 1):.3f}")
else:
    print("0.000")
PY
}

if ! command -v "${KINDX_BIN}" >/dev/null 2>&1; then
  die "kindx binary not found. Set KINDX_BIN or add kindx to PATH."
fi

if [[ ! -d "${EVAL_DOCS}" ]]; then
  die "Eval docs not found at ${EVAL_DOCS}."
fi

if ! command -v jq >/dev/null 2>&1; then
  die "jq is required for JSON generation."
fi

WORK_DIR=$(mktemp -d "${TMPDIR_BASE}/kindx-eval.XXXXXX")
export KINDX_CONFIG_DIR="${WORK_DIR}/config"
export XDG_CACHE_HOME="${WORK_DIR}/cache"
export INDEX_PATH="${WORK_DIR}/index.sqlite"
mkdir -p "${KINDX_CONFIG_DIR}" "${XDG_CACHE_HOME}"

log "Using isolated KINDX state in ${WORK_DIR}"
log "Adding eval collection..."
"${KINDX_BIN}" collection add "${EVAL_DOCS}" --name "${COLLECTION}" >/dev/null
"${KINDX_BIN}" update -c "${COLLECTION}" >/dev/null

log "Generating embeddings..."
time_ms "${KINDX_BIN}" embed
EMBED_TIME_MS=${ELAPSED_MS}

HIT1=(0 0 0)
HIT3=(0 0 0)
HIT5=(0 0 0)
TOTAL=(0 0 0)
RR_SUM=(0 0 0)
NDCG_SUM=(0 0 0)
LATENCY=("" "" "")

run_search() {
  local mode=$1
  local query=$2
  case "${mode}" in
    bm25)   "${KINDX_BIN}" search "${query}" -c "${COLLECTION}" --json -n 5 2>/dev/null ;;
    vector) "${KINDX_BIN}" vsearch "${query}" -c "${COLLECTION}" --json -n 5 2>/dev/null ;;
    hybrid) "${KINDX_BIN}" query "${query}" -c "${COLLECTION}" --json -n 5 2>/dev/null ;;
    *) die "Unknown mode: ${mode}" ;;
  esac
}

match_rank() {
  local results=$1
  local expected=$2
  echo "${results}" | jq -r --arg expected "${expected}" '
    [.[] | .file] | to_entries | map(select(.value | contains($expected))) |
    if length > 0 then (.[0].key + 1) else 0 end
  ' 2>/dev/null || echo "0"
}

log "Running ${#QUERIES[@]} queries across ${#MODES[@]} public CLI modes..."

for entry in "${QUERIES[@]}"; do
  IFS='|' read -r difficulty query expected <<<"${entry}"
  log "  [${difficulty}] ${query}"
  for idx in "${!MODES[@]}"; do
    mode="${MODES[$idx]}"
    results=$(run_search "${mode}" "${query}" || echo "[]")
    rank=$(match_rank "${results}" "${expected}")

    TOTAL[$idx]=$(( ${TOTAL[$idx]} + 1 ))
    if [[ "${rank}" -eq 1 ]]; then
      HIT1[$idx]=$(( ${HIT1[$idx]} + 1 ))
    fi
    if [[ "${rank}" -ge 1 && "${rank}" -le 3 ]]; then
      HIT3[$idx]=$(( ${HIT3[$idx]} + 1 ))
    fi
    if [[ "${rank}" -ge 1 && "${rank}" -le 5 ]]; then
      HIT5[$idx]=$(( ${HIT5[$idx]} + 1 ))
    fi

    rr_value=$(python3 - "${rank}" <<'PY'
import sys
rank = int(sys.argv[1])
print(0 if rank <= 0 else 1 / rank)
PY
)
    RR_SUM[$idx]=$(python3 - "${RR_SUM[$idx]}" "${rr_value}" <<'PY'
import sys
print(float(sys.argv[1]) + float(sys.argv[2]))
PY
)
    NDCG_SUM[$idx]=$(python3 - "${NDCG_SUM[$idx]}" "$(ndcg_at_5 "${rank}")" <<'PY'
import sys
print(float(sys.argv[1]) + float(sys.argv[2]))
PY
)

    for ((run=1; run<=LATENCY_RUNS; run++)); do
      time_ms run_search "${mode}" "${query}"
      LATENCY[$idx]="${LATENCY[$idx]} ${ELAPSED_MS}"
    done
  done
done

mode_json() {
  local idx=$1
  local total=${TOTAL[$idx]}
  local median_ms p95_ms p99_ms
  median_ms=$(median ${LATENCY[$idx]})
  p95_ms=$(percentile 95 ${LATENCY[$idx]})
  p99_ms=$(percentile 99 ${LATENCY[$idx]})
  cat <<JSON
{
  "hit_at_1": $(float_div "${HIT1[$idx]}" "${total}"),
  "hit_at_3": $(float_div "${HIT3[$idx]}" "${total}"),
  "hit_at_5": $(float_div "${HIT5[$idx]}" "${total}"),
  "mrr": $(float_div "${RR_SUM[$idx]}" "${total}"),
  "ndcg_at_5": $(float_div "${NDCG_SUM[$idx]}" "${total}"),
  "latency": {
    "median_ms": ${median_ms},
    "p95_ms": ${p95_ms},
    "p99_ms": ${p99_ms}
  }
}
JSON
}

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DOC_COUNT=$(find "${EVAL_DOCS}" -name '*.md' -type f | wc -l | tr -d ' ')

jq -n \
  --arg date "${TIMESTAMP}" \
  --arg version "$(${KINDX_BIN} --version 2>/dev/null || echo 'unknown')" \
  --arg source "${EVAL_DOCS}" \
  --argjson documents "${DOC_COUNT}" \
  --argjson queries "${#QUERIES[@]}" \
  --argjson embed_time "${EMBED_TIME_MS}" \
  --argjson bm25 "$(mode_json 0)" \
  --argjson vector "$(mode_json 1)" \
  --argjson hybrid "$(mode_json 2)" \
  '{
    meta: {
      generated_at: $date,
      kindx_version: $version,
      generated_by: "run-eval.sh",
      notes: "Public CLI smoke benchmark. Results file defaults to eval-results.local.json so the committed benchmark snapshot remains unchanged.",
      corpus: {
        source: $source,
        documents: $documents
      },
      queries: {
        total: $queries,
        difficulty_levels: ["easy", "medium", "hard", "fusion"]
      },
      embed_time_ms: $embed_time
    },
    results: {
      bm25: $bm25,
      vector: $vector,
      hybrid: $hybrid
    }
  }' > "${RESULTS_FILE}"

log "Wrote results to ${RESULTS_FILE}"
jq '.' "${RESULTS_FILE}"
