# KINDX JSON Output Contract

KINDX's `--format json` output is documented and **stable across patch releases**. Script authors and downstream tooling should write against the envelope below, not against the legacy bare-object shape.

The envelope is currently **opt-in** while we migrate every command. To opt in:

- Set `KINDX_JSON_ENVELOPE=1` in the environment, or
- Use `--format json` (preferred). Legacy `--json` keeps its current shape for backward compatibility.

In the next major release, the envelope becomes the default for both `--json` and `--format json`.

## Success envelope

```json
{
  "ok": true,
  "command": "search",
  "data": { /* command-specific payload */ },
  "warnings": ["optional, omitted if empty"],
  "meta": { "elapsedMs": 42 }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `ok` | `true` | Always present on success. |
| `command` | string | Name of the dispatched command (e.g. `"search"`, `"doctor"`). |
| `data` | object | Command-specific payload. See per-command sections. |
| `warnings` | string[] | Optional list of non-fatal warnings; omitted when empty. |
| `meta` | object | Optional metadata: `elapsedMs`, `version`, `requestId`, etc. |

## Error envelope

```json
{
  "ok": false,
  "command": "search",
  "error": {
    "code": "config.missing",
    "what": "Cannot open index",
    "why": "/Users/me/.kindx/index.db is missing",
    "fix": "Run `kindx init` to bootstrap the index",
    "examples": ["kindx init", "kindx --index other"]
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `ok` | `false` | Always present on error. |
| `command` | string \| undefined | Name of the dispatched command, if known. |
| `error.code` | string | Stable machine-readable code; safe to branch on. |
| `error.what` | string | One-line summary. |
| `error.why` | string? | Optional diagnostic detail. |
| `error.fix` | string? | Optional human-readable next step. |
| `error.examples` | string[]? | Optional list of suggested commands. |

Exit codes paired with `error.code`:

| `code` | exit |
| --- | --- |
| `internal`, `index.busy` | 1 |
| `usage` | 2 |
| `config.missing`, `config.invalid`, `index.cant_open` | 3 |
| `dependency.missing` | 4 |
| `network.unreachable` | 5 |
| `permission.denied` | 6 |
| `not_found` | 7 |
| `index.corrupted` | 65 |

## Per-command data shapes

### `search`, `query`, `vsearch`

```json
{
  "ok": true,
  "command": "search",
  "data": [
    {
      "docid": "#abc123",
      "score": 0.84,
      "file": "kindx://docs/auth.md",
      "title": "Authentication",
      "context": "How auth works",
      "snippet": "JWT tokens are issued on login..."
    }
  ]
}
```

When `--explain` is set, each row gains an `explain` object with FTS / vector / RRF / rerank details.

### `doctor` (envelope-on)

```json
{
  "ok": true,
  "command": "doctor",
  "data": {
    "status": "warn",
    "checks": [
      { "id": "sqlite_vec", "severity": "ok", "detail": "ok" },
      { "id": "models", "severity": "warn", "detail": "missing: qwen3-reranker-0.6b" }
    ]
  }
}
```

`severity` ∈ `ok | warn | error | skip | rec`. The legacy `{ status, checks: [{ id, ok, detail }] }` shape is still emitted when the envelope is off.

### `status`

```json
{
  "ok": true,
  "command": "status",
  "data": {
    "index":    { "path": "...", "sizeBytes": 1234 },
    "mcp":      { "running": true, "pid": 4242, "transport": "http", "endpoint": "http://localhost:8181/mcp" },
    "watch":    { "running": false },
    "documents": { "total": 100, "vectors": 100, "needsEmbedding": 0, "mostRecent": "..." },
    "capabilities": { "ann": "centroid-v1", "encryption": "none", "extractors": "..." },
    "encryption":  { "encrypted": false, "keyConfigured": false },
    "ann": { "mode": "exact", "state": "missing", "probeCount": 4, "shortlistLimit": 400 },
    "collections": [{ "name": "docs", "glob": "**/*.md", "active": 12, "lastModified": "..." }]
  }
}
```

### `mcp status`

```json
{
  "ok": true,
  "command": "mcp",
  "data": {
    "transport": "daemon",
    "host": "localhost",
    "port": 8181,
    "authMode": "bearer",
    "tokenConfigured": true,
    "tokenLast4": "XYZW",
    "pid": 4242,
    "pidPath": "/.../mcp.pid",
    "logPath": "/.../mcp.log",
    "endpoints": {
      "mcp": "http://localhost:8181/mcp",
      "health": "http://localhost:8181/health",
      "metrics": "http://localhost:8181/metrics"
    },
    "stopCommand": "kindx mcp stop"
  }
}
```

The raw token is **never** included; only `tokenLast4` and `tokenConfigured`.

### `verify-wipe`

```json
{
  "ok": true,
  "command": "verify-wipe",
  "data": {
    "status": "fully_wiped",
    "cacheRoot": "...",
    "configRoot": "...",
    "indexPath": "...",
    "residualFiles": []
  }
}
```

### `scheduler status`

```json
{
  "ok": true,
  "command": "scheduler",
  "data": { "shard": { ... }, "checkpoint": { ... }, "queue": [ ... ] }
}
```

## Stderr NDJSON progress events

When `--format` is `json|csv|md|xml|files`, KINDX emits one JSON event per line on **stderr** while the command runs. stdout stays clean for the formatted payload — scripts can capture both:

```sh
kindx query "auth" --format json 1>out.json 2>events.ndjson
jq -c . events.ndjson    # parses cleanly
```

Event shape:

```json
{"event":"phase-start","name":"expand","label":"Expanding query"}
{"event":"phase-end",  "name":"expand","durationMs":1700,"detail":{"variants":6}}
{"event":"warn", "name":"missing-embeddings","code":"missing-embeddings",
                 "message":"5072 documents (55%) need embeddings…",
                 "detail":{"count":5072,"totalDocs":9283,"pct":55}}
{"event":"error","name":"rerank-failed","code":"rerank-failed","message":"…"}
```

| Field | Type | Description |
| --- | --- | --- |
| `event` | `"phase-start"`, `"phase-end"`, `"warn"`, `"error"` | Discriminant. |
| `name` | string | Phase identifier (`expand`, `search`, `embed`, `rerank`, …) or warning/error code. |
| `label` | string | Human-readable phase label (only on `phase-start`). |
| `durationMs` | number | Phase duration (only on `phase-end`). |
| `code` | string | Stable warning/error code (only on `warn` / `error`). |
| `message` | string | Human-readable message (only on `warn` / `error`). |
| `detail` | object \| array | Optional structured payload — e.g. `{count, pct}` for `missing-embeddings`, `{variants: 6}` for `expand`. |

The set of `name` values per command is **stable** within a major version. Consumers should branch on `name` (or `code` for warnings/errors), not on `label` or `message`.

Suppress these events entirely with `--quiet` / `-q` or `KINDX_PROGRESS=off`.

## Stability guarantees

- Adding fields is **not** a breaking change. Consumers must ignore unknown fields.
- Renaming or removing fields is a breaking change and requires a major version bump.
- `ok`, `command`, `error.code`, and the top-level success/error shape will never change in a backward-incompatible way without a major bump.
- `severity` values for diagnostic checks are a closed set; new severities will not be introduced silently.
