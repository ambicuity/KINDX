#!/usr/bin/env bash
# =============================================================================
# KINDX Agent Output Formats Demo
# =============================================================================
#
# KINDX supports multiple structured output formats designed for consumption
# by scripts, agents, and downstream tools. This demo shows every format
# using the same query so you can compare them side by side.
#
# Prerequisites:
#   - kindx is installed and on your PATH
#   - At least one collection is registered and indexed
#
# Usage:
#   bash demo/cli-demos/agent-output-formats.sh
# =============================================================================

set -euo pipefail

QUERY="API design"

# ---------------------------------------------------------------------------
# JSON output (--json)
# ---------------------------------------------------------------------------
# Returns a JSON array of result objects. Ideal for programmatic consumption,
# piping into jq, or feeding into LLM tool-call responses.

echo "=== JSON output ==="
echo "Use --json when your consumer expects structured data (APIs, agents, jq)."
echo ""

kindx search "$QUERY" --json

echo ""
echo ""

# ---------------------------------------------------------------------------
# CSV output (--csv)
# ---------------------------------------------------------------------------
# Returns comma-separated values with a header row. Useful for importing into
# spreadsheets, databases, or data-analysis pipelines.

echo "=== CSV output ==="
echo "Use --csv for spreadsheet import, database loading, or tabular analysis."
echo ""

kindx search "$QUERY" --csv

echo ""
echo ""

# ---------------------------------------------------------------------------
# XML output (--xml)
# ---------------------------------------------------------------------------
# Returns well-formed XML with <results> and <result> elements. Suitable for
# systems that consume XML, XSLT transforms, or legacy integrations.

echo "=== XML output ==="
echo "Use --xml for XML-based pipelines, XSLT transforms, or legacy systems."
echo ""

kindx search "$QUERY" --xml

echo ""
echo ""

# ---------------------------------------------------------------------------
# Files-only output (--files)
# ---------------------------------------------------------------------------
# Returns one file path per line with no metadata. Designed for shell pipelines
# such as xargs, while-read loops, or editor integrations.

echo "=== Files-only output ==="
echo "Use --files for shell pipelines: kindx search 'query' --files | xargs cat"
echo ""

kindx search "$QUERY" --files

echo ""
echo ""

# ---------------------------------------------------------------------------
# Markdown output (--markdown)
# ---------------------------------------------------------------------------
# Returns results formatted as a Markdown document with headings, scores, and
# code-fenced snippets. Great for rendering in chat UIs or documentation.

echo "=== Markdown output ==="
echo "Use --markdown for chat UIs, documentation, or human-readable reports."
echo ""

kindx search "$QUERY" --markdown

echo ""
echo "=== Format demo complete ==="
