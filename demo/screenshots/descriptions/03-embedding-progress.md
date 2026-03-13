# Screenshot 03: Embedding Progress

## Description

Shows the embedding process in action with a live progress bar. The screenshot captures KINDX generating vector embeddings for all documents in a collection using the local ONNX model.

## Command

```bash
$ kindx embed my-docs
```

## Expected Terminal Output

```
$ kindx embed my-docs
Embedding "my-docs"...
  Model: all-MiniLM-L6-v2 (384 dimensions)
  Documents: 34 total, 34 pending, 0 cached

  ██████████████████████░░░░░░░░░░░░░░░░░░ 22/34 (64%)  ETA: 4s
  Current: architecture-overview.md (2,847 tokens)
```

After completion:

```
$ kindx embed my-docs
Embedding "my-docs"...
  Model: all-MiniLM-L6-v2 (384 dimensions)
  Documents: 34 total, 34 pending, 0 cached

  ████████████████████████████████████████ 34/34 (100%)

  Embedding complete:
    Documents embedded: 34
    Time: 6.1s (5.6 docs/sec)
    Vector index saved to ~/.kindx/my-docs/vectors.idx

$ kindx collection list
  NAME       DOCS   EMBEDDED   SOURCE
  my-docs    34     34         /Users/demo/Documents
```

## Annotations

- **Model name (`all-MiniLM-L6-v2`):** The embedding model bundled with KINDX. Runs locally via ONNX Runtime -- no API calls, no network required.
- **384 dimensions:** Each document is represented as a 384-dimensional vector. This is the model's native output size.
- **Progress bar:** Real-time progress with document count, percentage, and ETA. Shows which document is currently being processed.
- **Pending vs cached:** On re-runs, only new or changed documents are embedded. Unchanged documents use cached embeddings, making incremental updates fast.
- **Processing speed (~5.6 docs/sec):** Typical throughput on a modern laptop CPU. Larger documents take proportionally longer due to token count.
- **Vector index path:** Embeddings are stored locally in `~/.kindx/<collection>/vectors.idx`. This file is used for all vector and hybrid searches.
- **Collection list (EMBEDDED column):** After embedding, the count updates from 0 to 34, confirming all documents are indexed.
