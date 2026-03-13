# Screenshot 04: BM25 Search

## Description

Shows a BM25 keyword search returning ranked results. BM25 (Best Matching 25) is a traditional information retrieval algorithm that scores documents based on term frequency and inverse document frequency.

## Command

```bash
$ kindx search "API design patterns" -c my-docs
```

## Expected Terminal Output

```
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

  #4  [6.2]  kindx://my-docs/contributing.md
      "When adding new API endpoints, follow the established design
       patterns documented in the style guide..."

  #5  [4.1]  kindx://my-docs/changelog.md
      "v2.1: Refactored API layer to use consistent design patterns
       for error handling and response formatting..."
```

## Annotations

- **BM25 scores (e.g., 14.2):** Raw BM25 relevance scores. Higher values indicate stronger keyword matches. Scores are not normalized to 0-1; they depend on corpus statistics.
- **Virtual URIs (`kindx://my-docs/...`):** Each result uses the KINDX virtual path format: `kindx://<collection>/<filename>`. These URIs are consistent across all search modes.
- **Snippets:** The most relevant passage from each document, with the matching terms in context. Snippets are extracted from the highest-scoring passage within the document.
- **Result count (5):** Default is 5 results. Configurable with `--top N`.
- **Exact keyword matching:** BM25 excels when the query terms appear literally in the documents. Notice all results contain the exact words "API", "design", and/or "patterns".
- **Score falloff:** The steep drop from #1 (14.2) to #5 (4.1) shows clear relevance differentiation -- the top results are strongly relevant while lower results are tangentially related.
