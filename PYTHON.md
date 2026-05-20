# Python Integration

**Status:** Thin adapter. Not a supported Python product tier.
**Decision date:** 2026-05-20
**Spec reference:** docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §6

## What ships

`python/kindx-langchain/` is a single-file LangChain retriever wrapper around the KINDX HTTP API. It exists for convenience in Python notebooks and small scripts. It is not a stable API surface.

## What does not ship

- No sync/async client beyond what the wrapper exposes.
- No retry/backoff, streaming `/query/stream` support, or structured-query helpers in this package.
- No PyPI release cadence beyond unit-test passing.

## How to integrate from Python

For anything beyond toy use, call the KINDX HTTP API directly:

- `POST /query` for structured retrieval (see root README, HTTP Endpoints).
- `POST /query/stream` for streaming results.
- Use any HTTP client (`httpx`, `requests`); request and response shapes are documented in `@ambicuity/kindx-schemas`.

## Why we chose this shape

The cost of maintaining a supported Python tier (typed sync+async client, streaming, PyPI release process, examples for multiple frameworks) is several weeks of focused work and a permanent maintenance commitment. Demand has not been measured. Until that data exists, the honest framing is "thin adapter, call HTTP directly for production."

If demand emerges, this decision is reversible by following spec §6 Option B (separate spec required).

## Reversal criteria

This decision should be re-opened when any of the following is true:

- Sustained external usage of the `kindx-langchain` PyPI package above an agreed threshold.
- Concrete user requests for Python features beyond the wrapper's surface.
- A KINDX-internal need for a Python integration tier.
