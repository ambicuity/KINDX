# Subagent Orchestration Contract v0

Status: draft (clean-room parity baseline)
Date: 2026-04-02

## Goal

Define a shared contract that KINDX and OpenClaw can both implement for parent/child agent orchestration.

## Spawn Request

```json
{
  "task": "string",
  "agent_id": "string",
  "sandbox": "inherit|require|none",
  "tool_policy": {
    "allow": ["tool_a"],
    "deny": ["tool_b"]
  },
  "timeouts": {
    "max_runtime_seconds": 600
  },
  "scope": {
    "workspace_scope": "string",
    "session_scope": "string"
  }
}
```

## Spawn Response

```json
{
  "run_id": "string",
  "status": "accepted|rejected",
  "reason": "string|null"
}
```

## Run Status

```json
{
  "run_id": "string",
  "status": "running|completed|failed|aborted|timed_out",
  "started_at": "ISO-8601",
  "ended_at": "ISO-8601|null",
  "error_code": "string|null"
}
```

## Result Contract

```json
{
  "run_id": "string",
  "status": "completed|failed|aborted|timed_out",
  "result": {
    "summary": "string",
    "artifacts": [
      { "type": "file", "path": "string" }
    ]
  }
}
```

Exactly-once rule: each run MUST emit one terminal result.

## Isolation Rules

- Parent and child runs must not cross memory scope unless explicitly allowed.
- `explicitScope` overrides are forbidden if strict isolation is enabled and the scope differs from inherited scope.
- Tool policy inheritance defaults to parent allowlist intersected with child allowlist.

## Concurrency Rules

- Parent controls child max concurrency (`max_concurrency >= 1`).
- Runtime timeout is hard-enforced per child run.
- Abort cascades from parent to all active children.
