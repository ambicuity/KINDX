# KINDX CLI Reference

This is the long-form companion to `kindx --help`. Run `kindx <command> --help` for per-command help with flags and examples.

## Output system

Every command shares a single output system.

| Mode | When chosen | Notes |
| --- | --- | --- |
| `pretty` | Default on a TTY without `NO_COLOR` | Colored, decorated. |
| `plain` | Default off-TTY (pipes, CI) | ANSI-stripped, deterministic. |
| `json` | `--format json` or `--json` | Stable, scriptable. |

Selection precedence (highest first):

1. `--format <value>`
2. Legacy boolean flags (`--json`, `--csv`, `--md`, `--xml`, `--files`, `--plain`)
3. `KINDX_OUTPUT` env var (e.g. `KINDX_OUTPUT=json`)
4. TTY auto-detection

Color helpers:

- `--no-color` always disables ANSI.
- `--color` forces ANSI even off-TTY (for `less -R`).
- `NO_COLOR=1` is honored throughout.

## Global flags

| Flag | Purpose |
| --- | --- |
| `--help`, `-h` | Per-command help if a command is named; otherwise root help. |
| `--version`, `-v` | Print version. |
| `--index <name>`, `--workspace <name>` | Use a named index (default: `index`). |
| `--config <path>` | Override config path. |
| `--profile <name>` | Use a named config profile. |
| `--format <mode>` | `pretty\|cards\|table\|lines\|plain\|json\|csv\|md\|xml\|files`. |
| `--plain`, `--no-color`, `--color` | Output adjustments. |
| `--verbose`, `--quiet`, `--debug`, `--trace` | Verbosity. |
| `--limit <n>`, `-n <n>` | Max results / items. |
| `--collection <name>`, `-c <name>` | Filter to one or more collections (repeatable). |
| `--timeout <ms>` | Cap long-running operations. |
| `--yes`, `-y`, `--confirm` | Skip confirmation prompts. |
| `--dry-run` | Plan but do not modify state. |
| `--interactive`, `-i` | Open TUI variant for the command (when supported). |

## Progress output

`kindx query` and other long-running commands stream progress to **stderr** while writing results to stdout. The paint mode is chosen automatically:

| Stderr mode | When chosen | Looks like |
| --- | --- | --- |
| `pretty-tty` | Interactive terminal with color + UTF-8 | Animated `⠋` spinner per phase, collapses to `✓ <phase> (Nms)` on completion. |
| `pretty-log` | Piped, CI, or NO_COLOR — but format is still pretty | Persistent `▸ <phase>…` line on start; `  ✓ <phase> (Nms)` on completion. |
| `ndjson`     | `--format json\|csv\|md\|xml\|files` | One JSON event per phase + warning, written to stderr; stdout stays pure. |
| `silent`     | `--quiet` / `-q` or `KINDX_PROGRESS=off` | Stderr suppressed except for errors. |

NDJSON event schema (one per line on stderr):

```json
{"event":"phase-start","name":"expand","label":"Expanding query"}
{"event":"phase-end",  "name":"expand","durationMs":1700,"detail":{"variants":6}}
{"event":"warn", "name":"missing-embeddings","code":"missing-embeddings",
                 "message":"5072 documents (55%) need embeddings…",
                 "detail":{"count":5072,"totalDocs":9283,"pct":55}}
{"event":"error","name":"rerank-failed","code":"rerank-failed","message":"…"}
```

Useful invocations:

```sh
# Capture NDJSON events while piping JSON results to jq:
kindx query "auth" --format json 2>events.ndjson | jq '.[] | .file'

# Silence stderr entirely (scripts that don't care about progress):
kindx query "auth" --quiet
KINDX_PROGRESS=off kindx query "auth"     # same effect, no flag

# Force UTF-8 glyphs in environments with a missing locale (CI):
KINDX_FORCE_UTF8=1 kindx query "auth"
```

## Search formats

`--format snippets|cards|table|lines` switch between four pretty layouts for `query`, `search`, and `vsearch`. `snippets` is the default (legacy look):

```text
$ kindx query auth
kindx://docs/auth.md:12 #abc123
Title: Authentication
Score:  84%

@@ -10,4 @@ (9 before, 30 after)
JWT tokens are issued on login
and verified by middleware.
```

`--format cards|table|lines` switch to alternative layouts:

```text
$ kindx search auth --format cards
#1  kindx://docs/auth.md:12
    Authentication
    score  84%   col: docs   mode: hybrid
    │ JWT tokens are issued on login
    │ and verified by middleware.

Next: kindx get <path>  · open document
       kindx query --explain "auth"  · show retrieval trace
```

```text
$ kindx search auth --format table
#     score   col             path / title
1     84%     docs            kindx://docs/auth.md  Authentication
2     42%     code            kindx://src/jwt.ts  JWT utilities
```

```text
$ kindx search auth --format lines
   1   84%  kindx://docs/auth.md · Authentication
   2   42%  kindx://src/jwt.ts · JWT utilities
```

`--format json` emits the stable envelope — see `docs/json-schemas.md`.

## Onboarding (`kindx init`)

`kindx init` is a guided three-step setup:

1. Register a collection (`kindx collection add ...`)
2. Index documents (`kindx update`)
3. Generate embeddings (`kindx embed`)

It refuses to prompt when stdin is not a TTY or `CI` is set; pass `--yes` to opt in for automation, or use the explicit three-command recipe instead.

## Errors

Every error follows the same shape:

```text
Error: <what failed>
  why: <diagnostic>
  fix: <next step>
       <example command>
```

In JSON mode (`--format json`), the same data appears as the error envelope from `docs/json-schemas.md`. Common error codes:

| `code` | Exit | Meaning |
| --- | --- | --- |
| `internal` | 1 | Unhandled / unknown error. |
| `usage` | 2 | Invalid invocation. |
| `config.missing` / `config.invalid` | 3 | Config not found or unreadable. |
| `dependency.missing` | 4 | Missing model / extractor / system tool. |
| `network.unreachable` | 5 | Remote backend unreachable. |
| `permission.denied` | 6 | File/system permission problem. |
| `not_found` | 7 | Resource not found (doc, collection, etc.). |
| `index.corrupted` | 65 | Database integrity check failed. |

See `docs/troubleshooting.md` for resolution recipes.
