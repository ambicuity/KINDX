#!/usr/bin/env bash
set -euo pipefail

# PrivateGPT teardown — stop server and clean up
echo "=== PrivateGPT Teardown ==="
PRIVATEGPT_DIR="${PRIVATEGPT_DIR:-/tmp/privategpt}"

# Kill PrivateGPT process if running
pkill -f "private_gpt" 2>/dev/null || true
pkill -f "privategpt" 2>/dev/null || true

# Clean up cloned repo
if [ -d "$PRIVATEGPT_DIR" ] && [ "$PRIVATEGPT_DIR" = "/tmp/privategpt" ]; then
  rm -rf "$PRIVATEGPT_DIR"
  echo "PrivateGPT directory removed."
fi

echo "PrivateGPT stopped and cleaned up."
