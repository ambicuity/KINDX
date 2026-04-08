#!/usr/bin/env bash
set -euo pipefail

# LocalGPT setup — git clone + pip install + Ollama
# Sources:
#   - https://github.com/PromtEngineer/localGPT (21.9k stars, MIT)

echo "=== LocalGPT Setup ==="
echo "LocalGPT requires: git clone, pip install, Ollama, and model downloads."
echo ""

LOCALGPT_DIR="${LOCALGPT_DIR:-/tmp/localgpt}"
LOCALGPT_URL="${LOCALGPT_URL:-http://localhost:5111}"

if [ -d "$LOCALGPT_DIR" ]; then
  echo "[OK] LocalGPT directory exists at $LOCALGPT_DIR"
else
  echo "[1/5] Cloning LocalGPT..."
  git clone https://github.com/PromtEngineer/localGPT.git "$LOCALGPT_DIR"
fi

cd "$LOCALGPT_DIR"

echo "[2/5] Installing Python dependencies..."
pip install -r requirements.txt 2>/dev/null || {
  echo "  WARNING: pip install failed. Some dependencies may be missing."
}

echo "[3/5] Checking Ollama..."
if ! command -v ollama &>/dev/null; then
  echo "  WARNING: Ollama not installed. Required for local inference."
  echo "  Install: curl -fsSL https://ollama.com/install.sh | sh"
fi

echo "[4/5] Pulling required models..."
if command -v ollama &>/dev/null; then
  ollama pull qwen3:0.6b 2>/dev/null || true
fi

echo "[5/5] Installing frontend (optional)..."
if [ -d "frontend" ]; then
  cd frontend && npm install 2>/dev/null || true
  cd ..
fi

echo ""
echo "Setup friction summary:"
echo "  - git clone the repo"
echo "  - pip install -r requirements.txt"
echo "  - Install Ollama separately"
echo "  - Pull models (600MB+ each)"
echo "  - Optional: npm install for frontend"
echo "  - Start: python run_system.py"
echo "  Total: 5-6 steps, 10-20 minutes, 8GB+ RAM needed"
echo "=== LocalGPT setup complete ==="
