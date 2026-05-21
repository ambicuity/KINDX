#!/usr/bin/env bash
set -euo pipefail

echo "=== KINDX warm-daemon teardown ==="
kindx mcp stop 2>/dev/null || true
echo "Daemon stopped."
