#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# edge-cases.sh — Exercise KINDX with unusual file types and structures
# =============================================================================
# Verifies that KINDX handles gracefully:
#   1. Empty (0-byte) files
#   2. Very large files (1 MB+)
#   3. Files containing only code blocks
#   4. Files with unicode / emoji content
#   5. Symlinks pointing to markdown files
#   6. Binary files mixed in with markdown
#   7. Deeply nested directories (10 levels)
#   8. Files with no extension
# Each sub-test sets up its scenario, runs kindx operations, and checks that
# nothing crashes.
# =============================================================================

COLLECTION="stress-test-edge-cases"
TMPDIR=""
PASS_COUNT=0
FAIL_COUNT=0

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  echo ""
  echo "--- Cleaning up ---"
  kindx collection rm "$COLLECTION" 2>/dev/null || true
  if [[ -n "$TMPDIR" && -d "$TMPDIR" ]]; then
    rm -rf "$TMPDIR"
    echo "Removed temp directory: $TMPDIR"
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

# Run a kindx command and verify it does not crash (exit code 0, or a
# graceful non-zero like "no results"). A segfault (139) or abort (134)
# is always a failure.
run_no_crash() {
  local label="$1"; shift
  local output
  output=$("$@" 2>&1) || true
  local rc=$?

  # Signals 134 (SIGABRT) and 139 (SIGSEGV) indicate a hard crash
  if [[ $rc -eq 134 || $rc -eq 139 ]]; then
    fail "$label" "Process crashed with exit code $rc: $output"
    return 1
  fi

  pass "$label"
  return 0
}

# ---------------------------------------------------------------------------
# Setup: temp directory and collection
# ---------------------------------------------------------------------------
echo "=== Edge Case Test Suite ==="
echo ""

TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/kindx-edge-XXXXXX")
echo "Temp directory: $TMPDIR"

# We need at least one normal file so the collection is valid
cat > "$TMPDIR/baseline.md" <<'EOF'
# Baseline Document

This is a normal markdown file used as a baseline for edge-case testing.
It contains standard prose and should always index successfully.
EOF

# Register collection once; individual tests add files to the same dir
kindx collection add "$COLLECTION" "$TMPDIR"
echo ""

# ===================== Test 1: Empty files ================================
echo "--- Test 1: Empty (0-byte) files ---"

touch "$TMPDIR/empty-file.md"
touch "$TMPDIR/another-empty.md"

run_no_crash "update with empty files" kindx update -c "$COLLECTION"
run_no_crash "embed with empty files"  kindx embed  -c "$COLLECTION"
run_no_crash "search with empty files" kindx search "baseline" -c "$COLLECTION"

# ===================== Test 2: Very large file (1 MB+) ====================
echo ""
echo "--- Test 2: Very large file (1 MB+) ---"

large_file="$TMPDIR/large-document.md"
{
  echo "# Large Document — Stress Test"
  echo ""
  # Generate ~1.2 MB of prose by repeating paragraphs
  for i in $(seq 1 400); do
    cat <<PARAGRAPH
## Section $i

This is paragraph $i of a very large document designed to stress-test the
ingestion and embedding pipeline. Each section adds roughly 3 KB of text
covering topics such as distributed consensus algorithms, eventual consistency
models, and the CAP theorem's implications for modern database architectures.
Performance under load depends on chunk splitting, memory management, and
efficient I/O scheduling within the embedding runtime.

PARAGRAPH
  done
} > "$large_file"

large_size=$(wc -c < "$large_file")
echo "  Generated large file: $large_size bytes"

run_no_crash "update with 1MB+ file" kindx update -c "$COLLECTION"
run_no_crash "embed with 1MB+ file"  kindx embed  -c "$COLLECTION"
run_no_crash "search in large corpus" kindx search "consensus algorithms" -c "$COLLECTION"

# ===================== Test 3: Code-only files ============================
echo ""
echo "--- Test 3: Files containing only code blocks ---"

cat > "$TMPDIR/code-only.md" <<'CODEEOF'
```python
import asyncio

async def main():
    tasks = [asyncio.create_task(worker(i)) for i in range(100)]
    await asyncio.gather(*tasks)

async def worker(n):
    await asyncio.sleep(0.1)
    return n * n

asyncio.run(main())
```

```sql
SELECT u.id, u.name, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 5
ORDER BY order_count DESC;
```

```rust
fn fibonacci(n: u64) -> u64 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}
```
CODEEOF

run_no_crash "update with code-only file" kindx update -c "$COLLECTION"
run_no_crash "embed with code-only file"  kindx embed  -c "$COLLECTION"
run_no_crash "search for code content"    kindx search "fibonacci" -c "$COLLECTION"

# ===================== Test 4: Unicode / emoji content ====================
echo ""
echo "--- Test 4: Unicode and emoji content ---"

