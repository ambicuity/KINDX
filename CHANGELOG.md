# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-07

### Added

- Initial release of KINDX - On-Device Document Intelligence Engine
- BM25 full-text search via SQLite FTS5
- Vector semantic search via sqlite-vec with embeddinggemma-300M
- Hybrid search with Reciprocal Rank Fusion (RRF)
- LLM re-ranking via qwen3-reranker-0.6B
- Query expansion via fine-tuned model
- Smart document chunking with natural break point detection
- Collection management (add, remove, rename, list)
- Context management for collections and paths
- MCP (Model Context Protocol) server with stdio and HTTP transport
- Multi-get command for batch document retrieval
- Output formats: plain text, JSON, CSV, XML, Markdown
- Support for custom embedding models via KINDX_EMBED_MODEL
- Configurable reranker context size
- Position-aware score blending
- Code fence protection in chunking
- Document identification via 6-character hash (docid)
- Fuzzy path matching with suggestions
- LLM response caching
- Named indexes
- Schema migration support
- Comprehensive test suite (vitest)
- CI/CD via GitHub Actions
- CodeQL and Trivy security scanning
- Signed releases via Sigstore
