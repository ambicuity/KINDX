# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/ambicuity/KINDX/compare/v1.0.1...v1.1.0) (2026-03-27)


### Features

* **demo:** add competitor comparison framework with runnable tests ([d1b3a78](https://github.com/ambicuity/KINDX/commit/d1b3a78d5cdeac46ab276eacede40a2ec25fe4ea))
* **demo:** add kindx demo command and comprehensive demo showcase ([af87f86](https://github.com/ambicuity/KINDX/commit/af87f862fb3956aef27b48e93a5dde7684f6d84c))
* **engine:** add demo command and align showcase assets ([6bdba03](https://github.com/ambicuity/KINDX/commit/6bdba03a0e99295a9e12fb806e6eba0e05adcad4))
* **engine:** add phase-1 corrective feedback loop for issue [#12](https://github.com/ambicuity/KINDX/issues/12) ([0e58671](https://github.com/ambicuity/KINDX/commit/0e58671e1cbdc5fc29fb80352851b379e416c0fb))
* **engine:** implement Phase 1 corrective feedback loop (closes [#12](https://github.com/ambicuity/KINDX/issues/12)) ([15027aa](https://github.com/ambicuity/KINDX/commit/15027aa15edc1595805ba551cfef56bb6d9a7712))
* **github:** redesign issue intake and commands ([9813619](https://github.com/ambicuity/KINDX/commit/9813619e0e3a37ea7c019b51ed19dc5dd82a4556))
* **reference:** implement typed kindx client ecosystem (closes [#29](https://github.com/ambicuity/KINDX/issues/29)) ([22fc780](https://github.com/ambicuity/KINDX/commit/22fc7805855b64fb6d31ac08b9897c69e79d0af4))
* **sdk:** add typed schemas, TS client, and langchain retriever scaffold ([1a1726d](https://github.com/ambicuity/KINDX/commit/1a1726ddb3feeaf238f44982168dedcae828a7d4))
* **sqlite:** enforce busy timeout for concurrent index access ([#74](https://github.com/ambicuity/KINDX/issues/74)) ([30a7e44](https://github.com/ambicuity/KINDX/commit/30a7e44bb857e72ada960ac6a23ef5f4041d48d6))


### Bug Fixes

* **ci:** make trivy scheduled only ([59def18](https://github.com/ambicuity/KINDX/commit/59def18a7e96b8c69aa4f6a6dd6e6199f8cc56d3))
* **ci:** repair linked issue enforcer permissions ([d2e3a18](https://github.com/ambicuity/KINDX/commit/d2e3a1820c5372090238bc2faa5421536eefcbc2))
* **ci:** repair trivy and training validation ([b99713c](https://github.com/ambicuity/KINDX/commit/b99713c72a056b94f1e00ed262f87ea8928e6f9b))
* **demo:** address all review comments — CLI syntax, security, scoping ([5b9850d](https://github.com/ambicuity/KINDX/commit/5b9850dc5248e9c2f257abb0ae669802de004482))
* **demo:** correct GitHub URL, CI JSON path, and recipe links ([a5b8f6c](https://github.com/ambicuity/KINDX/commit/a5b8f6c1b10f4b803665ed2db08749f688eb7c0b))
* **demo:** correct KINDX reranking status in competitor comparison ([e00140a](https://github.com/ambicuity/KINDX/commit/e00140ae90e8b5a7f0ef08c6e25fd7f74fdcc8f2))
* **engine:** align demo showcase with current CLI ([8bdfb82](https://github.com/ambicuity/KINDX/commit/8bdfb82910dab28eca5f16492ead7dfa3b72223f))
* **engine:** align phase-1 feedback semantics and optimize penalty lookup ([f9d2468](https://github.com/ambicuity/KINDX/commit/f9d2468ca1f113ad41e555b7185017ab4a7fb98b))
* **inference:** add low-vram policy for context and parallelism ([#73](https://github.com/ambicuity/KINDX/issues/73)) ([bb24276](https://github.com/ambicuity/KINDX/commit/bb24276afe4b8f80d24f91903ee8f45ef0976df2))
* **reference:** address ai follow-up items from sdk rollout ([513a56e](https://github.com/ambicuity/KINDX/commit/513a56e66a9e74bda39c4b94bfb7c089e0297e42))
* **reference:** address ai review follow-ups from [#77](https://github.com/ambicuity/KINDX/issues/77) ([c185f21](https://github.com/ambicuity/KINDX/commit/c185f219514802fec4db9306ca032a904ef3a077))
* **reference:** avoid regex-based baseUrl trimming in sdk client ([514fcb4](https://github.com/ambicuity/KINDX/commit/514fcb4a73f7786e4360d53ad45a40e89641c686))
* **specs:** correct Bun preload path in smoke-install ([a07a3c7](https://github.com/ambicuity/KINDX/commit/a07a3c776b8a061d5be46ae3edbdfdfbce57d47e))

## [1.0.1](https://github.com/ambicuity/KINDX/compare/v1.0.0...v1.0.1) (2026-03-12)


### Bug Fixes

* resolve npm install -g EACCES guidance and TS import regression (closes [#35](https://github.com/ambicuity/KINDX/issues/35)) ([#36](https://github.com/ambicuity/KINDX/issues/36)) ([006f5e1](https://github.com/ambicuity/KINDX/commit/006f5e1d16e7ecde14aab2329dd5aca6730a3135))

## 1.0.0 (2026-03-08)


### Features

* initial commit of KINDX repository ([8072470](https://github.com/ambicuity/KINDX/commit/8072470567b229f2fec58966c7a7ecff4c7b234d))


### Bug Fixes

* resolve TypeScript strict errors, update gh-action versions, configure GH packages registry ([f19c8d9](https://github.com/ambicuity/KINDX/commit/f19c8d9dc7e9b7c2090ae368dbcaebeadaae17e8))

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
