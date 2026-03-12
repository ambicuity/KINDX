# KINDX Gemini Code Assist Guide

KINDX is a local-first document intelligence engine. The core product is a TypeScript ESM CLI and MCP server that performs BM25 search, vector retrieval, and LLM reranking locally with `node-llama-cpp`. The repo also contains a lightweight Python training pipeline for query-expansion data and evaluation.

## Repository shape

- `engine/` is the source tree. Do not suggest moving files into `src/`.
- `specs/` contains Vitest tests and end-to-end CLI/MCP coverage.
- `training/` contains Python scripts for dataset validation, scoring, and training experiments.
- `.github/workflows/` contains CI, release automation, security scans, and PR governance.

## Non-negotiable engineering rules

- Keep NodeNext ESM semantics intact. Relative TypeScript imports must use `.js` extensions.
- The public CLI name is `kindx`, the npm package is `@ambicuity/kindx`, and releases publish to GitHub Packages.
- Environment variables are `KINDX_*`. Avoid inventing new prefixes.
- Virtual paths use the `kindx://` scheme. Preserve collection-aware path behavior.
- Prefer small, deterministic changes over broad refactors.

## Review priorities by subsystem

### `engine/repository.ts`

- Prioritize search correctness, SQL safety, FTS5 sanitization, sqlite-vec compatibility, and docid/path normalization.
- Flag regressions in BM25/vector/RRF behavior, collection filtering, inactive-document filtering, or cache invalidation.
- Favor graceful degradation when embeddings or reranking fail instead of crashing search flows.

### `engine/inference.ts`

- Watch for native resource leaks, model context lifetime issues, download/cache failures, and CPU/GPU fallback regressions.
- Typed query expansion must stay strictly in `lex:`, `vec:`, and `hyde:` form with no chatty filler.

### `engine/kindx.ts`

- CLI output contracts matter. JSON, CSV, XML, Markdown, and `--files` output should remain stable and machine-readable.
- Exit codes, stderr usage, help text, daemon behavior, and filesystem operations should stay predictable.

### `engine/protocol.ts`

- Preserve MCP tool/resource compatibility and validate request inputs thoroughly.
- Treat HTTP auth and document retrieval boundaries as security-sensitive.

### `training/`

- Prefer lightweight validation and deterministic scoring checks in CI.
- Do not assume GPU availability or full training runs in pull-request checks.

### `.github/workflows/`

- Required PR checks should be deterministic and low-flake.
- Keep permissions minimal, use concurrency to cancel superseded runs, and avoid duplicating setup across workflows.
- Security/reporting workflows can be separate from required core validation.
- GitHub Packages publishing should use `npm.pkg.github.com` and repository-scoped authentication.

## Testing expectations

- CI-safe tests should run with `CI=true`.
- Live model, GPU, or large-download scenarios should skip in CI unless the workflow is explicitly dedicated to them.
- When behavior changes, prefer updating or adding focused tests in `specs/` rather than relying on manual reasoning.
