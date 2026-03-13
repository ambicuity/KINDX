#!/usr/bin/env bash
set -euo pipefail

# KINDX setup — install and register eval corpus
# Assumes Node.js >= 18 is installed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_DIR="$(cd "$SCRIPT_DIR/../../../specs/eval-docs" && pwd)"

echo "=== KINDX Setup ==="

# Step 1: Install KINDX globally (skip if already installed)
if ! command -v kindx &>/dev/null; then
  echo "[1/3] Installing KINDX..."
  npm install -g @ambicuity/kindx
else
  echo "[1/3] KINDX already installed: $(kindx --version)"
fi

# Step 2: Register eval-docs as a collection
echo "[2/3] Registering eval corpus as collection 'eval-bench'..."
kindx collection add eval-bench "$CORPUS_DIR" --name eval-bench 2>/dev/null || true

# Step 3: Build embeddings
echo "[3/3] Building embeddings (this downloads the model on first run)..."
kindx embed -c eval-bench

echo "=== KINDX setup complete ==="
