# KINDX Release Benchmark Deltas

Date: 2026-04-02 (America/Chicago)
Script: `tooling/benchmark_release_regressions.ts`

## Validation Sweep

- Full suite: `npm test` -> `687` passing tests across `17` test files.
- Focused regression: `npx vitest run specs/regression.test.ts --reporter=verbose` -> `28` passing tests in `specs/regression.test.ts`.
- Benchmark stability pass: `10` runs, median-based evaluation (selected release gate).

## Results (Median of 10 Runs)

### Embedding Insert Path (2,000 inserts into `vectors_vec` + `content_vectors`)

- `insert_prepare_per_call` median: `1569.5ms`
- `insert_cached_statements` median: `1400.5ms`
- `insert_transactional_bulk` median: `8ms`
- Cached vs uncached median delta: `+10.77%` (informational only)
- Transactional bulk vs uncached median delta: `+99.49%` (lower runtime)

### Structured Fan-Out (3 queries × 4 collections, synthetic `8ms` task latency)

- `fanout_sequential` median: `109ms`
- `fanout_parallel` median: `9ms`
- Parallel vs sequential median delta: `+91.74%` faster wall-clock completion

## Release Gates

- Transactional bulk vs uncached `>=95%`: `PASS` (`99.49%`)
- Fan-out parallel vs sequential `>=85%`: `PASS` (`91.74%`)
- Cached vs uncached: informational only (no hard gate)

## Code-Level Validation Targets

- `bulkInsertEmbeddings` contract validated via regression tests:
  - no-op on empty input
  - atomic all-or-nothing insert
  - equivalence to N individual `insertEmbedding` calls
  - statement-cache reuse
  - `Store.bulkInsertEmbeddings` bound via public interface
- Runtime/store interface compatibility validated:
  - shared `Database` interface defines `transaction<T>()` for both runtimes
- Embed hot path validated:
  - batch success path in `kindx embed` collects successful `embedBatch()` results and commits once via `bulkInsertEmbeddings()` per 32-chunk batch
  - batch failure fallback keeps per-row `insertEmbedding()` for error isolation

## Interpretation

- Isolated-DB benchmark design removes ordering bias from shared-WAL/shared-B-tree effects and should be used as the source of truth for this benchmark.
- Transactional bulk insert shows a strong and stable gain in this environment.
- Cached single-row inserts improve median runtime in this 10-run sample; continue treating cached-vs-uncached as informational because microbenchmark variance remains non-trivial.
- Fan-out parallelization remains a clear latency win for multi-collection orchestration.

## Reproduction

```bash
npx tsx tooling/benchmark_release_regressions.ts
```

```bash
for i in {1..10}; do npx tsx tooling/benchmark_release_regressions.ts; done
```
