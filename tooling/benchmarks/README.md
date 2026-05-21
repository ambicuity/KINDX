# Benchmark fixtures

This directory holds the **judgment manifests** (small, in-repo) and expects two **corpus directories** (large, NOT in repo) to be populated locally for the `bench:quality` track.

## What's in the repo

```
tooling/benchmarks/
├── runner.ts                 # Dispatcher (npm run bench:*)
├── section6_bench.ts         # Quality benchmark (hit@3, hit@5, MRR by difficulty)
├── section6-results.schema.json
└── judgments/
    ├── msmarco.v1.json       # 24 graded queries against the MS MARCO corpus
    └── dbpedia.v1.json       # 24 graded queries against the DBpedia corpus
```

## What's NOT in the repo

```
tooling/benchmarks/
├── test_corpus_msmarco/      # ~1000 markdown docs from MS MARCO passage set
└── test_corpus_dbpedia/      # ~1000 markdown docs from DBpedia long abstracts
```

The corpora are excluded because they would add tens to hundreds of MB to every clone and most contributors will never run the quality bench locally.

## How `section6_bench.ts` finds the corpus

Each judgment manifest declares the corpus path in its `source_corpus` field:

```json
{
  "schema": "kindx-benchmark-judgments-v1",
  "dataset": "MS MARCO 1000",
  "source_corpus": "tooling/benchmarks/test_corpus_msmarco",
  "queries": [...]
}
```

At runtime, `section6_bench.ts` resolves that path relative to the repo root, copies it into a temporary index location, and runs the benchmark. If the directory is missing, the run **skips that dataset with a clear message** (since 2026-05-20) instead of crashing.

## How to populate a corpus

Each markdown file in the corpus must be named to match the relevance entries in the judgment manifest. For example, `msmarco.v1.json` references `doc_0000.md` through `doc_0999.md`. Files outside that name range are ignored by the bench but still indexed.

The simplest path is to assemble a corpus from the original MS MARCO / DBpedia data dumps, converting each passage / abstract into a markdown file numbered to match the judgment manifest. The exact reproduction recipe is a future workstream — for now this README documents the format and the bench skips gracefully when the corpus is absent.

## What `npm run bench:quality` does today

- ✅ Dispatches correctly to `section6_bench.ts` via `tooling/benchmarks/runner.ts`
- ✅ Skips datasets whose corpus directory is missing, with a clear message
- ⚠️  Exits 2 under `--enforce` if *all* datasets were skipped (no usable corpus)
- ⚠️  Real quality numbers require a populated corpus

This is the honest framing: the quality gate is **operational** but requires fixtures that are intentionally not in the repo. Provide the corpora and `bench:quality` will produce real numbers.
