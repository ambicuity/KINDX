# KINDX TUI

`kindx tui` opens an interactive terminal UI for searching the index. It is also reachable as `--interactive` on `search`/`query`/`vsearch`:

```bash
kindx tui                            # bare TUI
kindx tui authentication             # pre-fill the search box
kindx search "auth" --interactive    # interactive variant of `search`
kindx tui -c docs                    # filter to the "docs" collection
```

The TUI requires an interactive terminal. If launched without a TTY (CI, piped stdin) it exits with code `2` and prints the equivalent non-interactive command. It is built on raw `readline` + ANSI sequences — no extra dependencies, lazy-loaded only when this command runs.

## Layout

```
┌─ kindx tui ──────────────────────────────────────────────┐
│ > authentication                       [mode: hybrid]    │
│ ──────────────────────────────────────────────────────── │
│ → 1   84%  kindx://docs/auth.md · Authentication         │
│   2   71%  kindx://src/jwt.ts · JWT utilities            │
│   3   55%  kindx://README.md                             │
│                                                          │
│ / search   ↑↓ move   ⏎ open   m mode   c col   ? help    │
└──────────────────────────────────────────────────────────┘
```

The status bar at the bottom is always visible and contains the keyboard hint line. ASCII glyphs are used when the locale is non-UTF-8.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus the search input. |
| Letters | Append to the search query (live-debounced). |
| Backspace | Delete a character. |
| `↑` / `k` | Move selection up. |
| `↓` / `j` | Move selection down. |
| Enter | Open the selected result (details overlay). |
| `m` | Cycle search mode (`hybrid → lex → vec → hyde`). Only on an empty query. |
| `c` | Filter by collection. |
| `r` | Refresh / re-run the current query. |
| `e` | Explain the selected result. |
| `?` | Toggle the keyboard help overlay. |
| Esc | Back / cancel. Clears a non-empty query first; exits if already empty. |
| `q` | Quit. Only when the query buffer is empty. |
| Ctrl-C | Quit immediately. |

## Graceful degradation

- **No TTY** → prints a helpful "requires an interactive terminal" line and exits 2.
- **Narrow terminal** (< 80 cols) → chips next to the prompt are hidden; results still render one-per-line.
- **No Unicode** locale → ASCII glyphs (`[ok]`, `up/down`, `enter`, `>`).
- **No color** (`NO_COLOR` or `--no-color`) → output remains readable; selection uses bold rather than inverse video.

## Recovery

The TUI registers signal handlers so the terminal is always returned to cooked mode + main screen buffer on exit, including on `SIGINT`, `SIGTERM`, and uncaught exceptions. If you ever see a wedged terminal, run `reset` (or `stty sane && printf '\033[?1049l\033[?25h'`) to clean up.

## Caveats

- Vector / hybrid mode requires an embedded index — set up via `kindx embed` first. The TUI currently runs BM25 (`lex`) under the hood; mode-aware execution lands in a follow-up.
- The TUI does not coexist with `kindx mcp` (stdio). They are separate commands.
- Under the Bun ABI shim the CLI re-execs to Node before raw mode is entered, so the TUI is always Node-driven.
