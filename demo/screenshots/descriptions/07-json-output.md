# Screenshot 07: JSON Output

## Description

Shows the `--json` flag producing structured JSON output suitable for programmatic consumption, piping to other tools, or integration with scripts and agent pipelines.

## Command

```bash
$ kindx search my-docs "API design" --json
```

## Expected Terminal Output

```json
$ kindx search my-docs "API design" --json
{
  "query": "API design",
  "mode": "bm25",
  "collection": "my-docs",
  "results": [
    {
      "rank": 1,
      "uri": "kindx://my-docs/api-reference.md",
      "score": 14.2,
      "snippet": "Follow RESTful design patterns: use nouns for resource paths, HTTP verbs for actions, and maintain consistent error response formats across all endpoints.",
      "metadata": {
        "path": "/Users/demo/Documents/api-reference.md",
        "modified": "2026-02-20T14:32:00Z",
        "size": 8421,
        "type": "md"
      }
    },
    {
      "rank": 2,
      "uri": "kindx://my-docs/style-guide.md",
      "score": 11.8,
      "snippet": "API design patterns to follow: pagination via cursor tokens, filtering through query parameters, and versioning in the URL path.",
      "metadata": {
        "path": "/Users/demo/Documents/style-guide.md",
        "modified": "2026-01-15T09:10:00Z",
        "size": 5134,
        "type": "md"
      }
    },
    {
      "rank": 3,
      "uri": "kindx://my-docs/architecture.md",
      "score": 9.4,
      "snippet": "The service layer implements common API design patterns including the repository pattern for data access and the mediator pattern for cross-cutting concerns.",
      "metadata": {
        "path": "/Users/demo/Documents/architecture.md",
        "modified": "2026-03-01T11:45:00Z",
        "size": 12087,
        "type": "md"
      }
    },
    {
      "rank": 4,
      "uri": "kindx://my-docs/contributing.md",
      "score": 6.2,
      "snippet": "When adding new API endpoints, follow the established design patterns documented in the style guide.",
      "metadata": {
        "path": "/Users/demo/Documents/contributing.md",
        "modified": "2026-02-08T16:20:00Z",
        "size": 3290,
        "type": "md"
      }
    },
    {
      "rank": 5,
      "uri": "kindx://my-docs/changelog.md",
      "score": 4.1,
      "snippet": "v2.1: Refactored API layer to use consistent design patterns for error handling and response formatting.",
      "metadata": {
        "path": "/Users/demo/Documents/changelog.md",
        "modified": "2026-03-10T08:00:00Z",
        "size": 6743,
        "type": "md"
      }
    }
  ],
  "timing": {
    "search_ms": 3.2,
    "total_ms": 4.8
  }
}
```

## Annotations

- **Top-level fields:** The JSON envelope includes `query`, `mode`, `collection`, `results`, and `timing` -- all the context needed to interpret the output programmatically.
- **`uri` field:** The virtual `kindx://` URI for referencing results consistently. This is the same URI shown in human-readable output.
- **`metadata.path`:** The absolute filesystem path to the source document. Useful for scripts that need to open or process the original file.
- **`metadata.modified`:** ISO 8601 timestamp of the document's last modification. Enables freshness filtering in downstream tools.
- **`metadata.type`:** File extension indicating document type. Can be used to filter or route results.
- **`timing` object:** Shows search latency in milliseconds. `search_ms` is the index lookup time; `total_ms` includes I/O and formatting.
- **Piping example:** The JSON output is valid and can be piped directly: `kindx search my-docs "API design" --json | jq '.results[0].uri'` returns `"kindx://my-docs/api-reference.md"`.
- **Agent integration:** MCP agents receive this same JSON structure when calling KINDX search tools, making the CLI output a faithful preview of what agents see.
