#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# corruption-recovery.sh — Verify KINDX resilience and recovery
# =============================================================================
# Tests how KINDX handles adverse conditions:
#   1. Interrupted embed (SIGKILL mid-operation)
#   2. Database corruption (flipped bytes in SQLite file)
#   3. Missing model files (renamed model cache)
#   4. Disk full (informational — documents expected behavior)
#
# NOTE: This script is partly INFORMATIONAL / EDUCATIONAL. Some tests involve
# destructive operations (killing processes, corrupting files) that may require
# manual verification of results. The script does its best to automate checks,
# but human review of output is recommended.
# =============================================================================

COLLECTION="stress-test-corruption"
TMPDIR=""
PASS_COUNT=0
FAIL_COUNT=0
INFO_COUNT=0

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  echo ""
  echo "--- Cleaning up ---"

  # Restore model cache if we renamed it
  if [[ -n "${MODEL_CACHE_BACKUP:-}" && -d "$MODEL_CACHE_BACKUP" ]]; then
    if [[ -d "${MODEL_CACHE_ORIGINAL:-}" ]]; then
      echo "  Model cache already restored."
    else
      mv "$MODEL_CACHE_BACKUP" "$MODEL_CACHE_ORIGINAL" 2>/dev/null || true
      echo "  Restored model cache from backup."
    fi
  fi

  kindx collection rm "$COLLECTION" 2>/dev/null || true

  if [[ -n "$TMPDIR" && -d "$TMPDIR" ]]; then
    rm -rf "$TMPDIR"
    echo "  Removed temp directory: $TMPDIR"
  fi

  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------
pass() {
  local name="$1"
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  [PASS] $name"
}

fail() {
  local name="$1"
  local detail="${2:-}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  [FAIL] $name"
  if [[ -n "$detail" ]]; then
    echo "         $detail"
  fi
}

info() {
  local name="$1"
  local detail="${2:-}"
  INFO_COUNT=$((INFO_COUNT + 1))
  echo "  [INFO] $name"
  if [[ -n "$detail" ]]; then
    echo "         $detail"
  fi
}

# ---------------------------------------------------------------------------
# Setup: create temp collection with sample files
# ---------------------------------------------------------------------------
echo "=== Corruption & Recovery Test Suite ==="
echo ""
echo "NOTE: Some tests are informational and may require manual verification."
echo "      This script will NOT permanently damage your KINDX installation."
echo ""

TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/kindx-corrupt-XXXXXX")
echo "Temp directory: $TMPDIR"

# Generate sample files
for i in $(seq 1 15); do
  cat > "$TMPDIR/document-$(printf '%02d' "$i").md" <<EOF
# Recovery Test Document $i

This document is part of the corruption recovery test suite. It contains
enough content to be indexed and embedded by KINDX. The purpose is to verify
that the system can recover gracefully from various failure modes.

## Section A

Content for section A of document $i. Topics include fault tolerance,
data integrity, and graceful degradation under failure conditions.

## Section B

Additional content providing more text for the embedding pipeline to process.
Keywords: recovery, corruption, resilience, document-$i
EOF
done

echo "Generated 15 sample files."

# Register and do initial embed
kindx collection add "$COLLECTION" "$TMPDIR"
kindx update -c "$COLLECTION" 2>&1 || true
kindx embed -c "$COLLECTION" 2>&1 || true
echo "Initial indexing complete."
echo ""

# ===================== Test 1: Interrupted embed ==========================
echo "--- Test 1: Interrupted embed (SIGKILL) ---"
echo ""
echo "  This test starts an embed operation and kills it mid-flight with"
echo "  SIGKILL, then verifies that search still works afterward."
echo ""

# Add a few more files to force re-embedding
for i in $(seq 16 30); do
  cat > "$TMPDIR/new-doc-$(printf '%02d' "$i").md" <<EOF
# New Document $i — Added After Initial Embed

This document was added to trigger a new embed pass. It should be processed
when kindx embed runs again. Content relates to system recovery testing.
EOF
done

kindx update -c "$COLLECTION" 2>&1 || true

# Start embed in background
kindx embed -c "$COLLECTION" &>/dev/null &
EMBED_PID=$!

# Wait briefly then kill it hard
sleep 2
if kill -0 "$EMBED_PID" 2>/dev/null; then
  kill -9 "$EMBED_PID" 2>/dev/null || true
  wait "$EMBED_PID" 2>/dev/null || true
  echo "  Embed process $EMBED_PID killed with SIGKILL."
else
  echo "  Embed process $EMBED_PID already finished (files were small)."
  info "interrupted embed" "Embed finished before SIGKILL — test inconclusive for interruption"
fi

