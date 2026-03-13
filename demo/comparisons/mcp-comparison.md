# MCP (Model Context Protocol) — Deep Dive Comparison

> Last updated: 2026-03-13

MCP (Model Context Protocol) is an open standard that lets AI agents invoke tools via a
structured JSON-RPC interface. This document compares how KINDX and competitors integrate
with MCP, and what that means for agent workflows.

---

## MCP Support Matrix

| Tool | MCP Support | Transport | Tools Exposed | Install Complexity |
|------|------------|-----------|---------------|-------------------|
| **KINDX** | Native (built-in) | stdio | search, vsearch, query, collections, add, embed | 0 extra steps (ships with CLI) |
| **ChromaDB** | Separate repo ([chroma-mcp](https://github.com/chroma-core/chroma-mcp)) | stdio | 12 tools (list/get/create/delete collections, add/get/update/delete/query/count documents, peek, raw SQL) | `pip install chroma-mcp` + configure MCP client |
| **AnythingLLM** | Built-in | StdIO, SSE, Streamable HTTP | Agent skills (web browse, scrape, RAG query, code, chart, save file, etc.) | Configure via JSON or UI; auto-boots servers |
| **LanceDB** | Community only | Varies | Varies by implementation | Install third-party server + configure |
| **Khoj** | Not implemented | — | — | [Requested: Issue #1006](https://github.com/khoj-ai/khoj/issues/1006) |
| **PrivateGPT** | Not implemented | — | — | Third-party bridges exist |
| **LocalGPT** | Not implemented | — | — | No known MCP implementations |
| **Orama** | Not implemented | — | — | No known MCP implementations |
| **GPT4All** | Not implemented | — | — | [Requested: Issue #3546](https://github.com/nomic-ai/gpt4all/issues/3546) |

---

## Detailed Comparison

### KINDX — Native MCP

KINDX ships with a built-in MCP server that exposes its core search functionality directly:

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

**What an agent can do:**
- `search` — BM25 keyword search across collections
- `vsearch` — Vector/semantic search
- `query` — Hybrid search (BM25 + vector fusion)
- `collections` — List available collections
- `add` — Add documents to a collection
- `embed` — Generate embeddings for a collection

**Strengths:**
- Zero additional install: MCP comes with `kindx` itself
- Structured output: results come back as JSON with scores, metadata, and content
- All three search modes accessible from one MCP server
- Deterministic retrieval (no LLM in the loop — agent controls the interpretation)

**Limitation:**
- Read-focused: designed for search/retrieval, not document editing or multi-step RAG

---

### ChromaDB — chroma-mcp (Separate Package)

ChromaDB maintains an official but **separate** MCP server package:

```bash
pip install chroma-mcp
```

```json
{
  "mcpServers": {
    "chroma": {
      "command": "chroma-mcp",
      "args": ["--client-type", "persistent", "--data-dir", "./chroma-data"]
    }
  }
}
```

**12 tools exposed:**
1. `list_collections` — List all collections
2. `get_collection` — Get collection details
3. `create_collection` — Create a new collection
4. `delete_collection` — Delete a collection
5. `add_documents` — Add documents with auto-embedding
6. `get_documents` — Get documents by ID
7. `update_documents` — Update existing documents
8. `delete_documents` — Delete documents
9. `query_documents` — Semantic search
10. `count_documents` — Count documents in collection
11. `peek_collection` — Preview first N documents
12. `raw_sql` — Direct SQL queries

**Strengths:**
- Rich CRUD operations (full document lifecycle management)
- Supports ephemeral, persistent, and HTTP client modes
- Auto-embedding on add/query
- Official project (maintained by Chroma team)

**Limitations:**
- Separate install (`pip install chroma-mcp` on top of `chromadb`)
- No BM25-specific or hybrid-specific search tools (single query endpoint)
- Python-only server

**Source:** [chroma-mcp GitHub](https://github.com/chroma-core/chroma-mcp)

---

### AnythingLLM — Built-in MCP with Agent Skills

AnythingLLM has the most comprehensive MCP integration among RAG platforms:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "http://localhost:8080/sse"
    }
  }
}
```

Or via StdIO:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/my-mcp-server"]
    }
  }
}
```

**Capabilities:**
- MCP **client** support: AnythingLLM agents can call external MCP tools
- Supports StdIO, SSE, and Streamable HTTP transports
- Auto-boots configured MCP servers
- Configure via JSON file or settings UI
- Built-in agent skills: web browsing, scraping, RAG query, chart generation, code execution, file save

**Strengths:**
- Most complete MCP integration in the RAG space
- Agents can combine MCP tools with built-in skills
- No-code agent builder in the UI
- Three transport options for flexibility

**Limitations:**
- MCP is for *consuming* external tools, not *exposing* AnythingLLM's own search as MCP tools
- Retrieval itself is vector-only (no BM25/hybrid exposed via MCP)
- Resources/Prompts/Sampling protocols not supported
- Cloud version doesn't support MCP or custom agents

**Source:** [AnythingLLM MCP Docs](https://docs.anythingllm.com/mcp-compatibility/overview)

---

### Tools Without MCP

| Tool | Alternative Agent Interface | Notes |
|------|---------------------------|-------|
| **LanceDB** | Python/TS/Rust SDKs | Community MCP servers exist but are unofficial. Embed as a library instead. |
| **Khoj** | REST API (`/api/search`, `/api/chat`) | MCP support [requested in Issue #1006](https://github.com/khoj-ai/khoj/issues/1006). Use REST API for agent integration. |
| **PrivateGPT** | OpenAI-compatible API (`/v1/chunks`, `/v1/chat/completions`) | Third-party MCP bridges available. Native API is the primary agent interface. |
| **LocalGPT** | REST API (`/api/query`, `/api/ingest`) | No MCP discussion found. REST API is the only programmatic interface. |
| **Orama** | JavaScript/TypeScript SDK | In-process only. No server protocol. Use as an embedded library. |
| **GPT4All** | Python SDK (`gpt4all` package) | MCP support [requested in Issue #3546](https://github.com/nomic-ai/gpt4all/issues/3546). Desktop-focused. |

---

## Agent Architecture Patterns

### Pattern 1: KINDX as MCP Tool (Recommended for retrieval-focused agents)

```
┌─────────────┐     MCP/stdio      ┌──────────┐
│  LLM Agent  │ ◄──────────────── │  KINDX   │
│ (Claude,    │     search/query   │  MCP     │
│  GPT, etc.) │ ──────────────── │  Server  │
└─────────────┘                    └──────────┘
                                       │
                                   ┌───┴───┐
                                   │ Index  │
                                   │ (local)│
                                   └───────┘
```

The agent asks KINDX to search, gets structured JSON results, and synthesizes an answer.
KINDX never calls an LLM — the agent controls interpretation.

### Pattern 2: AnythingLLM as MCP Client (For agents that need full RAG + tools)

```
┌─────────────┐     Chat API       ┌──────────────┐     MCP      ┌──────────┐
│    User      │ ──────────────── │ AnythingLLM  │ ──────────── │ External │
│              │ ◄──────────────── │   Agent      │ ◄────────── │ MCP Tools│
└─────────────┘                    └──────────────┘              └──────────┘
                                       │
                                   ┌───┴───┐
                                   │ Local  │
                                   │  LLM   │
                                   └───────┘
```

AnythingLLM runs the LLM and *consumes* external MCP tools. The LLM is inside the platform.

### Pattern 3: ChromaDB MCP for Document Management

```
┌─────────────┐     MCP/stdio      ┌──────────────┐
│  LLM Agent  │ ◄──────────────── │  chroma-mcp  │
│             │ ──────────────── │  (12 tools)  │
└─────────────┘   CRUD + search    └──────────────┘
                                       │
                                   ┌───┴───┐
                                   │ChromaDB│
                                   │  DB    │
                                   └───────┘
```

Best when the agent needs full CRUD (create, read, update, delete) on a vector store,
not just search.

---

## When to Use What

| Use Case | Best Tool | Why |
|----------|-----------|-----|
| Agent needs fast keyword + semantic + hybrid search | **KINDX** | Only MCP server with all 3 search modes |
| Agent needs to manage a vector DB (CRUD) | **ChromaDB** (chroma-mcp) | 12 tools including create/update/delete |
| Agent needs full RAG with built-in LLM | **AnythingLLM** | MCP client + local LLM + agent skills |
| Agent needs reranked retrieval | **LanceDB** (via SDK) | Built-in CrossEncoder reranking |
| Agent needs web search + personal knowledge | **Khoj** (via REST API) | Web + personal knowledge agents |
| Desktop user wanting chat over local files | **GPT4All** | 1-click install, no programming needed |

---

## Sources

- KINDX MCP: Built-in (`kindx mcp`)
- ChromaDB MCP: [chroma-mcp GitHub](https://github.com/chroma-core/chroma-mcp)
- AnythingLLM MCP: [MCP Docs](https://docs.anythingllm.com/mcp-compatibility/overview), [Features](https://docs.anythingllm.com/features/all-features)
- Khoj MCP request: [GitHub Issue #1006](https://github.com/khoj-ai/khoj/issues/1006)
- GPT4All MCP request: [GitHub Issue #3546](https://github.com/nomic-ai/gpt4all/issues/3546)
- LanceDB community MCP: [GitHub Search](https://github.com/search?q=lancedb+mcp)

---

*Part of the KINDX comparison framework. See also: [competitor-comparison.md](./competitor-comparison.md)*
