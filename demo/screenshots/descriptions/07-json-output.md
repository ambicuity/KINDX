# Screenshot 07: JSON Output

## Description

Shows the `--json` flag producing the current structured search result schema for scripts, agents, and downstream tools.

## Command

```bash
$ kindx search "API design" -c my-docs --json
```

## Expected Terminal Output

```json
$ kindx search "API design" -c my-docs --json
[
  {
    "docid": "#762e73",
    "score": 0.55,
    "file": "kindx://my-docs/api-reference.md",
    "title": "API Design Principles",
    "snippet": "Follow RESTful design patterns: use nouns for resource paths, HTTP verbs for actions, and maintain consistent error response formats across all endpoints."
  },
  {
    "docid": "#94bb19",
    "score": 0.41,
    "file": "kindx://my-docs/style-guide.md",
    "title": "API Style Guide",
    "snippet": "API design patterns to follow: pagination via cursor tokens, filtering through query parameters, and versioning in the URL path."
  },
  {
    "docid": "#c6a210",
    "score": 0.29,
    "file": "kindx://my-docs/architecture.md",
    "title": "Architecture Overview",
    "snippet": "The service layer implements common API design patterns including the repository pattern for data access and the mediator pattern for cross-cutting concerns."
  }
]
```

## Annotations

- **Flat JSON array:** `--json` returns a bare array rather than a wrapped envelope object.
- **Current fields:** Each result contains `docid`, `file`, `title`, `score`, and `snippet`.
- **Virtual path:** The `file` field is the same `kindx://` path shown in human-readable output.
- **Piping example:** `kindx search "API design" -c my-docs --json | jq -r '.[0].file'` extracts the top result path.