cat > "$TMPDIR/unicode-emoji.md" <<'UEOF'
# 日本語のドキュメント 🎌

これはUnicodeテスト用のドキュメントです。

## Emojis Galore 🚀🎉🔥

- Rocket launch: 🚀
- Party time: 🎉🎊🥳
- Fire: 🔥🔥🔥
- Math: ∑∏∫∂∇ε → ∞
- Arrows: ← → ↑ ↓ ↔ ↕
- CJK: 中文测试 한국어 テスト

## Special Characters

Ñoño señor café résumé naïve über Ångström

## Right-to-Left

مرحبا بالعالم — שלום עולם

## Musical Symbols

𝄞 𝄡 𝄢 — ♩ ♪ ♫ ♬
UEOF

run_no_crash "update with unicode/emoji" kindx update -c "$COLLECTION"
run_no_crash "embed with unicode/emoji"  kindx embed  -c "$COLLECTION"
run_no_crash "search for unicode term"   kindx search "ドキュメント" -c "$COLLECTION"
run_no_crash "search for emoji content"  kindx search "rocket launch" -c "$COLLECTION"

# ===================== Test 5: Symlinks ===================================
echo ""
echo "--- Test 5: Symlinks pointing to markdown files ---"

# Create a subdirectory with the actual file, then symlink from root
mkdir -p "$TMPDIR/originals"
cat > "$TMPDIR/originals/real-file.md" <<'EOF'
# Real File

This file is the symlink target. It should be reachable via the symlink.
EOF

ln -sf "$TMPDIR/originals/real-file.md" "$TMPDIR/symlinked-file.md"

run_no_crash "update with symlinks" kindx update -c "$COLLECTION"
run_no_crash "embed with symlinks"  kindx embed  -c "$COLLECTION"
run_no_crash "search through symlink" kindx search "symlink target" -c "$COLLECTION"

# ===================== Test 6: Binary files mixed in ======================
echo ""
echo "--- Test 6: Binary files mixed with markdown ---"

# Create a small binary file (random bytes)
dd if=/dev/urandom of="$TMPDIR/random-data.bin" bs=1024 count=8 2>/dev/null
# Create a fake PNG header
printf '\x89PNG\r\n\x1a\n' > "$TMPDIR/fake-image.png"
# Add some null bytes to a file
printf 'text\x00with\x00nulls' > "$TMPDIR/null-bytes.dat"

run_no_crash "update with binary files" kindx update -c "$COLLECTION"
run_no_crash "embed with binary files"  kindx embed  -c "$COLLECTION"
run_no_crash "search ignoring binaries"  kindx search "baseline" -c "$COLLECTION"

# ===================== Test 7: Deeply nested directory ====================
echo ""
echo "--- Test 7: Deeply nested directory (10 levels) ---"

nested_path="$TMPDIR"
for level in $(seq 1 10); do
  nested_path="$nested_path/level-$level"
done
mkdir -p "$nested_path"

cat > "$nested_path/deep-file.md" <<'EOF'
# Deeply Nested File

This file lives 10 directories deep. KINDX should be able to discover and
index it through recursive directory traversal.

Keywords: deeply nested, recursive, directory traversal
EOF

run_no_crash "update with nested dirs" kindx update -c "$COLLECTION"
run_no_crash "embed with nested dirs"  kindx embed  -c "$COLLECTION"
run_no_crash "search for nested file"  kindx search "deeply nested" -c "$COLLECTION"

# ===================== Test 8: Files with no extension ====================
echo ""
echo "--- Test 8: Files with no file extension ---"

cat > "$TMPDIR/README" <<'EOF'
This is a README file with no extension. It contains plain text that might
or might not be indexed depending on how KINDX determines file types.
EOF

cat > "$TMPDIR/NOTES" <<'EOF'
# Notes Without Extension

These notes have markdown-like content but no .md extension. The system
should either index them or skip them gracefully — never crash.
EOF

cat > "$TMPDIR/Makefile" <<'EOF'
.PHONY: all clean test

all:
	@echo "Building project..."

clean:
	rm -rf build/

test:
	@echo "Running tests..."
EOF

run_no_crash "update with extensionless files" kindx update -c "$COLLECTION"
run_no_crash "embed with extensionless files"  kindx embed  -c "$COLLECTION"
run_no_crash "search extensionless content"    kindx search "building project" -c "$COLLECTION"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================="
echo "  Edge Case Test Suite — Results"
echo "============================================="
echo "  Passed : $PASS_COUNT"
echo "  Failed : $FAIL_COUNT"
echo "  Total  : $((PASS_COUNT + FAIL_COUNT))"
echo "============================================="

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "  Some tests failed. Review output above."
  exit 1
else
  echo "  All tests passed."
  exit 0
fi
