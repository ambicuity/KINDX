# KINDX MCP Client Integration Templates

## Overview

This reference shows minimal, current templates for connecting MCP-capable coding agents to KINDX over HTTP.

KINDX endpoint used in all examples:

- `http://localhost:8181/mcp`

Preferred server startup:

```bash
kindx mcp --http --port 8181
```

---

## Shared Prerequisites

1. Start KINDX HTTP MCP:

```bash
kindx mcp --http --port 8181
```

2. Optional auth (recommended for shared hosts):

```bash
export KINDX_MCP_TOKEN="replace-with-strong-token"
```

3. If auth is enabled, clients should send:

- `Authorization: Bearer ${KINDX_MCP_TOKEN}`

---

## Claude Code

Client type: CLI command + `.mcp.json` (JSON)

Config path (project scope): `.mcp.json`  
Config path (user/local scope): managed by `claude mcp add`

### Command-based setup (preferred)

```bash
claude mcp add --transport http kindx http://localhost:8181/mcp \
  --header "Authorization: Bearer ${KINDX_MCP_TOKEN}"
```

### JSON config snippet (`.mcp.json`)

```json
{
  "mcpServers": {
    "kindx": {
      "type": "http",
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer ${KINDX_MCP_TOKEN}"
      }
    }
  }
}
```

Auth note: use bearer header as shown.

Validation: run `claude mcp list` and confirm `kindx` is connected.

---

## Codex

Client type: `config.toml` (TOML) and `codex mcp` CLI

Config path: `~/.codex/config.toml`

### TOML snippet

```toml
[mcp_servers.kindx]
url = "http://localhost:8181/mcp"
bearer_token_env_var = "KINDX_MCP_TOKEN"
```

### Optional CLI add command

```bash
codex mcp add kindx --url http://localhost:8181/mcp
```

Auth note: for HTTP MCP, use `bearer_token_env_var = "KINDX_MCP_TOKEN"`.

Validation: run `codex mcp list` and confirm `kindx` appears.

---

## Cursor

Client type: `mcp.json` (JSON)

Config path (project): `.cursor/mcp.json`  
Config path (global): `~/.cursor/mcp.json`

### JSON snippet

```json
{
  "mcpServers": {
    "kindx": {
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer ${KINDX_MCP_TOKEN}"
      }
    }
  }
}
```

Auth note: bearer header supported in MCP JSON config.

Validation: run `cursor-agent mcp list` and confirm `kindx` is connected.

---

## Gemini CLI

Client type: `settings.json` (JSON) + `gemini mcp` CLI

Config path (global): `~/.gemini/settings.json`  
Config path (project): `.gemini/settings.json`

### Command-based setup (preferred)

```bash
gemini mcp add --transport http \
  --header "Authorization: Bearer ${KINDX_MCP_TOKEN}" \
  kindx http://localhost:8181/mcp
```

### JSON snippet (`settings.json`)

```json
{
  "mcpServers": {
    "kindx": {
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer ${KINDX_MCP_TOKEN}"
      }
    }
  }
}
```

Auth note: bearer header supported via `--header` and JSON config.

Validation: run `gemini mcp list` and confirm `kindx` is listed as connected.

---

## Antigravity

Client type: `mcp_config.json` (JSON)

Config path: `~/.gemini/antigravity/mcp_config.json`

### JSON snippet (bridge via `mcp-remote`)

```json
{
  "mcpServers": {
    "kindx": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:8181/mcp",
        "--header",
        "Authorization: Bearer ${KINDX_MCP_TOKEN}"
      ]
    }
  }
}
```

Auth note: bearer header passed through `mcp-remote`.

Validation: open Antigravity MCP server manager and confirm `kindx` is connected and tools are visible.

---

## OpenDevin (OpenHands)

Client type: `config.toml` (TOML)

Config path: `~/.openhands/config.toml` (or project `config.toml` for CLI mode)

### TOML snippet (`shttp_servers`)

```toml
[mcp]
shttp_servers = [
  { url = "http://localhost:8181/mcp", api_key = "${KINDX_MCP_TOKEN}" }
]
```

Auth note: OpenHands uses `api_key` field for authenticated SHTTP servers.

Validation: run OpenHands, execute `/mcp`, and confirm `kindx` is active.

---

## Goose

Client type: command-based setup (`goose configure`) + YAML-backed config

Config path:  
- macOS/Linux: `~/.config/goose/config.yaml`  
- Windows: `%APPDATA%\\Block\\goose\\config\\config.yaml`

### CLI setup snippet

```bash
goose configure
```

Use:
1. `Add Extension`
2. `Remote Extension (Streamable HTTP)`
3. Name: `kindx`
4. Endpoint: `http://localhost:8181/mcp`
5. Header:
   - Name: `Authorization`
   - Value: `Bearer ${KINDX_MCP_TOKEN}`

Auth note: use custom request header for bearer token.

Validation: run `goose` and confirm `kindx` extension tools are available in session.

---

## Compatibility Notes

- KINDX server is HTTP MCP at `http://localhost:8181/mcp`.
- Prefer direct streamable HTTP clients when supported (Claude Code, Codex, Cursor, Gemini CLI, OpenHands/OpenDevin, Goose remote extension).
- Use `mcp-remote` bridge when a client path is stdio-oriented or when direct remote config is client-specific.
- Config format by client:
  - Claude Code: JSON (`.mcp.json`) and CLI
  - Codex: TOML (`~/.codex/config.toml`) and CLI
  - Cursor: JSON (`mcp.json`)
  - Gemini CLI: JSON (`settings.json`) and CLI
  - Antigravity: JSON (`mcp_config.json`)
  - OpenDevin/OpenHands: TOML (`config.toml`)
  - Goose: CLI-managed YAML-backed config

---

## Validation Checklist

1. Server reachable:

```bash
curl -i http://localhost:8181/health
```

2. Metrics exposed:

```bash
curl -s http://localhost:8181/metrics | head
```

3. Auth behavior (if token enabled):
- request without bearer should fail
- request with bearer should pass

4. In client:
- list MCP servers
- ensure `kindx` is connected
- run `status`, then `query`, then `get`

---

## Troubleshooting

- Connection refused:
  - Ensure KINDX is running on `8181`
  - Confirm endpoint is `http://localhost:8181/mcp`
- Unauthorized:
  - Check `KINDX_MCP_TOKEN` is exported in the client environment
  - Ensure header is exactly `Authorization: Bearer ${KINDX_MCP_TOKEN}`
- Server listed but tools unavailable:
  - Restart client after config edits
  - Re-run client MCP list/status command
- Transport mismatch:
  - Use streamable HTTP config where available
  - If a client only accepts stdio-style entries in your environment, use `mcp-remote` bridge
- Version drift:
  - For rapidly evolving clients, verify against latest official MCP config docs before release
