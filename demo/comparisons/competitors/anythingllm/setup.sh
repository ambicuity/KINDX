#!/usr/bin/env bash
set -euo pipefail

# AnythingLLM setup — Docker-based deployment
# AnythingLLM is primarily a desktop app or Docker service
# Sources:
#   - https://github.com/Mintplex-Labs/anything-llm (56.2k stars)
#   - https://docs.useanything.com/features/vector-databases
#   - https://docs.anythingllm.com/mcp-compatibility/overview

echo "=== AnythingLLM Setup ==="
echo "AnythingLLM is a desktop app / Docker service with web UI."
echo ""

ANYTHINGLLM_URL="${ANYTHINGLLM_URL:-http://localhost:3001}"

if command -v docker &>/dev/null; then
  if docker ps --format '{{.Names}}' | grep -q '^anythingllm$'; then
    echo "[OK] AnythingLLM container already running."
  else
    echo "[1/3] Pulling AnythingLLM Docker image..."
    docker pull mintplexlabs/anythingllm:latest

    echo "[2/3] Starting AnythingLLM..."
    docker run -d -p 3001:3001 \
      --name anythingllm \
      -v "${HOME}/.anythingllm:/app/server/storage" \
      mintplexlabs/anythingllm:latest

    echo "[3/3] Waiting for AnythingLLM to be ready..."
    for i in $(seq 1 60); do
      if curl -sf "$ANYTHINGLLM_URL/api/ping" >/dev/null 2>&1; then
        echo "  AnythingLLM ready after ${i}s"
        break
      fi
      sleep 1
    done
  fi
else
  echo "WARNING: Docker not found."
  echo "Alternative: Download desktop app from https://anythingllm.com/download"
  echo "Skipping automated setup."
fi

echo ""
echo "NOTE: AnythingLLM requires manual workspace creation and document upload"
echo "through the web UI at $ANYTHINGLLM_URL before testing."
echo "=== AnythingLLM setup complete ==="
