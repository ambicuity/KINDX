# 5-Minute Deep Dive: KINDX Full Walkthrough

**Target:** YouTube / documentation site
**Format:** Screen recording with voiceover (or terminal recording with text overlays)
**Total runtime:** 5:00

---

## Segment 1: Introduction (0:00 - 0:30)

### What to show
- KINDX logo or repo README hero section
- Quick architecture diagram: Documents -> Embeddings -> Local Index -> MCP Tools -> AI Agents

### Script
> "KINDX is a local memory node for MCP agents. It gives AI assistants like Claude
> the ability to search your documents using keyword, semantic, and hybrid retrieval --
> all running locally on your machine. No API keys, no cloud uploads, no latency.
> Let's see how it works."

### Key points
- Local-first: everything stays on your machine
- MCP-native: built for the Model Context Protocol
- Three search modes: BM25 (keyword), vector (semantic), hybrid (both)

---

## Segment 2: Installation (0:30 - 1:30)

### What to show
Terminal session, clean prompt.

### Commands
```bash
# Install globally
$ npm install -g @ambiguity/kindx

# Verify installation
$ kindx --version
kindx 1.0.1

# See available commands
$ kindx --help
```

### Expected output for --help
```
Usage: kindx <command> [options]

Commands:
  kindx collection <action>  Manage document collections
  kindx embed                Embed documents in a collection
  kindx search               BM25 keyword search
  kindx vsearch              Vector similarity search
  kindx query                Hybrid search (BM25 + vector)
  kindx serve                Start MCP server
  kindx demo                 Set up a demo collection

Options:
  --version  Show version number
  --help     Show help
```

### Script
> "Install KINDX globally with npm. It's a single package with no native dependencies --
> embeddings run locally using a bundled ONNX model. Once installed, you have access
> to the full CLI."

### Key points
- Single npm install, no build steps
- Bundled embedding model (all-MiniLM-L6-v2, 384 dimensions)
- Works on macOS, Linux, and Windows (WSL)

---

## Segment 3: Collection Setup (1:30 - 2:30)

### What to show
Adding a real folder of documents, updating the index, and embedding.

### Commands
```bash
# Create a collection pointing to a docs folder
$ kindx collection add my-docs ~/Projects/my-app/docs
Collection "my-docs" created
  Source: /Users/demo/Projects/my-app/docs
  Documents found: 47

# Scan and index documents
$ kindx collection update my-docs
Scanning "my-docs"...
  New: 47  Changed: 0  Removed: 0
  BM25 index updated (47 docs, 18,293 terms)

# Generate embeddings
$ kindx embed my-docs
Embedding "my-docs"...
  ████████████████████████████████████████ 47/47 (100%)
  Model: all-MiniLM-L6-v2 (384 dims)
  Time: 8.3s (5.7 docs/sec)
  Vector index saved
```

### Script
> "Collections are the core abstraction. Point one at a folder, and KINDX will
> scan for supported file types -- markdown, text, PDF, code files. The update
> command builds the BM25 keyword index, and embed generates vector embeddings
> locally. No data leaves your machine."

### Key points
- Collections map to filesystem directories
- Supported formats: .md, .txt, .pdf, .ts, .js, .py, .go, .rs, and more
- Embedding is incremental -- only new/changed docs get re-embedded
- All indexes stored locally in ~/.kindx/

---

## Segment 4: Search Modes (2:30 - 3:30)

### What to show
Three different search commands demonstrating each retrieval mode.

### Commands

**BM25 (keyword) search:**
```bash
$ kindx search my-docs "API rate limiting"
BM25 Search: "API rate limiting" (5 results)

  #1  [12.4] kindx://my-docs/api-reference.md
      "Rate limiting is enforced at 100 requests per minute per API key.
       Exceeding this limit returns HTTP 429..."

  #2  [9.7]  kindx://my-docs/architecture.md
      "The rate limiter uses a sliding window algorithm to track request
       counts per client..."

  #3  [7.1]  kindx://my-docs/troubleshooting.md
      "If you receive 429 errors, check your API rate limiting configuration
       and consider implementing exponential backoff..."
```

**Vector (semantic) search:**
```bash
$ kindx vsearch my-docs "how to prevent abuse of public endpoints"
Vector Search: "how to prevent abuse of public endpoints" (5 results)

  #1  [0.89] kindx://my-docs/api-reference.md
      "Rate limiting is enforced at 100 requests per minute per API key..."

  #2  [0.85] kindx://my-docs/security.md
      "Public endpoints should implement CAPTCHA verification, IP-based
       throttling, and request signature validation..."

  #3  [0.79] kindx://my-docs/architecture.md
      "The API gateway acts as the first line of defense, applying
       authentication, rate limiting, and input validation..."
```

