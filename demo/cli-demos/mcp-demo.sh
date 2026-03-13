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

MCP_PORT=3100
MCP_BASE="http://localhost:${MCP_PORT}"

# ---------------------------------------------------------------------------
# Step 1: Start the MCP server
# ---------------------------------------------------------------------------
# The --http flag starts an HTTP transport (rather than stdio). The --daemon
# flag backgrounds the process so the script can continue.

echo "=== Step 1: Start MCP server ==="
echo "Starting KINDX MCP server on port ${MCP_PORT}..."
echo ""

kindx mcp --http --daemon

echo ""
echo "Server is running in the background."
echo ""

# Give the server a moment to initialize.
sleep 2

# ---------------------------------------------------------------------------
# Step 2: Check server status
# ---------------------------------------------------------------------------
# The 'mcp status' subcommand reports whether the server is running, which
# port it is bound to, and how many collections are available.

echo "=== Step 2: Check MCP server status ==="
echo ""

kindx mcp status

echo ""

# ---------------------------------------------------------------------------
# Step 3: Call the search tool via curl
# ---------------------------------------------------------------------------
# MCP tools are invoked by posting a JSON-RPC request to the server. Here we
# call the "search" tool with a natural-language query.

echo "=== Step 3: Call MCP search tool via curl ==="
echo "Sending a search request to the MCP server..."
echo ""

curl -s -X POST "${MCP_BASE}/mcp" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search",
      "arguments": {
        "query": "API design patterns",
        "limit": 3
      }
    }
  }' | jq .

echo ""

# ---------------------------------------------------------------------------
# Step 4: Call the get tool via curl
# ---------------------------------------------------------------------------
# The "get" tool retrieves a specific document by its kindx:// URI.

echo "=== Step 4: Call MCP get tool via curl ==="
echo "Retrieving a document through the MCP server..."
echo ""

curl -s -X POST "${MCP_BASE}/mcp" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get",
      "arguments": {
        "uri": "kindx://docs/api-design.md"
      }
    }
  }' | jq .

echo ""

# ---------------------------------------------------------------------------
# Step 5: Stop the MCP server
# ---------------------------------------------------------------------------

echo "=== Step 5: Stop MCP server ==="
echo "Shutting down the MCP server..."
echo ""

kindx mcp stop

echo ""
echo "=== MCP demo complete ==="
echo "The MCP server exposes KINDX tools to any MCP-compatible client."