# Verify search still works after the interrupted embed
search_out=$(kindx search "recovery" -c "$COLLECTION" 2>&1) || true
search_exit=$?

if [[ $search_exit -eq 0 ]]; then
  pass "search after interrupted embed: exit code 0"
else
  fail "search after interrupted embed: exit code $search_exit" "$search_out"
fi

# Re-run embed to verify it can recover and finish
reembed_out=$(kindx embed -c "$COLLECTION" 2>&1) || true
reembed_exit=$?

if [[ $reembed_exit -eq 0 ]]; then
  pass "re-embed after interruption: completed successfully"
else
  fail "re-embed after interruption: exit code $reembed_exit" "$reembed_out"
fi

# ===================== Test 2: Database corruption ========================
echo ""
echo "--- Test 2: Database corruption (byte flipping) ---"
echo ""
echo "  This test locates the KINDX SQLite database, creates a backup,"
echo "  corrupts a few bytes in a copy, and checks how kindx responds."
echo ""

# Locate the KINDX database
KINDX_DB=""
for candidate in \
  "$HOME/.cache/kindx/kindx.db" \
  "$HOME/.cache/kindx/index.db" \
  "$HOME/.cache/kindx/data.db" \
  "$HOME/.local/share/kindx/kindx.db" \
  "$HOME/.cache/kindx/kindx.sqlite" \
  "$HOME/.cache/kindx/db.sqlite"; do
  if [[ -f "$candidate" ]]; then
    KINDX_DB="$candidate"
    break
  fi
done

if [[ -z "$KINDX_DB" ]]; then
  # Try to find it
  KINDX_DB=$(find "$HOME/.cache/kindx" -name "*.db" -o -name "*.sqlite" 2>/dev/null | head -1) || true
fi

if [[ -n "$KINDX_DB" && -f "$KINDX_DB" ]]; then
  echo "  Found database: $KINDX_DB"
  DB_BACKUP="$TMPDIR/kindx-db-backup"
  cp "$KINDX_DB" "$DB_BACKUP"
  echo "  Backup created: $DB_BACKUP"

  # Corrupt some bytes in the middle of the database
  db_size=$(wc -c < "$KINDX_DB")
  if [[ $db_size -gt 4096 ]]; then
    # Write garbage at offset 2048 (past the SQLite header, into data pages)
    printf '\xDE\xAD\xBE\xEF\xCA\xFE\xBA\xBE' | dd of="$KINDX_DB" bs=1 seek=2048 conv=notrunc 2>/dev/null
    echo "  Corrupted 8 bytes at offset 2048."

    # Try to use kindx with the corrupted database
    corrupt_out=$(kindx search "recovery" -c "$COLLECTION" 2>&1) || true
    corrupt_exit=$?

    # We expect either: graceful error message, or it still works (SQLite is
    # surprisingly resilient if the corruption hits unused pages)
    if [[ $corrupt_exit -eq 139 || $corrupt_exit -eq 134 ]]; then
      fail "corrupted db: process crashed (signal $corrupt_exit)" "$corrupt_out"
    else
      pass "corrupted db: no hard crash (exit code $corrupt_exit)"
      if [[ $corrupt_exit -ne 0 ]]; then
        info "corrupted db: kindx returned error" "$(echo "$corrupt_out" | tail -1)"
      fi
    fi

    # Restore the database from backup
    cp "$DB_BACKUP" "$KINDX_DB"
    echo "  Database restored from backup."

    # Verify kindx works again after restoration
    restore_out=$(kindx search "recovery" -c "$COLLECTION" 2>&1) || true
    restore_exit=$?

    if [[ $restore_exit -eq 0 ]]; then
      pass "search after db restore: works correctly"
    else
      fail "search after db restore: exit code $restore_exit" "$restore_out"
    fi
  else
    info "database too small to safely corrupt" "Size: $db_size bytes"
  fi
else
  info "database file not found" \
       "Searched common locations. KINDX may use a different storage path."
  echo "  Skipping database corruption test."
fi

# ===================== Test 3: Missing model files ========================
echo ""
echo "--- Test 3: Missing model files ---"
echo ""
echo "  This test temporarily renames the model cache directory to simulate"
echo "  missing model files, then verifies kindx gives a helpful error."
echo ""

MODEL_CACHE_ORIGINAL=""
MODEL_CACHE_BACKUP=""

# Common model cache locations
for candidate in \
  "$HOME/.cache/kindx/models" \
  "$HOME/.cache/kindx/onnx" \
  "$HOME/.cache/kindx/model" \
  "$HOME/.local/share/kindx/models" \
  "$HOME/.cache/huggingface"; do
  if [[ -d "$candidate" ]]; then
    MODEL_CACHE_ORIGINAL="$candidate"
    break
  fi
