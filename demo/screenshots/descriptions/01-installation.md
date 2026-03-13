# Screenshot 01: Installation

## Description

Shows the terminal output after installing KINDX globally via npm. The screenshot captures the full installation flow including package resolution, download, and the post-install confirmation.

## Command

```bash
$ npm install -g @ambiguity/kindx
```

## Expected Terminal Output

```
$ npm install -g @ambiguity/kindx

added 87 packages in 12s

14 packages are looking for funding
  run `npm fund` for details

$ kindx --version
kindx 1.0.1

$ kindx --help
Usage: kindx <command> [options]

Commands:
  kindx collection <action>  Manage document collections
  kindx embed                Embed documents in a collection
  kindx search               BM25 keyword search
  kindx vsearch              Vector similarity search
  kindx query                Hybrid search (BM25 + vector)
  kindx serve                Start MCP server
  kindx demo                 Set up a demo collection

Options:
  --version  Show version number                               [boolean]
  --help     Show help                                         [boolean]
```

## Annotations

- **Package count (87 packages):** KINDX bundles its embedding model and dependencies; no native compilation required.
- **`kindx --version`:** Confirms the CLI is available on PATH after global install.
- **Command list:** Highlights the core commands -- collection management, three search modes, MCP server, and the demo shortcut.
- **No sudo required:** The install runs without elevated permissions (assuming npm prefix is configured correctly).
