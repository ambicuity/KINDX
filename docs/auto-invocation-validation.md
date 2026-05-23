# Auto-Invocation Validation Matrix

Refresh this file per release. For each client, run the scripted prompt below and record whether the agent auto-fires `query` without being asked to "search".

**Scripted prompt:** "What did I write about <topic that exists in your collections>?"

| Client | Version | Auto-fires `query`? | Notes |
|---|---|---|---|
| Claude Code | | | |
| Claude Desktop (macOS) | | | |
| Cursor | | | |
| Continue | | | |
| OpenCode | | | |
| Codex CLI | | | |
| Copilot CLI | | | |
| Zed | | | |
| Ollama (via bridge) | | | |

## How to add a row

1. Install kindx: `npm install -g @ambicuity/kindx`
2. Wire: `kindx init --client <name>`
3. Restart the client.
4. Run the scripted prompt without saying "search".
5. Record the outcome.
