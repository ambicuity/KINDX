# Screenshot 02: Collection Setup

## Description

Shows the process of creating a new document collection by pointing KINDX at a local directory. The screenshot captures the collection creation confirmation and initial document scan.

## Command

```bash
$ kindx collection add my-docs ~/Documents
```

## Expected Terminal Output

```
$ kindx collection add my-docs ~/Documents
Collection "my-docs" created
  Source: /Users/demo/Documents
  Documents found: 34

  Breakdown by type:
    .md     18 files
    .txt     9 files
    .pdf     5 files
    .py      2 files

  Next steps:
    kindx collection update my-docs   # Build BM25 index
    kindx embed my-docs               # Generate vector embeddings

$ kindx collection list
  NAME       DOCS   EMBEDDED   SOURCE
  my-docs    34     0          /Users/demo/Documents
```

## Annotations

- **Collection name (`my-docs`):** User-chosen identifier used in all subsequent commands. Must be unique across collections.
- **Source path:** Absolute path to the directory KINDX will scan. Supports `~` expansion.
- **Documents found (34):** KINDX scanned the directory recursively and found 34 files with supported extensions.
- **Breakdown by type:** Shows the distribution of document types detected. KINDX supports markdown, plain text, PDF, and common code file formats.
- **Next steps:** KINDX suggests the two-step indexing process -- first build the BM25 keyword index with `update`, then generate vector embeddings with `embed`.
- **`collection list`:** Shows the collection registry with document count, embedding status (0 embedded so far), and source path.
