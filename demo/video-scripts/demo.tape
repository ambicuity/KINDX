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
# Setting up demo collection "kindx-demo"...
#   Added 12 sample documents from built-in corpus
#   Embedding documents... ████████████████████████ 12/12 (100%)
#   BM25 index built (12 docs, 3,847 terms)
#   Vector index ready (12 docs, 384 dimensions)
#
# Demo collection "kindx-demo" is ready!

Sleep 3s

# --- Scene 2: Hybrid search ---
Type "kindx query kindx-demo 'raising money for startup' --top 3"
Sleep 500ms
Enter
Sleep 3s

# Expected output:
# Hybrid Search: "raising money for startup" (3 results)
#
#   #1  [0.91] kindx://kindx-demo/fundraising-guide.md
#       "Series A fundraising requires a clear narrative around traction,
#        market size, and capital efficiency..."
#
#   #2  [0.84] kindx://kindx-demo/startup-finance.md
#       "Early-stage startups typically raise through SAFEs or convertible
#        notes before pricing a priced round..."
#
#   #3  [0.78] kindx://kindx-demo/investor-relations.md
#       "Building investor relationships 6-12 months before you need
#        capital gives you leverage in negotiations..."

Sleep 4s

# --- Scene 3: JSON output ---
Type "kindx search kindx-demo 'fundraising' --json | head -12"
Sleep 500ms
Enter
Sleep 2s

# Expected output:
# {
#   "query": "fundraising",
#   "mode": "bm25",
#   "results": [
#     {
#       "uri": "kindx://kindx-demo/fundraising-guide.md",
#       "score": 14.2,
#       "snippet": "Series A fundraising requires a clear narrative...",
#       "metadata": {
#         "path": "fundraising-guide.md",
#         "modified": "2026-03-01T00:00:00Z"

Sleep 4s

# --- Scene 4: Show Claude Desktop config ---
Type "echo '{\"mcpServers\":{\"kindx\":{\"command\":\"kindx\",\"args\":[\"serve\"]}}}'"
Sleep 500ms
Enter
Sleep 3s

# Final pause
Sleep 2s
