# Screenshot 03: Embedding Progress

## Description

Shows KINDX generating embeddings for every collection that has pending documents.

## Command

```bash
$ kindx embed
```

## Expected Terminal Output

```text
$ kindx embed
Embedding pending documents...
  Model: embeddinggemma-300M
  Collections with pending work: my-docs
  Documents: 34 total, 34 pending

  ██████████████████████░░░░░░░░░░░░░░░░░░ 22/34 (64%)  ETA: 4s
  Current: architecture-overview.md (2,847 tokens)
```

After completion:

```text
$ kindx embed
Embedding pending documents...
  Model: embeddinggemma-300M
  Collections with pending work: my-docs
  Documents: 34 total, 34 pending

  ████████████████████████████████████████ 34/34 (100%)

  Embedding complete:
    Documents embedded: 34
    Time: 6.1s (5.6 docs/sec)
    Collections updated: my-docs
```

## Annotations

- **Global embed command:** `kindx embed` processes all collections with pending work instead of taking a collection name argument.
- **Default local model:** KINDX uses a bundled local embedding model, so no API key is required for embedding.
- **Progress bar:** Shows progress, ETA, and the current document being processed.
- **Incremental behavior:** Re-running `kindx embed` only processes new or changed content.
