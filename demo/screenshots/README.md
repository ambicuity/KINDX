# KINDX Screenshots

Index of all screenshots used in documentation and promotional materials.

Each screenshot has a corresponding description file in `descriptions/` that documents the exact command, expected output, and annotations.

---

## Screenshot Index

| # | Filename | Description | Description File |
|---|----------|-------------|------------------|
| 01 | `01-installation.png` | Global npm installation output | [descriptions/01-installation.md](descriptions/01-installation.md) |
| 02 | `02-collection-setup.png` | Creating a new document collection | [descriptions/02-collection-setup.md](descriptions/02-collection-setup.md) |
| 03 | `03-embedding-progress.png` | Embedding progress bar during indexing | [descriptions/03-embedding-progress.md](descriptions/03-embedding-progress.md) |
| 04 | `04-bm25-search.png` | BM25 keyword search results | [descriptions/04-bm25-search.md](descriptions/04-bm25-search.md) |
| 05 | `05-vector-search.png` | Vector similarity search results | [descriptions/05-vector-search.md](descriptions/05-vector-search.md) |
| 06 | `06-hybrid-query.png` | Hybrid query with explain mode | [descriptions/06-hybrid-query.md](descriptions/06-hybrid-query.md) |
| 07 | `07-json-output.png` | JSON output for programmatic use | [descriptions/07-json-output.md](descriptions/07-json-output.md) |
| 08 | `08-mcp-inspector.png` | MCP Inspector showing KINDX tools | [descriptions/08-mcp-inspector.md](descriptions/08-mcp-inspector.md) |
| 09 | `09-claude-desktop.png` | Claude Desktop using KINDX in conversation | [descriptions/09-claude-desktop.md](descriptions/09-claude-desktop.md) |
| 10 | `10-explain-mode.png` | Full retrieval trace with explain mode | [descriptions/10-explain-mode.md](descriptions/10-explain-mode.md) |

---

## Capture Guidelines

- **Resolution:** 2x retina (e.g., 2400x1200 for a 1200x600 display area)
- **Format:** PNG for screenshots, GIF/MP4 for recordings
- **Theme:** Catppuccin Mocha or similar dark theme
- **Font:** JetBrains Mono or Fira Code, 14pt
- **Prompt:** Minimal (`$ ` only)
- **Terminal width:** 100 columns

## Regenerating Screenshots

Screenshots can be regenerated from the VHS tape file in `../video-scripts/demo.tape` or captured manually following the commands in each description file.
