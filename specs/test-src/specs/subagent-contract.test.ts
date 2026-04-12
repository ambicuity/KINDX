import { describe, expect, test } from "vitest";
import {
  clampChildPolicy,
  clampChildSandbox,
  enforceToolScopeInheritance,
  SubagentSpawnSchema,
} from "../engine/subagent-contract.js";

describe("subagent contract", () => {
  test("validates spawn payload", () => {
    const parsed = SubagentSpawnSchema.parse({
      agent_id: "worker-1",
      parent_run_id: "run-parent",
      tool_scope: ["query", "get"],
      policy: {
        max_concurrency: 3,
        allow_tools: ["query", "get"],
        deny_tools: ["exec"],
        timeout_ms: 30_000,
      },
      sandbox: {
        mode: "workspace-write",
        network: "restricted",
      },
      timeout_ms: 30_000,
      max_concurrency: 2,
    });
    expect(parsed.agent_id).toBe("worker-1");
  });

  test("clamps child policy to parent constraints", () => {
    const parent = {
      max_concurrency: 2,
      allow_tools: ["query", "get"],
      deny_tools: ["exec"],
      timeout_ms: 15_000,
    };
    const child = {
      max_concurrency: 10,
      allow_tools: ["query", "multi_get"],
      deny_tools: ["get"],
      timeout_ms: 60_000,
    };
    const out = clampChildPolicy(parent, child);
    expect(out.max_concurrency).toBe(2);
    expect(out.timeout_ms).toBe(15_000);
    expect(out.allow_tools).toEqual(["query"]);
    expect(out.deny_tools).toEqual(["exec", "get"]);
  });

  test("clamps child sandbox to parent", () => {
    const out = clampChildSandbox(
      { mode: "workspace-write", network: "restricted" },
      { mode: "none", network: "default" },
    );
    expect(out.mode).toBe("workspace-write");
    expect(out.network).toBe("restricted");
  });

  test("enforces child tool scope subset", () => {
    const out = enforceToolScopeInheritance(["query", "status"], ["query", "exec"]);
    expect(out).toEqual(["query"]);
  });
});

