#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# large-corpus.sh — Stress test: ingest, embed, and search a 500-file corpus
# =============================================================================
# Generates 500 synthetic markdown files with varied content, registers them
# as a KINDX collection, and benchmarks update / embed / search operations.
# Reports wall-clock time and (optionally) peak memory via /usr/bin/time.
# =============================================================================

COLLECTION="stress-test-large-corpus"
FILE_COUNT=500
TMPDIR=""

# ---------------------------------------------------------------------------
# Cleanup trap — always remove temp directory and deregister collection
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  echo ""
  echo "--- Cleaning up ---"
  # Remove the collection from KINDX (ignore errors if it was never added)
  kindx collection rm "$COLLECTION" 2>/dev/null || true
  # Remove the temp directory
  if [[ -n "$TMPDIR" && -d "$TMPDIR" ]]; then
    rm -rf "$TMPDIR"
    echo "Removed temp directory: $TMPDIR"
  fi
  if [[ $exit_code -ne 0 ]]; then
    echo "Script exited with error code $exit_code"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Helper: portable high-resolution timer (seconds with nanoseconds)
# ---------------------------------------------------------------------------
now() {
  date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))'
}

elapsed_ms() {
  local start=$1 end=$2
  echo $(( (end - start) / 1000000 ))
}

# ---------------------------------------------------------------------------
# Helper: run a command and report its wall-clock time (and memory if possible)
# ---------------------------------------------------------------------------
TIME_BIN=""
if [[ -x /usr/bin/time ]]; then
  TIME_BIN="/usr/bin/time"
fi

bench() {
  local label="$1"; shift
  echo ""
  echo "=== $label ==="
  local t_start t_end ms

  if [[ -n "$TIME_BIN" ]]; then
    t_start=$(now)
    "$TIME_BIN" -v "$@" 2>&1 | tee /dev/stderr | grep -i "maximum resident" || true
    t_end=$(now)
  else
    t_start=$(now)
    "$@"
    t_end=$(now)
  fi

  ms=$(elapsed_ms "$t_start" "$t_end")
  echo "  -> $label completed in ${ms} ms"
}

# ---------------------------------------------------------------------------
# Paragraph templates — varied content so embeddings are non-trivial
# ---------------------------------------------------------------------------
TOPICS=(
  "machine learning" "distributed systems" "functional programming"
  "web development" "database optimization" "cloud architecture"
  "security best practices" "performance testing" "API design"
  "container orchestration" "event sourcing" "domain-driven design"
  "microservices" "observability" "continuous integration"
  "data pipelines" "graph algorithms" "type theory"
  "reactive programming" "edge computing"
)

PARAGRAPHS=(
  "This document explores the fundamental principles and practical applications of the topic at hand. We examine both theoretical foundations and real-world implementation strategies that have proven effective in production systems."
  "Understanding the trade-offs involved is critical for making informed architectural decisions. Each approach carries its own set of advantages and limitations that must be carefully weighed against project requirements."
  "Recent advances in this area have opened up new possibilities for developers and organizations alike. The ecosystem continues to evolve rapidly, with new tools and frameworks emerging to address previously unsolved challenges."
  "Testing and validation remain essential components of any robust engineering practice. Without rigorous verification, even the most elegant solutions can harbor subtle defects that surface only under production load."
  "Scalability considerations must be addressed early in the design phase. Retrofitting a system for scale after deployment is significantly more costly and error-prone than building with growth in mind from the start."
  "The interplay between correctness and performance is a recurring theme in software engineering. Optimizations that sacrifice correctness are rarely worthwhile, but unnecessary pessimizations waste resources and degrade user experience."
  "Documentation serves as the connective tissue between current developers and future maintainers. Well-written technical documentation reduces onboarding time and prevents knowledge silos from forming within teams."
  "Error handling strategies vary widely across paradigms and languages, but the underlying goal is consistent: ensure that failures are detected, reported, and recovered from gracefully without data loss or corruption."
)

# ---------------------------------------------------------------------------
# Step 1: Create temp directory
# ---------------------------------------------------------------------------
TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/kindx-stress-XXXXXX")
echo "Temp directory: $TMPDIR"

# ---------------------------------------------------------------------------
# Step 2: Generate 500 markdown files with varied content
# ---------------------------------------------------------------------------
echo "Generating $FILE_COUNT markdown files..."

for i in $(seq 1 "$FILE_COUNT"); do
  # Pick a topic and a few paragraphs pseudo-randomly
  topic_idx=$(( i % ${#TOPICS[@]} ))
  topic="${TOPICS[$topic_idx]}"

  para1_idx=$(( (i * 3) % ${#PARAGRAPHS[@]} ))
  para2_idx=$(( (i * 7 + 1) % ${#PARAGRAPHS[@]} ))
  para3_idx=$(( (i * 11 + 2) % ${#PARAGRAPHS[@]} ))

  filename=$(printf "%04d-%s.md" "$i" "$(echo "$topic" | tr ' ' '-')")

  cat > "$TMPDIR/$filename" <<EOF
# $topic — Document $i

**Tags:** stress-test, $topic, document-$i
**Created:** $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2026-01-01T00:00:00Z")

## Overview

${PARAGRAPHS[$para1_idx]}

## Details

${PARAGRAPHS[$para2_idx]}

### Sub-section: Implementation Notes

${PARAGRAPHS[$para3_idx]}

When working with $topic, it is important to consider the broader context of the
system. Integration points, failure modes, and operational requirements all play
a role in shaping the final design.

## Code Example

\`\`\`python
# Example related to $topic
def process_item_${i}(data):
    \"\"\"Process data for $topic scenario $i.\"\"\"
    result = analyze(data, strategy="$topic")
    return validate(result)
\`\`\`

## Summary

This document ($i of $FILE_COUNT) covered aspects of $topic relevant to modern
software engineering practices. Further reading is recommended for production use.
EOF
done

echo "Generated $FILE_COUNT files in $TMPDIR"
ls "$TMPDIR" | wc -l | xargs -I{} echo "  File count verified: {}"

# ---------------------------------------------------------------------------
# Step 3: Register the collection
# ---------------------------------------------------------------------------
echo ""
echo "Registering collection '$COLLECTION'..."
kindx collection add "$COLLECTION" "$TMPDIR"

# ---------------------------------------------------------------------------
# Step 4: Benchmark — update
# ---------------------------------------------------------------------------
bench "kindx update" kindx update -c "$COLLECTION"

# ---------------------------------------------------------------------------
# Step 5: Benchmark — embed (this may take a while for 500 files)
# ---------------------------------------------------------------------------
echo ""
echo "NOTE: Embedding 500 files may take several minutes depending on hardware."
bench "kindx embed" kindx embed -c "$COLLECTION"

# ---------------------------------------------------------------------------
# Step 6: Benchmark — search
# ---------------------------------------------------------------------------
bench "kindx search (text)" kindx search "performance testing" -c "$COLLECTION"
bench "kindx search (unrelated)" kindx search "quantum entanglement" -c "$COLLECTION"

# ---------------------------------------------------------------------------
# Step 7: Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================="
echo "  Large Corpus Stress Test — Complete"
echo "============================================="
echo "  Collection : $COLLECTION"
echo "  Files      : $FILE_COUNT"
echo "  Temp Dir   : $TMPDIR"
echo "============================================="
echo ""
echo "Cleanup will run automatically via trap."
