# KINDX Demo Recording
# Run with: vhs demo.tape
# Produces: demo.gif

Output demo.gif
Set FontSize 14
Set Width 1200
Set Height 600
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Padding 20

# --- Setup (hidden) ---
Hide
Type "export PS1='$ '"
Enter
Sleep 500ms
Type "export KINDX_CONFIG_DIR=$(mktemp -d)"
Enter
Sleep 200ms
Type "export XDG_CACHE_HOME=$(mktemp -d)"
Enter
Sleep 200ms
Type "export INDEX_PATH=$(mktemp -u /tmp/kindx-demo.XXXXXX.sqlite)"
Enter
Sleep 200ms
Type "kindx collection add specs/eval-docs --name kindx-demo"
Enter
Sleep 1s
Type "kindx update -c kindx-demo"
Enter
Sleep 1s
Type "kindx embed"
Enter
Sleep 3s
Type "clear"
Enter
Sleep 500ms
Show

# --- Scene 1: Run the demo command ---
Sleep 1s

Type "kindx demo"
Sleep 500ms
Enter
Sleep 8s

# Expected output:
# KINDX - Interactive Demo
# Step 1: Collection Setup
# Step 2: Embedding
# Step 3: BM25 Search

Sleep 3s

# --- Scene 2: Hybrid search ---
Type "kindx query 'raising money for startup' -c kindx-demo -n 3"
Sleep 500ms
Enter
Sleep 3s

# Expected output:
# kindx://kindx-demo/startup-fundraising-memo.md
# kindx://kindx-demo/product-launch-retrospective.md

Sleep 4s

# --- Scene 3: JSON output ---
Type "kindx search 'fundraising' -c kindx-demo --json | jq '.[0]'"
Sleep 500ms
Enter
Sleep 2s

# Expected output:
# {
#   "docid": "#...",
#   "file": "kindx://kindx-demo/startup-fundraising-memo.md",
#   "title": "Series A Fundraising Strategy Memo",
#   "score": ...,
#   "snippet": "..."

Sleep 4s

# --- Scene 4: Show Claude Desktop config ---
Type "echo '{\"mcpServers\":{\"kindx\":{\"command\":\"kindx\",\"args\":[\"mcp\"]}}}'"
Sleep 500ms
Enter
Sleep 3s

# Final pause
Sleep 2s
