# Troubleshooting

## Error message shape

Every error has the same shape (pretty mode):

```text
Error: <what failed>
  why: <diagnostic>
  fix: <next step>
       <example command>
```

In JSON (`--format json`), the same data is the [error envelope](./json-schemas.md#error-envelope). Branch on `error.code`, not on `error.what` (which may be reworded).

## Common errors and fixes

### `config.missing` / `index.cant_open`

> Error: Cannot open database file

```bash
kindx init                  # bootstrap a fresh index
kindx --workspace other ... # or use a different named index
```

### `index.corrupted` (`SQLITE_NOTADB`)

> Error: Index file is corrupted or not a valid database

```bash
kindx cleanup
kindx update
# If still bad:
kindx backup restore <path>  # restore from a recent backup
```

### `index.busy` (`SQLITE_BUSY`)

> Error: Database is locked by another process

```bash
kindx status              # check who holds the DB
kindx mcp stop            # if the daemon is the culprit
```

If `kindx watch` is running, stop it; the daemon holds a write lock during indexing batches.

### `dependency.missing`

> Error: GGUF model not found / extractor unavailable

```bash
kindx pull                # download default models
kindx doctor              # see exactly which check is failing
```

Install system tools (poppler for PDF, libreoffice for DOCX) where prompted.

### `network.unreachable`

> Error: Remote OpenAI-compatible backend unreachable

Check that the URL in your config is reachable (no proxy, no auth wall) and that the backend is running. KINDX will fall back to local models when remote is unreachable if both are configured.

### MCP / token problems

If `kindx mcp --http` reports an auth failure, run:

```bash
kindx mcp status --format json
```

The output shows whether a token is configured and reveals only the last four characters (`tokenLast4`). The raw token is **never** printed.

To rotate:

```bash
export KINDX_AUTH_TOKEN=<new-token>
kindx mcp stop
kindx mcp --http --daemon --port 8181
```

### TUI: terminal stuck after a crash

Run `reset` (or `stty sane && printf '\033[?1049l\033[?25h'`) to restore the terminal. The TUI installs handlers that recover automatically; this should only happen if the parent shell was killed.

### Non-TTY behavior

- `kindx tui` and `kindx init` refuse to run without an interactive terminal (exit 2). Use the non-interactive recipe printed in the message, or pass `--yes` to override `init`.
- All other commands work in CI; `--quiet`/`-q` (or `KINDX_PROGRESS=off`) suppresses progress output on stderr.
- Progress paint mode is auto-selected from your terminal:
  - TTY + color + UTF-8 → animated spinners (`⠋`), collapse to `✓ <phase> (Nms)` on completion.
  - Piped / CI / NO_COLOR → persistent `▸ <phase>…` log lines with timing.
  - `--format json|csv|md|xml|files` → NDJSON events on stderr (one JSON object per line). stdout stays clean for `jq` and friends.
- Force UTF-8 glyphs in CI environments with a missing locale: `KINDX_FORCE_UTF8=1`.

## Migration: `kindx arch` removed

In v1.3 the `kindx arch` command group was removed. Its code was relocated to `experiments/arch/` (not built into the main CLI). Scripts that called any `kindx arch <sub>` subcommand will now see:

```text
The 'kindx arch' command was removed in v1.3.
  See: docs/troubleshooting.md#arch-removed
  Migration: experiments/arch/ contains the relocated code.
```

(Exit code 2, distinct from the generic "Unknown command" exit code 1, so scripts can branch on the migration case.)

If you still need the architectural-scanning behavior:

- The relocated code lives under `experiments/arch/` in the repository. It is unsupported and may change without notice.
- The replacement workflow is to use `kindx query` against your own indexed code with structured queries (e.g., `lex: <symbol> vec: <concept>`).

## Reporting an issue

When opening an issue, please include:

```bash
kindx --version
kindx doctor --format json
kindx status --format json
```

These produce stable JSON outputs that reproduce most environment state without leaking secrets.
