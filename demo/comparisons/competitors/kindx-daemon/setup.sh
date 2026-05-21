#!/usr/bin/env bash
set -euo pipefail

# KINDX warm-daemon setup — runs KINDX as a long-lived HTTP server so per-query
# latency reflects warm model residency rather than CLI cold-start (which dominates
# in the plain `kindx` competitor).
#
# Uses an isolated INDEX_PATH so it doesn't touch the user's main index, and a
# fixed token so the test script can authenticate.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_DIR="$(cd "$SCRIPT_DIR/../../../../specs/eval-docs" && pwd)"

export INDEX_PATH="${INDEX_PATH:-/tmp/kindx-eval-bench/index.sqlite}"
export KINDX_CONFIG_DIR="${KINDX_CONFIG_DIR:-/tmp/kindx-eval-bench/config}"
export KINDX_MCP_TOKEN="${KINDX_MCP_TOKEN:-kindx-bench-token}"
export KINDX_MCP_PORT="${KINDX_MCP_PORT:-8181}"

mkdir -p "$(dirname "$INDEX_PATH")" "$KINDX_CONFIG_DIR"

echo "=== KINDX warm-daemon setup ==="
echo "  INDEX_PATH=$INDEX_PATH"
echo "  KINDX_CONFIG_DIR=$KINDX_CONFIG_DIR"
echo "  KINDX_MCP_PORT=$KINDX_MCP_PORT"

# Step 1: register corpus in the isolated index (idempotent)
echo "[1/3] Registering eval corpus..."
kindx collection add "$CORPUS_DIR" --name eval-bench 2>/dev/null || true

# Step 2: embed (uses cached GGUF models; ~1s for 6 docs)
echo "[2/3] Embedding (uses cached models)..."
kindx embed

# Step 3: start daemon — exits the previous one if already running
echo "[3/3] Starting HTTP daemon on port $KINDX_MCP_PORT..."
kindx mcp stop >/dev/null 2>&1 || true
# Daemon runs detached. Wait for /health to respond.
nohup kindx mcp --http --port "$KINDX_MCP_PORT" --daemon >/tmp/kindx-mcp-daemon.log 2>&1 &
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${KINDX_MCP_PORT}/health" >/dev/null 2>&1; then
    echo "  Daemon ready after ${i}s"
    break
  fi
  sleep 1
done

# Warm the models with one throwaway query so the first benchmarked query
# does not eat model-load cost.
echo "  Warming models..."
curl -sf -X POST "http://127.0.0.1:${KINDX_MCP_PORT}/query" \
  -H "Authorization: Bearer $KINDX_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"searches":[{"type":"hyde","query":"warmup"}],"collections":["eval-bench"],"limit":1}' \
  >/dev/null

echo "=== KINDX warm-daemon setup complete ==="
