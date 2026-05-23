# KINDX + Ollama (bridge pattern)

Ollama does not speak MCP natively as of this writing. To use kindx auto-invocation with an Ollama-backed agent, run a small bridge that exposes kindx tools as Ollama functions.

## Quick start (manual)

1. Start kindx in HTTP mode: `kindx mcp --http --port 8181 --daemon`
2. Run an MCP→Ollama bridge (e.g. `mcp-ollama-bridge`, community projects). Point it at `http://localhost:8181/mcp`.
3. Configure your Ollama client to call the bridge's tool endpoint on every chat turn.

## Why no `kindx init --client ollama` yet

Ollama has no canonical MCP config file to write to. The bridge varies per setup. We'll add a first-class adapter when an Ollama-side standard emerges.
