#!/usr/bin/env bash
set -euo pipefail

# KINDX teardown — remove eval collection
echo "=== KINDX Teardown ==="
kindx collection remove eval-bench 2>/dev/null || true
echo "Collection 'eval-bench' removed."
