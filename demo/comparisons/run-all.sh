#!/usr/bin/env bash
set -euo pipefail

# KINDX vs Competitors — Head-to-Head Comparison
# Master orchestrator: runs all available competitor tests and generates comparison report.
#
# Usage:
#   ./run-all.sh              # Run all available tests
#   ./run-all.sh kindx        # Run only KINDX
#   ./run-all.sh kindx chroma # Run KINDX and ChromaDB

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
COMPETITORS_DIR="$SCRIPT_DIR/competitors"
mkdir -p "$RESULTS_DIR"

# All competitors in preferred test order
ALL_COMPETITORS=(kindx chromadb lancedb orama khoj anythingllm privategpt localgpt gpt4all)

# If specific competitors are passed as arguments, use those
if [ $# -gt 0 ]; then
  COMPETITORS=("$@")
else
  COMPETITORS=("${ALL_COMPETITORS[@]}")
fi

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  KINDX vs Competitors — Head-to-Head Comparison         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Competitors to test: ${COMPETITORS[*]}"
echo "Results directory:   $RESULTS_DIR"
echo ""

PASSED=()
FAILED=()
SKIPPED=()

for competitor in "${COMPETITORS[@]}"; do
  COMP_DIR="$COMPETITORS_DIR/$competitor"

  if [ ! -d "$COMP_DIR" ]; then
    echo "[$competitor] Directory not found, skipping."
    SKIPPED+=("$competitor")
    continue
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Testing: $competitor"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Find the test script
  TEST_SCRIPT=""
  if [ -f "$COMP_DIR/test.sh" ]; then
    TEST_SCRIPT="$COMP_DIR/test.sh"
  elif [ -f "$COMP_DIR/test.py" ]; then
    TEST_SCRIPT="python3 $COMP_DIR/test.py"
  elif [ -f "$COMP_DIR/test.ts" ]; then
    TEST_SCRIPT="npx tsx $COMP_DIR/test.ts"
  fi

  if [ -z "$TEST_SCRIPT" ]; then
    echo "  No test script found, skipping."
    SKIPPED+=("$competitor")
    continue
  fi

  # Check prerequisites
  case "$competitor" in
    kindx)
      if ! command -v kindx &>/dev/null; then
        echo "  kindx CLI not found. Run setup.sh first."
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    chromadb)
      if ! python3 -c "import chromadb" 2>/dev/null; then
        echo "  chromadb not installed. Run: pip install chromadb"
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    lancedb)
      if ! python3 -c "import lancedb" 2>/dev/null; then
        echo "  lancedb not installed. Run: pip install lancedb sentence-transformers"
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    orama)
      if [ ! -d "$COMP_DIR/node_modules/@orama" ]; then
        echo "  @orama/orama not installed. Run setup.sh first."
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    khoj)
      KHOJ_URL="${KHOJ_URL:-http://localhost:42110}"
      if ! curl -sf "$KHOJ_URL/api/health" >/dev/null 2>&1; then
        echo "  Khoj not running. Run setup.sh first."
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    anythingllm)
      ANYTHINGLLM_URL="${ANYTHINGLLM_URL:-http://localhost:3001}"
      if ! curl -sf "$ANYTHINGLLM_URL/api/ping" >/dev/null 2>&1; then
        echo "  AnythingLLM not running. Run setup.sh first."
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    privategpt)
      PRIVATEGPT_URL="${PRIVATEGPT_URL:-http://localhost:8001}"
      if ! curl -sf "$PRIVATEGPT_URL/health" >/dev/null 2>&1; then
        echo "  PrivateGPT not running. Run setup.sh first."
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    localgpt)
      LOCALGPT_URL="${LOCALGPT_URL:-http://localhost:5111}"
      if ! curl -sf "$LOCALGPT_URL/health" >/dev/null 2>&1; then
        echo "  LocalGPT not running. Run setup.sh first."
        SKIPPED+=("$competitor")
        continue
      fi
      ;;
    gpt4all)
      echo "  GPT4All is desktop-only; writing placeholder results."
      ;;
  esac

  # Run the test
  echo "  Running: $TEST_SCRIPT"
  START=$(date +%s)
  if bash -c "$TEST_SCRIPT" 2>&1; then
    END=$(date +%s)
    ELAPSED=$((END - START))
    echo "  ✓ $competitor completed in ${ELAPSED}s"
    PASSED+=("$competitor")
  else
    END=$(date +%s)
    ELAPSED=$((END - START))
    echo "  ✗ $competitor failed after ${ELAPSED}s"
    FAILED+=("$competitor")
  fi

  echo ""
done

# Generate comparison report if Python is available
if [ ${#PASSED[@]} -gt 0 ] && command -v python3 &>/dev/null; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Generating comparison report..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if [ -f "$SCRIPT_DIR/analysis/compare-results.py" ]; then
    python3 "$SCRIPT_DIR/analysis/compare-results.py" "$RESULTS_DIR" || true
  fi
  if [ -f "$SCRIPT_DIR/analysis/generate-report.py" ]; then
    python3 "$SCRIPT_DIR/analysis/generate-report.py" "$RESULTS_DIR" || true
  fi
fi

# Print summary
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Summary                                                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Passed:  ${PASSED[*]:-none}"
echo "  Failed:  ${FAILED[*]:-none}"
echo "  Skipped: ${SKIPPED[*]:-none}"
echo ""
echo "  Results in: $RESULTS_DIR/"
echo ""

# Print quick comparison table if results exist
if ls "$RESULTS_DIR"/*.json >/dev/null 2>&1; then
  echo "┌─────────────────┬──────────┬──────────┬──────────┬────────────┐"
  echo "│ Tool            │ Hit@1    │ Hit@3    │ MRR      │ Median(ms) │"
  echo "├─────────────────┼──────────┼──────────┼──────────┼────────────┤"
  for result_file in "$RESULTS_DIR"/*.json; do
    TOOL=$(jq -r '.tool' "$result_file")
    # Pick the best mode available
    BEST_MODE="hybrid"
    H1=$(jq -r ".aggregate.$BEST_MODE.hit_at_1 // 0" "$result_file")
    if [ "$H1" = "0" ]; then
      BEST_MODE="vector"
      H1=$(jq -r ".aggregate.$BEST_MODE.hit_at_1 // 0" "$result_file")
    fi
    if [ "$H1" = "0" ]; then
      BEST_MODE="bm25"
      H1=$(jq -r ".aggregate.$BEST_MODE.hit_at_1 // 0" "$result_file")
    fi
    H3=$(jq -r ".aggregate.$BEST_MODE.hit_at_3 // 0" "$result_file")
    MRR=$(jq -r ".aggregate.$BEST_MODE.mrr // 0" "$result_file")
    MED=$(jq -r ".aggregate.$BEST_MODE.median_latency_ms // 0" "$result_file")
    printf "│ %-15s │ %-8s │ %-8s │ %-8s │ %-10s │\n" "$TOOL" "$H1" "$H3" "$MRR" "${MED}ms"
  done
  echo "└─────────────────┴──────────┴──────────┴──────────┴────────────┘"
fi

# Exit with failure if any tests failed
[ ${#FAILED[@]} -eq 0 ]
