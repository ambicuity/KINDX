#!/usr/bin/env bash
# =============================================================================
# KINDX Basic Workflow Demo
# =============================================================================
#
# This script demonstrates the core KINDX workflow from registering a
# collection through searching, querying, and retrieving documents.
#
# Prerequisites:
#   - kindx is installed and on your PATH
#   - A directory ~/notes exists with markdown or text files
#
# Usage:
#   bash demo/cli-demos/basic-workflow.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Step 1: Register a collection
# ---------------------------------------------------------------------------
# A collection is a named reference to a directory of documents. KINDX tracks
# the directory and keeps an index of its contents.

echo "=== Step 1: Register a collection ==="
echo "Registering ~/notes as 'my-notes'..."
echo ""

kindx collection add ~/notes --name my-notes

echo ""
echo "Collection 'my-notes' is now registered. KINDX will watch this directory"
echo "for changes and keep its index up to date."
echo ""

# ---------------------------------------------------------------------------
# Step 2: Scan and index the collection
# ---------------------------------------------------------------------------
# The 'update' command scans the collection directory, detects new or changed
# files, and builds the BM25 full-text index.

echo "=== Step 2: Scan and index ==="
echo "Scanning and indexing 'my-notes'..."
echo ""

kindx update -c my-notes

echo ""
echo "All documents in ~/notes are now indexed for keyword search."
echo ""

# ---------------------------------------------------------------------------
# Step 3: Embed documents for vector search
# ---------------------------------------------------------------------------
# The 'embed' command generates vector embeddings for every document in the
# collection, enabling semantic (meaning-based) search.

echo "=== Step 3: Embed documents ==="
echo "Generating vector embeddings for all pending collections (including 'my-notes')..."
echo ""

kindx embed

echo ""
echo "Embeddings are stored locally. Vector search is now available."
echo "KINDX embeds every collection with pending changes, not just one collection."
echo ""

# ---------------------------------------------------------------------------
# Step 4: BM25 keyword search
# ---------------------------------------------------------------------------
# BM25 search uses term frequency to find documents that match specific
# keywords. It works best when you know the exact terms to look for.

echo "=== Step 4: BM25 keyword search ==="
echo "Searching for 'meeting action items' using BM25..."
echo ""

kindx search "meeting action items" -c my-notes

echo ""
echo "BM25 results are ranked by term frequency and document relevance."
echo ""

# ---------------------------------------------------------------------------
# Step 5: Vector (semantic) search
# ---------------------------------------------------------------------------
# Vector search finds documents by meaning rather than exact keywords. It can
# surface relevant results even when the wording differs from the query.

echo "=== Step 5: Vector search ==="
echo "Searching for 'decisions about deployment strategy' using vector search..."
echo ""

kindx vsearch "decisions about deployment strategy" -c my-notes

echo ""
echo "Vector search returns results ranked by cosine similarity to the query."
echo ""

# ---------------------------------------------------------------------------
# Step 6: Hybrid query
# ---------------------------------------------------------------------------
# The 'query' command combines BM25 and vector search, merging their results
# with reciprocal rank fusion. This typically gives the best overall relevance.

echo "=== Step 6: Hybrid query ==="
echo "Running hybrid query: 'what did we decide about the database migration'..."
echo ""

kindx query "what did we decide about the database migration" -c my-notes

echo ""
echo "Hybrid queries blend keyword precision with semantic understanding."
echo ""

# ---------------------------------------------------------------------------
# Step 7: Retrieve a specific document
# ---------------------------------------------------------------------------
# The 'get' command fetches a document by its virtual path (kindx:// URI).
# This is useful when you already know which document you want.

echo "=== Step 7: Get a specific document ==="
echo "Retrieving kindx://my-notes/standup.md..."
echo ""

kindx get kindx://my-notes/standup.md

echo ""

# ---------------------------------------------------------------------------
# Step 8: Check system status
# ---------------------------------------------------------------------------
# The 'status' command shows an overview of all registered collections, index
# health, embedding coverage, and storage usage.

echo "=== Step 8: System status ==="
echo "Checking KINDX status..."
echo ""

kindx status

echo ""
echo "=== Demo complete ==="
echo "You now know the core KINDX workflow: register, index, embed, search."
