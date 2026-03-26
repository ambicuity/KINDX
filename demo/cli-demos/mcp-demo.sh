#!/usr/bin/env bash
# =============================================================================
# KINDX MCP Server Demo
# =============================================================================
#
# KINDX can run as a Model Context Protocol (MCP) server, exposing its search
# and retrieval capabilities as tools that any MCP-compatible client (Claude
# Desktop, Cursor, custom agents) can call over HTTP.
#
# This demo starts the MCP server, checks its status, calls tools via curl,
# and then shuts it down.
#
# Prerequisites:
#   - kindx is installed and on your PATH
#   - At least one collection is registered, indexed, and embedded
#   - curl and jq are available
#
# Usage:
#   bash demo/cli-demos/mcp-demo.sh
# =============================================================================

set -euo pipefail

MCP_PORT=8181
MCP_BASE="http://localhost:${MCP_PORT}"
SESSION_HEADERS="$(mktemp)"

cleanup() {
  rm -f "$SESSION_HEADERS"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 1: Start the MCP server
# ---------------------------------------------------------------------------
# The --http flag starts an HTTP transport (rather than stdio). The --daemon
# flag backgrounds the process so the script can continue.

echo "=== Step 1: Start MCP server ==="
echo "Starting KINDX MCP server on port ${MCP_PORT}..."
echo ""

kindx mcp --http --daemon --port "${MCP_PORT}"

echo ""
echo "Server is running in the background."
echo ""

# Wait for the server to initialize.
echo "Waiting for the MCP HTTP endpoint to become ready..."
for _ in $(seq 1 20); do
  if curl -fsS "${MCP_BASE}/health" >/dev/null; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "${MCP_BASE}/health" >/dev/null; then
  echo "MCP server did not become ready within 10 seconds."
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Check server health
# ---------------------------------------------------------------------------
# The HTTP transport exposes a /health endpoint for liveness checks.

echo "=== Step 2: Check MCP server health ==="
echo ""

curl -sS "${MCP_BASE}/health" | jq .

echo ""

# ---------------------------------------------------------------------------
# Step 3: Initialize an MCP session
# ---------------------------------------------------------------------------
# MCP Streamable HTTP starts with an initialize request and returns an
# mcp-session-id header that subsequent requests reuse.

echo "=== Step 3: Initialize MCP session ==="
echo ""

init_response=$(curl -sS -D "${SESSION_HEADERS}" -X POST "${MCP_BASE}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "kindx-demo-script",
        "version": "1.0.0"
      }
    }
  }')

echo "${init_response}" | jq .
echo ""

SESSION_ID=$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {print $2}' "${SESSION_HEADERS}" | tr -d '\r')
if [[ -z "${SESSION_ID}" ]]; then
  echo "Initialize response did not include an mcp-session-id header."
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 4: Call the query tool via curl
# ---------------------------------------------------------------------------
# The query tool accepts one or more typed sub-queries (lex/vec/hyde).

echo "=== Step 4: Call MCP query tool via curl ==="
echo "Sending a hybrid query request to the MCP server..."
echo ""

query_response=$(curl -sS -X POST "${MCP_BASE}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: ${SESSION_ID}" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "query",
      "arguments": {
        "searches": [
          {
            "type": "lex",
            "query": "API design patterns"
          }
        ],
        "limit": 3
      }
    }
  }')

echo "${query_response}" | jq .

echo ""

# ---------------------------------------------------------------------------
# Step 5: Call the get tool via curl
# ---------------------------------------------------------------------------
# The get tool retrieves a specific document by its relative display path
# or docid. Here we pull the top file from the query response.

echo "=== Step 5: Call MCP get tool via curl ==="

first_file=$(echo "${query_response}" | jq -r '.result.structuredContent.results[0].file // empty')
if [[ -z "${first_file}" ]]; then
  echo "No file was returned from the query response; skipping get call."
  echo ""
else
  echo "Retrieving ${first_file} through the MCP server..."
  echo ""

  curl -sS -X POST "${MCP_BASE}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: ${SESSION_ID}" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 3,
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"get\",
        \"arguments\": {
          \"file\": \"${first_file}\"
        }
      }
    }" | jq .

  echo ""
fi

# ---------------------------------------------------------------------------
# Step 6: Stop the MCP server
# ---------------------------------------------------------------------------

echo "=== Step 6: Stop MCP server ==="
echo "Shutting down the MCP server..."
echo ""

kindx mcp stop

echo ""
echo "=== MCP demo complete ==="
echo "The MCP server exposes KINDX tools to any MCP-compatible client."
