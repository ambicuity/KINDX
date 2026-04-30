import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("resolveMemoryBackendConfig", () => {
  it("defaults to builtin backend when config missing", () => {
    const cfg = { agents: { defaults: { workspace: "/tmp/memory-test" } } } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("builtin");
    expect(resolved.citations).toBe("auto");
    expect(resolved.kindx).toBeUndefined();
  });

  it("resolves kindx backend with default collections", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "kindx",
        kindx: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("kindx");
    expect(resolved.kindx?.collections.length).toBeGreaterThanOrEqual(3);
    expect(resolved.kindx?.command).toBe("kindx");
    expect(resolved.kindx?.searchMode).toBe("search");
    expect(resolved.kindx?.update.intervalMs).toBeGreaterThan(0);
    expect(resolved.kindx?.update.waitForBootSync).toBe(false);
    expect(resolved.kindx?.update.commandTimeoutMs).toBe(30_000);
    expect(resolved.kindx?.update.updateTimeoutMs).toBe(120_000);
    expect(resolved.kindx?.update.embedTimeoutMs).toBe(120_000);
    const names = new Set((resolved.kindx?.collections ?? []).map((collection) => collection.name));
    expect(names.has("memory-root-main")).toBe(true);
    expect(names.has("memory-alt-main")).toBe(true);
    expect(names.has("memory-dir-main")).toBe(true);
  });

  it("parses quoted kindx command paths", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "kindx",
        kindx: {
          command: '"/Applications/KINDX Tools/kindx" --flag',
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.kindx?.command).toBe("/Applications/KINDX Tools/kindx");
  });

  it("resolves custom paths relative to workspace", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [{ id: "main", workspace: "/workspace/root" }],
      },
      memory: {
        backend: "kindx",
        kindx: {
          paths: [
            {
              path: "notes",
              name: "custom-notes",
              pattern: "**/*.md",
            },
          ],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const custom = resolved.kindx?.collections.find((c) => c.name.startsWith("custom-notes"));
    expect(custom).toBeDefined();
    const workspaceRoot = resolveAgentWorkspaceDir(cfg, "main");
    expect(custom?.path).toBe(path.resolve(workspaceRoot, "notes"));
  });

  it("scopes kindx collection names per agent", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [
          { id: "main", default: true, workspace: "/workspace/root" },
          { id: "dev", workspace: "/workspace/dev" },
        ],
      },
      memory: {
        backend: "kindx",
        kindx: {
          includeDefaultMemory: true,
          paths: [{ path: "notes", name: "workspace", pattern: "**/*.md" }],
        },
      },
    } as OpenClawConfig;
    const mainResolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const devResolved = resolveMemoryBackendConfig({ cfg, agentId: "dev" });
    const mainNames = new Set(
      (mainResolved.kindx?.collections ?? []).map((collection) => collection.name),
    );
    const devNames = new Set(
      (devResolved.kindx?.collections ?? []).map((collection) => collection.name),
    );
    expect(mainNames.has("memory-dir-main")).toBe(true);
    expect(devNames.has("memory-dir-dev")).toBe(true);
    expect(mainNames.has("workspace-main")).toBe(true);
    expect(devNames.has("workspace-dev")).toBe(true);
  });

  it("resolves kindx update timeout overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "kindx",
        kindx: {
          update: {
            waitForBootSync: true,
            commandTimeoutMs: 12_000,
            updateTimeoutMs: 480_000,
            embedTimeoutMs: 360_000,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.kindx?.update.waitForBootSync).toBe(true);
    expect(resolved.kindx?.update.commandTimeoutMs).toBe(12_000);
    expect(resolved.kindx?.update.updateTimeoutMs).toBe(480_000);
    expect(resolved.kindx?.update.embedTimeoutMs).toBe(360_000);
  });

  it("resolves kindx search mode override", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "kindx",
        kindx: {
          searchMode: "vsearch",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.kindx?.searchMode).toBe("vsearch");
  });
});
