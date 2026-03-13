# Screenshot 07: JSON Output

## Description

Shows the `--json` flag producing structured JSON output suitable for programmatic consumption, piping to other tools, or integration with scripts and agent pipelines.

## Command

```bash
$ kindx search "API design" -c my-docs --json
```

## Expected Terminal Output

```json
$ kindx search "API design" -c my-docs --json
[
  {
    "uri": "kindx://my-docs/api-reference.md",
    "score": 14.2,
    "snippet": "Follow RESTful design patterns: use nouns for resource paths, HTTP verbs for actions, and maintain consistent error response formats across all endpoints.",
    "path": "/Users/demo/Documents/api-reference.md",
    "modified": "2026-02-20T14:32:00Z"
  },
  {
    "uri": "kindx://my-docs/style-guide.md",
    "score": 11.8,
    "snippet": "API design patterns to follow: pagination via cursor tokens, filtering through query parameters, and versioning in the URL path.",
    "path": "/Users/demo/Documents/style-guide.md",
    "modified": "2026-01-15T09:10:00Z"
  },
  {
    "uri": "kindx://my-docs/architecture.md",
    "score": 9.4,
    "snippet": "The service layer implements common API design patterns including the repository pattern for data access and the mediator pattern for cross-cutting concerns.",
    "path": "/Users/demo/Documents/architecture.md",
    "modified": "2026-03-01T11:45:00Z"
  },
  {
    "uri": "kindx://my-docs/contributing.md",
    "score": 6.2,
    "snippet": "When adding new API endpoints, follow the established design patterns documented in the style guide.",
    "path": "/Users/demo/Documents/contributing.md",
    "modified": "2026-02-08T16:20:00Z"
  },
  {
    "uri": "kindx://my-docs/changelog.md",
    "score": 4.1,
    "snippet": "v2.1: Refactored API layer to use consistent design patterns for error handling and response formatting.",
    "path": "/Users/demo/Documents/changelog.md",
    "modified": "2026-03-10T08:00:00Z"
  }
]
```

## Annotations

- **JSON array format:** The `--json` flag outputs a flat JSON array of result objects — no envelope wrapper. Each object contains `uri`, `score`, `snippet`, `path`, and `modified`.
- **`uri` field:** The virtual `kindx://` URI for referencing results consistently. This is the same URI shown in human-readable output.
- **`path`:** The absolute filesystem path to the source document. Useful for scripts that need to open or process the original file.
- **`modified`:** ISO 8601 timestamp of the document's last modification. Enables freshness filtering in downstream tools.
- **Piping example:** The JSON output is valid and can be piped directly: `kindx search "API design" -c my-docs --json | jq '.[0].uri'` returns `"kindx://my-docs/api-reference.md"`.
- **Agent integration:** MCP agents receive this same JSON structure when calling KINDX search tools, making the CLI output a faithful preview of what agents see.
