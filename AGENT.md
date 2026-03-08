# AGENT.md

This file contains instructions for AI coding agents working on the KINDX codebase.

## Project Overview

KINDX is an on-device document intelligence engine -- a CLI tool for hybrid search across markdown documents using BM25, vector embeddings, and LLM re-ranking. All processing runs locally via node-llama-cpp with GGUF models.

## Repository Layout

```
engine/           Core source code (TypeScript)
  kindx.ts        CLI entry point (~3000 lines)
  repository.ts   Core data access and retrieval (~3600 lines)
  inference.ts    LLM abstraction layer (~1500 lines)
  catalogs.ts     YAML collection configuration (~450 lines)
  renderer.ts     Output formatting (~430 lines)
  protocol.ts     MCP server (~820 lines)
  runtime.ts      SQLite compatibility layer (~55 lines)
  benchmarks.ts   Reranker benchmarks
  preloader.ts    Test preload setup

specs/            Test suite (vitest)
reference/        Documentation
tooling/          Build and release scripts
training/         Model fine-tuning pipeline (Python)
capabilities/     Agent skill definitions
media/            Static assets
```

## Key Commands

```bash
npm install          # Install dependencies
npm run build        # TypeScript build
npm test             # Run test suite (vitest)
npm run kindx        # Run KINDX locally via tsx
```

## Development Rules

1. All source files are in `engine/` -- not `src/`.
2. Tests are in `specs/` -- not `test/`.
3. Use `.js` extension in relative imports (ESM requirement).
4. The CLI binary is `kindx`.
5. The npm package is `@ambicuity/kindx`.
6. Cache directory: `~/.cache/kindx/`
7. Config directory: `~/.config/kindx/`
8. Virtual path scheme: `kindx://`
9. Environment variable prefix: `KINDX_`

## Architecture Notes

- `runtime.ts` provides the SQLite compatibility layer (Bun vs Node detection).
- `repository.ts` is the largest file and contains all data access, search, and indexing logic.
- `inference.ts` manages GGUF model lifecycle (loading, embedding, reranking, generation).
- `catalogs.ts` handles YAML-based collection configuration.
- `protocol.ts` implements both stdio and HTTP MCP transports.
- `renderer.ts` handles all output formatting (JSON, CSV, XML, Markdown, files).

## Commit Message Format

Follow Conventional Commits:

```
<type>(<scope>): <description>
```

Types: feat, fix, docs, test, chore, refactor, perf
Scopes: engine, specs, reference, tooling, training, ci, deps, config
