#!/usr/bin/env bash
set -euo pipefail

# Khoj setup — Docker-based deployment
# Khoj requires a running server (Docker or pip install khoj[local])
# Sources:
#   - https://docs.khoj.dev/get-started/setup/
#   - https://github.com/khoj-ai/khoj (33.4k stars)

echo "=== Khoj Setup ==="
echo "Khoj is a server-based tool requiring Docker or pip install."
echo ""
echo "Option A: Docker (recommended)"
echo "  docker pull ghcr.io/khoj-ai/khoj:latest"
echo "  docker run -d -p 42110:42110 --name khoj ghcr.io/khoj-ai/khoj:latest"
echo ""
echo "Option B: pip"
echo "  pip install 'khoj[local]'"
echo "  khoj --anonymous-mode"
echo ""

KHOJ_URL="${KHOJ_URL:-http://localhost:42110}"

# Try Docker first
if command -v docker &>/dev/null; then
  if docker ps --format '{{.Names}}' | grep -q '^khoj$'; then
    echo "[OK] Khoj container already running."
  else
    echo "[1/3] Pulling Khoj Docker image..."
    docker pull ghcr.io/khoj-ai/khoj:latest

    echo "[2/3] Starting Khoj server..."
    docker run -d -p 42110:42110 \
      --name khoj \
      -e KHOJ_ANONYMOUS_MODE=true \
      ghcr.io/khoj-ai/khoj:latest

    echo "[3/3] Waiting for Khoj to be ready..."
    for i in $(seq 1 30); do
      if curl -sf "$KHOJ_URL/api/health" >/dev/null 2>&1; then
        echo "  Khoj ready after ${i}s"
        break
      fi
      sleep 1
    done
  fi
else
  echo "WARNING: Docker not found. Install Docker or use pip install 'khoj[local]'."
  echo "Skipping automated setup."
fi

echo "=== Khoj setup complete ==="
