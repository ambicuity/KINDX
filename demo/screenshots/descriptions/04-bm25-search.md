# Screenshot 04: BM25 Search

## Description

Shows a BM25 keyword search returning ranked results from a single collection.

## Command

```bash
$ kindx search "API design patterns" -c my-docs
```

## Expected Terminal Output

```text
$ kindx search "API design patterns" -c my-docs
BM25 Search: "API design patterns" (5 results)

  #1  [14.2] kindx://my-docs/api-reference.md
      "Follow RESTful design patterns: use nouns for resource paths,
       HTTP verbs for actions, and maintain consistent error response
       formats across all endpoints..."

  #2  [11.8] kindx://my-docs/style-guide.md
      "API design patterns to follow: pagination via cursor tokens,
       filtering through query parameters, and versioning in the URL
       path (e.g., /v2/resources)..."

  #3  [9.4]  kindx://my-docs/architecture.md
      "The service layer implements common API design patterns including
       the repository pattern for data access and the mediator pattern
       for cross-cutting concerns..."
```

## Annotations

- **BM25 scores:** Raw lexical relevance scores. Higher values indicate stronger keyword matches.
- **Virtual URIs:** Results use `kindx://<collection>/<path>` so the same paths work across CLI and MCP flows.
- **Snippets:** KINDX shows the most relevant passage from each document.
- **Result count:** The default is 5 results, and you can change it with `-n N`.
