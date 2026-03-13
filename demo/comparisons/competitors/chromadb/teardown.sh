#!/usr/bin/env bash
set -euo pipefail

# ChromaDB teardown — nothing persistent to clean up (uses ephemeral client)
echo "=== ChromaDB Teardown ==="
echo "No persistent state to clean up (test uses ephemeral in-memory client)."
