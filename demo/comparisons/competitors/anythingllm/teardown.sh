#!/usr/bin/env bash
set -euo pipefail

# AnythingLLM teardown — stop and remove Docker container
echo "=== AnythingLLM Teardown ==="
if command -v docker &>/dev/null; then
  docker stop anythingllm 2>/dev/null || true
  docker rm anythingllm 2>/dev/null || true
  echo "AnythingLLM container stopped and removed."
else
  echo "Docker not found; stop AnythingLLM desktop app manually."
fi
