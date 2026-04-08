#!/usr/bin/env bash
set -euo pipefail

# LanceDB teardown — remove temp database
echo "=== LanceDB Teardown ==="
rm -rf /tmp/lancedb-eval-bench
echo "Temp database removed."
