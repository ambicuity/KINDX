# KINDX Operating Modes Runbook

This runbook documents production-safe operating patterns for the current implementation.

## 1) Solo Local (Single User Workstation)

Use when one developer or operator runs KINDX on a local machine.

Setup:
- Register collections via `kindx collection add ...`
- Run `kindx update` then `kindx embed`
- Use stdio MCP (`kindx mcp`) for editor-local tool calls

Guardrails:
- Keep `KINDX_LLM_BACKEND=local` unless remote inference is intentional
- Run `kindx doctor` after model/runtime changes
- Use `kindx backup create` before major version upgrades

## 2) Team Shared Daemon (Multiple Agents, One Host)

Use when multiple local/CI agents share one warm retrieval runtime.

Setup:
- Start HTTP daemon once: `kindx mcp --http --daemon --port 8181`
- Set an explicit token: `KINDX_MCP_TOKEN=<secret>`
- Point clients to `http://localhost:8181/mcp` with bearer header

Guardrails:
- Watch `/metrics` for:
  - `kindx_rerank_queue_depth`
  - `kindx_rerank_queue_timed_out_total`
  - `kindx_rerank_queue_saturated_total`
- If timeout/saturation rises, reduce candidate/rerank limits or increase concurrency
- Run periodic `kindx cleanup` during maintenance windows

## 3) Controlled Enterprise Pilot

Use for privacy-sensitive pilot programs with explicit operational ownership.

Recommended controls:
- Pre-seed GGUF models in cache; block outbound network at runtime
- Set `KINDX_ENCRYPTION_KEY` and verify via `kindx status` / `kindx doctor --json`
- Use explicit per-project indexes (`--index` / `--workspace`) instead of shared defaults
- Treat multi-tenant isolation as deployment-enforced (separate index paths/processes)

Operational checklist:
1. Provision host with native runtime dependencies
2. Pre-stage model cache and token/key secrets
3. Run smoke checks: `kindx status`, `kindx doctor`, sample `kindx query`
4. Enable backups and restore drills (`backup create/verify/restore`)
5. Track queue/degraded metrics and adjust rerank/vector fanout settings

## Queue Pressure Playbook

Symptoms:
- rising degraded mode rate
- rerank timeout fallback reasons
- queue saturation counters increasing

Actions:
1. Lower `candidateLimit`/`maxRerankCandidates`
2. Lower request concurrency at caller side
3. Tune `KINDX_RERANK_CONCURRENCY` and `KINDX_RERANK_QUEUE_LIMIT`
4. Temporarily switch routing profile to `fast` for non-critical requests

## Warm Daemon Validation

Benchmark helper:
- `npm run perf:warm-daemon -- --base-url http://127.0.0.1:8181/query`

Interpretation:
- Treat p95 latency and degraded/timeout rates as service health indicators
- Prefer sustained trend analysis over one-off runs
