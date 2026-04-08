# 5-Minute Deep Dive: KINDX Full Walkthrough

**Target:** YouTube / documentation site
**Format:** Screen recording with voiceover
**Total runtime:** 5:00

---

## Segment 1: Introduction (0:00 - 0:30)

### What to show

- KINDX repo README hero section
- Simple diagram: Files -> KINDX index -> CLI + MCP tools

### Script

> "KINDX is a local memory node for MCP agents. It gives AI assistants and terminal workflows a shared local retrieval layer over your documents, code, and notes. Let's walk through the current CLI and MCP flow."

### Key points

- Local-first retrieval
- BM25, vector, and hybrid search
- MCP-native integration

---

## Segment 2: Installation (0:30 - 1:00)

### Commands

```bash
$ npm install -g @ambicuity/kindx
$ kindx --version
$ kindx --help
```

### Key points

- The published package is `@ambicuity/kindx`.
- `kindx --help` shows the current CLI, including `query`, `search`, `vsearch`, `get`, `multi-get`, and `mcp`.

---

## Segment 3: Register a Collection (1:00 - 2:00)

### Commands

```bash
$ kindx collection add ~/Projects/my-app/docs --name my-docs
$ kindx update -c my-docs
$ kindx embed
```

### Sample narration

> "Collections map a short name to a folder on disk. `update` refreshes the lexical index, and `embed` builds vectors for every collection with pending content."

### Key points

- `collection add` takes the path first and `--name` second.
- `kindx update -c my-docs` scopes indexing to one collection.
- `kindx embed` is global and processes pending collections.

---

## Segment 4: Search Modes (2:00 - 3:15)

### BM25

```bash
$ kindx search "API rate limiting" -c my-docs
```

### Vector

```bash
$ kindx vsearch "how do we prevent abuse of public endpoints" -c my-docs
```

### Hybrid

```bash
$ kindx query "API design patterns" -c my-docs --explain -n 3
```

### Sample narration

> "BM25 is great when you know the terms. Vector search is better when you know the idea. Hybrid search combines both, and `--explain` shows how the final ranking came together."

### Key points

- `search` is lexical only.
- `vsearch` is semantic only.
- `query` is the recommended default for interactive use.
- Use `-n` for result count.

---

## Segment 5: Structured Output and MCP (3:15 - 4:20)

### CLI JSON output

```bash
$ kindx search "authentication" -c my-docs --json | jq '.[0]'
{
  "docid": "#762e73",
  "score": 0.82,
  "file": "kindx://my-docs/security.md",
  "title": "Authentication Guide",
  "snippet": "Authentication is handled via JWT tokens issued by the /auth/login endpoint..."
}
```

### Start the MCP server

```bash
$ kindx mcp
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "kindx": {
      "command": "kindx",
      "args": ["mcp"]
    }
  }
}
```

### MCP tool surface

- `query`
- `get`
- `multi_get`
- `status`

### Sample narration

> "The CLI and MCP server expose the same underlying index. For automation, the MCP server is the important piece: clients discover `query`, `get`, `multi_get`, and `status` automatically."

---

## Segment 6: Benchmarks and Close (4:20 - 5:00)

### Benchmarks to mention

The committed benchmark snapshot in `demo/benchmarks/eval-results.json` reports:

- BM25: Hit@1 `0.625`, median latency `3ms`
- Vector: Hit@1 `0.708`, median latency `28ms`
- Hybrid (RRF): Hit@1 `0.792`, median latency `45ms`
- Hybrid + rerank: Hit@1 `0.833`, median latency `112ms`

### Closing script

> "If you want to try it yourself, install `@ambicuity/kindx`, add a collection, run `kindx update`, run `kindx embed`, and then plug `kindx mcp` into your client of choice."

### Final frame

```text
Repo: https://github.com/ambicuity/KINDX
Install: npm install -g @ambicuity/kindx
```
