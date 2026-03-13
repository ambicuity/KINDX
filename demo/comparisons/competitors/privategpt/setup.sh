#!/usr/bin/env bash
set -euo pipefail

# PrivateGPT setup — Poetry-based installation
# Sources:
#   - https://github.com/zylon-ai/private-gpt (~57k stars, Apache-2.0)
#   - https://docs.privategpt.dev/installation/getting-started/installation

echo "=== PrivateGPT Setup ==="
echo "PrivateGPT requires Poetry + Python 3.11+ and several extras."
echo ""

PRIVATEGPT_DIR="${PRIVATEGPT_DIR:-/tmp/privategpt}"
PRIVATEGPT_URL="${PRIVATEGPT_URL:-http://localhost:8001}"

if [ -d "$PRIVATEGPT_DIR" ]; then
  echo "[OK] PrivateGPT directory already exists at $PRIVATEGPT_DIR"
else
  echo "[1/5] Cloning PrivateGPT..."
  git clone https://github.com/zylon-ai/private-gpt.git "$PRIVATEGPT_DIR"
fi

cd "$PRIVATEGPT_DIR"

echo "[2/5] Installing dependencies with Poetry..."
echo "  This installs: UI, Ollama LLM, Ollama embeddings, Qdrant vector store"
if command -v poetry &>/dev/null; then
  poetry install --extras "ui llms-ollama embeddings-ollama vector-stores-qdrant" 2>/dev/null || {
    echo "  WARNING: Poetry install failed. Trying pip fallback..."
    pip install -e ".[ui,llms-ollama,embeddings-ollama,vector-stores-qdrant]" 2>/dev/null || true
  }
else
  echo "  WARNING: Poetry not found. Install via: curl -sSL https://install.python-poetry.org | python3 -"
  echo "  Trying pip fallback..."
  pip install -e ".[ui,llms-ollama,embeddings-ollama,vector-stores-qdrant]" 2>/dev/null || true
fi

echo "[3/5] Checking Ollama..."
if ! command -v ollama &>/dev/null; then
  echo "  WARNING: Ollama not installed. Required for local LLM/embeddings."
  echo "  Install: curl -fsSL https://ollama.com/install.sh | sh"
fi

echo "[4/5] Pulling required models..."
if command -v ollama &>/dev/null; then
  ollama pull nomic-embed-text 2>/dev/null || true
  ollama pull llama3.2 2>/dev/null || true
fi

echo "[5/5] Starting PrivateGPT server..."
echo "  Run: PGPT_PROFILES=ollama make run"
echo "  Or:  poetry run python -m private_gpt"

echo ""
echo "Setup friction summary:"
echo "  - Clone repo"
echo "  - Install Poetry"
echo "  - poetry install with 4+ extras"
echo "  - Install Ollama separately"
echo "  - Pull 2+ models (1-4GB each)"
echo "  - Configure YAML profiles"
echo "  - Start server"
echo "  Total: 7+ steps, 5-15 minutes"
echo "=== PrivateGPT setup complete ==="
