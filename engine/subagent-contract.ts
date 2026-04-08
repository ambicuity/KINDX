import { z } from "zod";

export const SubagentStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
  "canceled",
]);

export const SubagentPolicySchema = z.object({
  max_concurrency: z.number().int().positive(),
  allow_tools: z.array(z.string()).default([]),
  deny_tools: z.array(z.string()).default([]),
  timeout_ms: z.number().int().positive(),
});

export const SubagentSandboxSchema = z.object({
  mode: z.enum(["none", "workspace-write", "read-only"]),
  network: z.enum(["default", "restricted", "none"]).default("default"),
});

export const SubagentSpawnSchema = z.object({
  agent_id: z.string().min(1),
  parent_run_id: z.string().min(1),
  tool_scope: z.array(z.string()).default([]),
  policy: SubagentPolicySchema,
  sandbox: SubagentSandboxSchema,
  timeout_ms: z.number().int().positive(),
  max_concurrency: z.number().int().positive(),
});

export const SubagentRunSchema = z.object({
  run_id: z.string().min(1),
  agent_id: z.string().min(1),
  parent_run_id: z.string().min(1),
  status: SubagentStatusSchema,
});

export const SubagentWaitSchema = z.object({
  run_id: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
});

export const SubagentAbortSchema = z.object({
  run_id: z.string().min(1),
  reason: z.string().optional(),
});

export const SubagentResultSchema = z.object({
  run_id: z.string().min(1),
  agent_id: z.string().min(1),
  status: SubagentStatusSchema,
  error_code: z.string().nullable().optional(),
  output: z.unknown().optional(),
});

export type SubagentPolicy = z.infer<typeof SubagentPolicySchema>;
export type SubagentSandbox = z.infer<typeof SubagentSandboxSchema>;
export type SubagentSpawn = z.infer<typeof SubagentSpawnSchema>;
export type SubagentRun = z.infer<typeof SubagentRunSchema>;
export type SubagentWait = z.infer<typeof SubagentWaitSchema>;
export type SubagentAbort = z.infer<typeof SubagentAbortSchema>;
export type SubagentResult = z.infer<typeof SubagentResultSchema>;

const SANDBOX_ORDER: Record<SubagentSandbox["mode"], number> = {
  "read-only": 0,
  "workspace-write": 1,
  "none": 2,
};

function intersectAllow(parentAllow: string[], childAllow: string[]): string[] {
  if (childAllow.length === 0) return [...parentAllow];
  const parent = new Set(parentAllow);
  return childAllow.filter((tool) => parent.has(tool));
}

function unionDeny(parentDeny: string[], childDeny: string[]): string[] {
  return [...new Set([...parentDeny, ...childDeny])];
}

export function clampChildPolicy(parent: SubagentPolicy, child: SubagentPolicy): SubagentPolicy {
  const clampedConcurrency = Math.min(parent.max_concurrency, child.max_concurrency);
  const clampedTimeout = Math.min(parent.timeout_ms, child.timeout_ms);
  return {
    max_concurrency: Math.max(1, clampedConcurrency),
    timeout_ms: Math.max(1, clampedTimeout),
    allow_tools: intersectAllow(parent.allow_tools, child.allow_tools),
    deny_tools: unionDeny(parent.deny_tools, child.deny_tools),
  };
}

export function clampChildSandbox(parent: SubagentSandbox, child: SubagentSandbox): SubagentSandbox {
  const parentLevel = SANDBOX_ORDER[parent.mode];
  const childLevel = SANDBOX_ORDER[child.mode];
  const mode = childLevel <= parentLevel ? child.mode : parent.mode;
  const network = (() => {
    if (parent.network === "none") return "none" as const;
    if (parent.network === "restricted" && child.network === "default") return "restricted" as const;
    return child.network;
  })();
  return { mode, network };
}

export function enforceToolScopeInheritance(
  parentScope: string[],
  childScope: string[],
): string[] {
  if (childScope.length === 0) return [...parentScope];
  const parent = new Set(parentScope);
  return childScope.filter((tool) => parent.has(tool));
}

