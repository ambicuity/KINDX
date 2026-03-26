#!/usr/bin/env bash
set -euo pipefail

# Khoj teardown — stop and remove Docker container
echo "=== Khoj Teardown ==="
if command -v docker &>/dev/null; then
  docker stop khoj 2>/dev/null || true
  docker rm khoj 2>/dev/null || true
  echo "Khoj container stopped and removed."
else
  echo "Docker not found; manual cleanup may be needed if using pip install."
fi
