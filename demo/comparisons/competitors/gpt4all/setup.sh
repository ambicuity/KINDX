#!/usr/bin/env bash
set -euo pipefail

# GPT4All LocalDocs setup
# GPT4All is primarily a desktop application — programmatic testing is very limited
# Sources:
#   - https://github.com/nomic-ai/gpt4all (76.9k stars, MIT)
#   - https://docs.gpt4all.io/index.html
#   - https://github.com/nomic-ai/gpt4all/wiki/LocalDocs

echo "=== GPT4All LocalDocs Setup ==="
echo ""
echo "GPT4All is a DESKTOP APPLICATION. Programmatic testing is extremely limited."
echo ""
echo "Options:"
echo "  1. Desktop app: Download from https://www.nomic.ai/gpt4all"
echo "     - Install → Settings → LocalDocs → Add folder → Wait for indexing"
echo "     - No API, no CLI for retrieval — search via chat only"
echo ""
echo "  2. Python SDK (limited):"
echo "     pip install gpt4all"
echo "     - Provides chat/completion, NOT direct retrieval testing"
echo "     - No search API, no vector query, no BM25"
echo ""

if command -v pip &>/dev/null; then
  echo "Installing gpt4all Python SDK..."
  pip install gpt4all 2>/dev/null || {
    echo "WARNING: pip install gpt4all failed (requires compatible platform)"
  }
fi

echo ""
echo "Setup friction summary:"
echo "  - Download desktop app (300MB+)"
echo "  - Install and launch"
echo "  - Download LLM model (4-8GB)"
echo "  - Settings → LocalDocs → Add folder"
echo "  - Wait for embedding/indexing (can be slow: ~30s per 10 snippets)"
echo "  - Type queries in chat interface"
echo "  Total: 5+ steps, 10-30 minutes, GUI-only workflow"
echo "=== GPT4All setup complete ==="
