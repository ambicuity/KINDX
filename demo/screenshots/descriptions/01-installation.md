# Screenshot 01: Installation

## Description

Shows the terminal output after installing KINDX globally via npm and verifying that the current CLI is available on `PATH`.

## Command

```bash
$ npm install -g @ambicuity/kindx
```

## Expected Terminal Output

```text
$ npm install -g @ambicuity/kindx

added 87 packages in 12s

14 packages are looking for funding
  run `npm fund` for details

$ kindx --version
kindx 1.0.1

$ kindx --help
kindx -- Knowledge INDexer

Usage:
  kindx <command> [options]

Primary commands:
  kindx query <query>             - Hybrid search with auto expansion + reranking
  kindx search <query>            - Full-text BM25 keywords
  kindx vsearch <query>           - Vector similarity only
  kindx get <file>[:line] [-l N]  - Show a single document
  kindx multi-get <pattern>       - Batch fetch via glob or comma-separated list
  kindx mcp                       - Start the MCP server
```

## Annotations

- **Package scope:** The published npm package is `@ambicuity/kindx`.
- **`kindx --version`:** Confirms the CLI is installed and on `PATH`.
- **Command list:** Highlights the current search, retrieval, and MCP entry points.
- **No sudo required:** The install works without elevated permissions when your npm global prefix is configured correctly.