**Hybrid search:**
```bash
$ kindx query my-docs "API design patterns" --explain --top 3
Hybrid Search: "API design patterns" (3 results)

  #1  [0.93] kindx://my-docs/api-reference.md
      "Follow RESTful conventions: use nouns for resources, HTTP verbs
       for actions, and consistent error response formats..."
      Retrieval: BM25=14.2 (rank 1) + Vector=0.91 (rank 1) -> RRF=0.93

  #2  [0.87] kindx://my-docs/architecture.md
      "The service layer implements the repository pattern, separating
       data access from business logic..."
      Retrieval: BM25=8.1 (rank 3) + Vector=0.88 (rank 2) -> RRF=0.87

  #3  [0.81] kindx://my-docs/style-guide.md
      "API endpoints must use kebab-case paths, return JSON responses
       with consistent envelope structure..."
      Retrieval: BM25=9.4 (rank 2) + Vector=0.72 (rank 5) -> RRF=0.81
```

### Script
> "KINDX gives you three search modes. BM25 is traditional keyword search -- fast,
> exact, great for known terms. Vector search finds semantically similar content even
> when the words don't match. And hybrid combines both using Reciprocal Rank Fusion,
> giving you the best of both worlds. The --explain flag shows exactly how each
> result was scored."

### Key points
- BM25 scores are raw TF-IDF scores (higher = more relevant)
- Vector scores are cosine similarity (0 to 1)
- Hybrid uses RRF to merge rankings from both methods
- --explain reveals the full retrieval trace

---

## Segment 5: Agent Integration (3:30 - 4:15)

### What to show
JSON output mode and the MCP server.

### Commands

**JSON output for piping to other tools:**
```bash
$ kindx search my-docs "authentication" --json | head -20
{
  "query": "authentication",
  "mode": "bm25",
  "results": [
    {
      "uri": "kindx://my-docs/security.md",
      "score": 11.3,
      "snippet": "Authentication is handled via JWT tokens issued by the /auth/login endpoint...",
      "metadata": {
        "path": "/Users/demo/Projects/my-app/docs/security.md",
        "modified": "2026-02-15T10:30:00Z",
        "size": 4821
      }
    }
  ]
}
```

**Starting the MCP server:**
```bash
$ kindx serve
KINDX MCP Server running on stdio
  Collections: my-docs (47 docs)
  Tools: kindx_search, kindx_vsearch, kindx_query, kindx_collections
  Ready for connections
```

### Script
> "Every KINDX command supports --json output, making it easy to integrate into
> scripts and pipelines. But the real power is the MCP server. Run kindx serve
> and any MCP client -- Claude Desktop, Cursor, or your own agent -- can call
> KINDX search tools directly."

### Key points
- --json flag on all search commands
- MCP server exposes search as tools: kindx_search, kindx_vsearch, kindx_query
- stdio transport (standard MCP protocol)
- Multiple collections can be served simultaneously

---

## Segment 6: Claude Desktop Integration (4:15 - 4:45)

### What to show
Claude Desktop config file and a live conversation.

### Commands
```bash
# Show the config
$ cat ~/.claude/claude_desktop_config.json
{
  "mcpServers": {
    "kindx": {
      "command": "kindx",
      "args": ["serve"]
    }
  }
}
```

### Claude Desktop conversation (show screenshot or screen recording)
```
User: What does our API reference say about rate limiting?

Claude: Based on your documentation, your API enforces rate limiting at
100 requests per minute per API key. When this limit is exceeded, the
server returns HTTP 429 (Too Many Requests).

Your architecture docs mention that the rate limiter uses a sliding
window algorithm. The recommended client-side approach is exponential
backoff, as described in your troubleshooting guide.

Sources:
- kindx://my-docs/api-reference.md
- kindx://my-docs/architecture.md
- kindx://my-docs/troubleshooting.md
```

### Script
> "Add KINDX to Claude Desktop with a three-line config. Now Claude can search
> your local documents in every conversation. It sees your docs, your notes,
> your codebase -- whatever you've indexed. And everything stays local."

### Key points
- Three-line config addition
- Claude sees the search tools automatically
- Results include source URIs for traceability
- Works with any MCP-compatible client

---

## Segment 7: Wrap-Up (4:45 - 5:00)

### What to show
Terminal with repo URL and star prompt.

### Commands
```bash
$ echo "github.com/ambiguity/kindx"
github.com/ambiguity/kindx

$ echo "npm install -g @ambiguity/kindx"
npm install -g @ambiguity/kindx
```

### Script
> "That's KINDX -- local semantic memory for MCP agents. Install it in 30
> seconds, index your docs, and give your AI assistants the ability to search
> your knowledge base. Star the repo, open an issue, or contribute. Thanks
> for watching."

### Key points
- Repo link on screen
- npm install command on screen
- Call to action: star, issues, contributions welcome
