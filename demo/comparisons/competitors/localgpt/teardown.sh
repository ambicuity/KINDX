#!/usr/bin/env bash
set -euo pipefail

# LocalGPT teardown
echo "=== LocalGPT Teardown ==="
LOCALGPT_DIR="${LOCALGPT_DIR:-/tmp/localgpt}"

pkill -f "run_system.py" 2>/dev/null || true

if [ -d "$LOCALGPT_DIR" ] && [ "$LOCALGPT_DIR" = "/tmp/localgpt" ]; then
  rm -rf "$LOCALGPT_DIR"
  echo "LocalGPT directory removed."
fi

echo "LocalGPT stopped and cleaned up."
