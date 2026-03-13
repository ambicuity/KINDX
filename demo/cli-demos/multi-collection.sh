#!/usr/bin/env bash
# =============================================================================
# KINDX Multi-Collection Demo
# =============================================================================
#
# KINDX supports multiple collections, each pointing to a different directory.
# You can search across all collections at once or target a specific one.
# This demo shows how to register several collections and query them
# independently or together.
#
# Prerequisites:
#   - kindx is installed and on your PATH
#   - Directories ~/projects/docs and ~/notes exist with content
#
# Usage:
#   bash demo/cli-demos/multi-collection.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Step 1: Register multiple collections
# ---------------------------------------------------------------------------
# Each collection gets a short name and maps to a directory on disk.

echo "=== Step 1: Register collections ==="
echo ""

echo "Adding 'docs' collection from ~/projects/docs..."
kindx collection add ~/projects/docs --name docs
echo ""

echo "Adding 'notes' collection from ~/notes..."
kindx collection add ~/notes --name notes
echo ""

# ---------------------------------------------------------------------------
# Step 2: Index and embed both collections
# ---------------------------------------------------------------------------

echo "=== Step 2: Index and embed ==="
echo ""

echo "Updating all collections..."
kindx update
echo ""

echo "Embedding all collections..."
kindx embed
echo ""

# ---------------------------------------------------------------------------
# Step 3: List registered collections
# ---------------------------------------------------------------------------

echo "=== Step 3: List collections ==="
echo ""

kindx collection list

echo ""

# ---------------------------------------------------------------------------
# Step 4: Search across all collections
# ---------------------------------------------------------------------------
# When no -c flag is provided, KINDX searches every registered collection
# and merges the results by score.

echo "=== Step 4: Search across all collections ==="
echo "Searching all collections for 'authentication flow'..."
echo ""

kindx search "authentication flow"

echo ""

# ---------------------------------------------------------------------------
# Step 5: Search a specific collection
# ---------------------------------------------------------------------------
# Use -c to restrict the search to a single collection.

echo "=== Step 5: Search a specific collection ==="
echo "Searching only 'docs' for 'authentication flow'..."
echo ""

kindx search "authentication flow" -c docs

echo ""

# ---------------------------------------------------------------------------
# Step 6: List documents in each collection
# ---------------------------------------------------------------------------
# The 'ls' command lists all indexed documents in a collection.

echo "=== Step 6: List documents per collection ==="
echo ""

echo "--- Documents in 'docs' ---"
kindx ls docs
echo ""

echo "--- Documents in 'notes' ---"
kindx ls notes
echo ""

# ---------------------------------------------------------------------------
# Step 7: Cross-collection hybrid query
# ---------------------------------------------------------------------------
# Hybrid queries also work across all collections by default.

echo "=== Step 7: Cross-collection hybrid query ==="
echo "Running hybrid query across all collections..."
echo ""

kindx query "how does the authentication middleware work"

echo ""
echo "=== Multi-collection demo complete ==="
echo "Use -c to target a collection, or omit it to search everywhere."
