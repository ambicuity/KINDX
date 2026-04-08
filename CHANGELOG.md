# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0](https://github.com/ambicuity/KINDX/compare/v1.2.0...v1.3.0) (2026-04-08)


### Features

* **engine:** add mcp control-plane policy, layered instructions, and scoped memory/session runtime ([ee53382](https://github.com/ambicuity/KINDX/commit/ee533821044fd6f5a9e55994678f2f9818e1f465))
* **mcp:** add control-plane policy, layered instructions, and scoped memory/session runtime ([d75c526](https://github.com/ambicuity/KINDX/commit/d75c52681badc75ed2f2c17193af868566b78875))


### Bug Fixes

* **engine:** use crypto randomUUID for session identifiers ([67f22de](https://github.com/ambicuity/KINDX/commit/67f22deba7be54585dc216f6daea7176863da004))

## [1.2.0](https://github.com/ambicuity/KINDX/compare/v1.1.0...v1.2.0) (2026-04-01)


### Features

* **engine:** implement chunk-hash incremental embedding delta ([#88](https://github.com/ambicuity/KINDX/issues/88)) ([5563258](https://github.com/ambicuity/KINDX/commit/5563258195ef43f439ba143ad2b5d286f8840b41))
* **engine:** implement semantic query cache for expansion ([#91](https://github.com/ambicuity/KINDX/issues/91)) ([27c0bb9](https://github.com/ambicuity/KINDX/commit/27c0bb948a0cbb4dfc7639ec3f309d66d4ce8351))
* **engine:** model preloader + warmed health endpoint (closes [#22](https://github.com/ambicuity/KINDX/issues/22)) ([#84](https://github.com/ambicuity/KINDX/issues/84)) ([76d9a87](https://github.com/ambicuity/KINDX/commit/76d9a870f53dc3155f27e8796fe9fc5b05cfc127))
* implement context-aware chunking with cached document summaries ([#90](https://github.com/ambicuity/KINDX/issues/90)) ([d9e118b](https://github.com/ambicuity/KINDX/commit/d9e118b603e349bbbff156fb11864db976cdf08a))
* **watch:** add mcp --watch integration and batched live embeddings ([#86](https://github.com/ambicuity/KINDX/issues/86)) ([3af3676](https://github.com/ambicuity/KINDX/commit/3af3676ee8c7c65c35b31f362f4dfde8d012b263))


### Bug Fixes

* **engine:** address post-merge AI review regressions ([#89](https://github.com/ambicuity/KINDX/issues/89)) ([5d1dddc](https://github.com/ambicuity/KINDX/commit/5d1dddcf972f97d7d2fd40bd7eec637ba399dfa5))
* **engine:** improve CJK BM25 normalization for contiguous text ([#87](https://github.com/ambicuity/KINDX/issues/87)) ([3e4c4b2](https://github.com/ambicuity/KINDX/commit/3e4c4b2c9fc549a1e704ecfebe05398779621b63))

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
