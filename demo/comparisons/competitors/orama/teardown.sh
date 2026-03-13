#!/usr/bin/env bash
set -euo pipefail

# Orama teardown — remove node_modules
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Orama Teardown ==="
rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json"
echo "Node modules removed."
