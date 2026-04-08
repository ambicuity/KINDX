#!/usr/bin/env bash
set -euo pipefail

# LanceDB setup — install Python packages
echo "=== LanceDB Setup ==="
echo "[1/1] Installing lancedb and sentence-transformers..."
pip install lancedb sentence-transformers >/dev/null 2>&1
echo "LanceDB $(pip show lancedb | grep Version | cut -d' ' -f2) installed."
echo "=== LanceDB setup complete ==="
