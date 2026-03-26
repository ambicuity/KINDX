#!/usr/bin/env bash
set -euo pipefail

# ChromaDB setup — install Python package
echo "=== ChromaDB Setup ==="
echo "[1/1] Installing chromadb..."
pip install chromadb >/dev/null 2>&1
echo "ChromaDB $(pip show chromadb | grep Version | cut -d' ' -f2) installed."
echo "=== ChromaDB setup complete ==="