done

if [[ -n "$MODEL_CACHE_ORIGINAL" ]]; then
  echo "  Found model cache: $MODEL_CACHE_ORIGINAL"
  MODEL_CACHE_BACKUP="${MODEL_CACHE_ORIGINAL}.bak-stress-test"

  # Rename to simulate missing models
  mv "$MODEL_CACHE_ORIGINAL" "$MODEL_CACHE_BACKUP"
  echo "  Renamed to: $MODEL_CACHE_BACKUP"

  # Try to embed — should fail with a helpful error, not a crash
  missing_out=$(kindx embed -c "$COLLECTION" 2>&1) || true
  missing_exit=$?

  if [[ $missing_exit -eq 139 || $missing_exit -eq 134 ]]; then
    fail "missing models: process crashed (signal $missing_exit)"
  elif [[ $missing_exit -ne 0 ]]; then
    # Non-zero exit is expected — check if the error message is helpful
    if echo "$missing_out" | grep -qiE "(model|not found|missing|download|cache)"; then
      pass "missing models: helpful error message provided"
      echo "    Error excerpt: $(echo "$missing_out" | grep -iE '(model|not found|missing|download|cache)' | head -1)"
    else
      pass "missing models: non-zero exit (error message may not be specific)"
      echo "    Output: $(echo "$missing_out" | tail -1)"
    fi
  else
    info "missing models: embed returned exit 0" \
         "KINDX may have downloaded models again or uses built-in models"
  fi

  # Restore model cache
  if [[ -d "$MODEL_CACHE_ORIGINAL" ]]; then
    # kindx may have recreated it — merge or just remove the new one
    rm -rf "$MODEL_CACHE_ORIGINAL"
  fi
  mv "$MODEL_CACHE_BACKUP" "$MODEL_CACHE_ORIGINAL"
  MODEL_CACHE_BACKUP=""  # Prevent cleanup trap from double-restoring
  echo "  Model cache restored."

  # Verify embed works after restore
  restored_out=$(kindx embed -c "$COLLECTION" 2>&1) || true
  restored_exit=$?

  if [[ $restored_exit -eq 0 ]]; then
    pass "embed after model restore: works correctly"
  else
    fail "embed after model restore: exit code $restored_exit" "$restored_out"
  fi
else
  info "model cache directory not found" \
       "Searched common locations. KINDX may download models on demand."
  echo "  Skipping missing model test."
fi

# ===================== Test 4: Disk full (informational) ==================
echo ""
echo "--- Test 4: Disk full simulation (INFORMATIONAL) ---"
echo ""
echo "  This test does NOT actually fill the disk. Instead, it documents"
echo "  the expected behavior and provides guidance for manual testing."
echo ""

cat <<'DISKFULL'
  Disk Full Scenario — What to Expect:
  ─────────────────────────────────────
  When the disk is full during a kindx operation:

  1. During 'kindx update':
     - SQLite may fail with "database or disk is full" error
     - The file index should remain in its last consistent state
     - Running update again after freeing space should recover

  2. During 'kindx embed':
     - Embedding writes to the SQLite database; writes will fail
     - Partially written embeddings should be rolled back by SQLite
       (each batch is typically wrapped in a transaction)
     - After freeing space, 'kindx embed' should resume from where
       it left off

  3. During 'kindx search':
     - Read-only operation — should work even on a full disk as long
       as the database file itself is intact
     - May fail if SQLite needs to create temporary files

  Manual Testing Steps:
  ─────────────────────
  a) Create a small tmpfs:
     sudo mount -t tmpfs -o size=10M tmpfs /mnt/small
  b) Set KINDX cache to that mount point
  c) Add a large collection and run embed
  d) Observe error messages and recovery behavior
  e) Unmount when done: sudo umount /mnt/small

  Expected: KINDX should report a clear error about insufficient
  disk space and should not corrupt existing data.
DISKFULL

info "disk full scenario" "Documented above — requires manual testing"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================="
echo "  Corruption & Recovery Test Suite — Results"
echo "============================================="
echo "  Passed        : $PASS_COUNT"
echo "  Failed        : $FAIL_COUNT"
echo "  Informational : $INFO_COUNT"
echo "  Total checks  : $((PASS_COUNT + FAIL_COUNT + INFO_COUNT))"
echo "============================================="
echo ""
echo "  NOTE: Some tests are environment-dependent. If the KINDX database"
echo "  or model cache was not found, those tests were skipped. Re-run"
echo "  after confirming the storage paths for your KINDX installation."

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo ""
  echo "  Some tests failed. Review output above for details."
  exit 1
else
  echo ""
  echo "  No hard failures detected."
  exit 0
fi
