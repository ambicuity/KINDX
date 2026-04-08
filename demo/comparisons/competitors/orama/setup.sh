#!/usr/bin/env bash
set -euo pipefail

# Orama setup — install npm packages
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Orama Setup ==="
echo "[1/2] Initializing package.json..."
cd "$SCRIPT_DIR"
[ -f package.json ] || npm init -y >/dev/null 2>&1

echo "[2/2] Installing @orama/orama and tsx..."
npm install @orama/orama tsx >/dev/null 2>&1
echo "Orama $(node -e "console.log(require('@orama/orama/package.json').version)" 2>/dev/null || echo 'unknown') installed."
echo "=== Orama setup complete ==="
