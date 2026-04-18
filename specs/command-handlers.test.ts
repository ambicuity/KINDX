import { describe, expect, test, vi } from "vitest";
import { executeEmbedCommand, runEmbedCommand } from "../engine/commands/embed-command.js";
import { executeQueryCommand, runQueryCommand } from "../engine/commands/query-command.js";
import {
  buildSchedulerQueueRows,
  renderSchedulerStatus,
  runSchedulerStatusCommand,
} from "../engine/commands/scheduler-status-command.js";

describe("command handler extraction", () => {
  test("runEmbedCommand preserves force/resume wiring", async () => {
    const spy = vi.fn(async () => {});
    await runEmbedCommand({
      force: true,
      resume: true,
      runVectorIndex: spy,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(undefined, true, true);
  });

  test("runQueryCommand keeps query usage guard", async () => {
    const spy = vi.fn(async () => {});
    await expect(runQueryCommand({
      query: "",
      opts: {},
      runQuerySearch: spy,
    })).rejects.toThrow(/Usage: kindx query/);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  test("executeQueryCommand provides stable error boundary", async () => {
    const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); return true; } };
    const code = await executeQueryCommand({
      query: "",
      opts: {},
      runQuerySearch: async () => {},
      stderr: stderr as any,
    });
    expect(code).toBe(1);
    expect(stderr.chunks.join("")).toContain("Usage: kindx query");
  });

  test("executeEmbedCommand provides stable error boundary", async () => {
    const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); return true; } };
    const code = await executeEmbedCommand({
      force: false,
      resume: false,
      runVectorIndex: async () => {
        throw new Error("embed failed");
      },
      stderr: stderr as any,
    });
    expect(code).toBe(1);
    expect(stderr.chunks.join("")).toContain("embed failed");
  });

  test("renderSchedulerStatus emits stable json payload", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    renderSchedulerStatus({
      format: "json",
      shard: { enabledCollections: [], checkpointPath: "/tmp/checkpoint", checkpointExists: false, warnings: [] },
      checkpoint: { checkpointExists: false, valid: true, warnings: [] },
      queue: [],
      color: { bold: "", reset: "" },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = String(logSpy.mock.calls[0]?.[0]);
    expect(payload).toContain("\"queue\"");
    logSpy.mockRestore();
  });

  test("runSchedulerStatusCommand enforces usage guard", () => {
    const err = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); return true; } };
    const code = runSchedulerStatusCommand({
      subcommand: "bogus",
      format: "json",
      color: { bold: "", reset: "" },
      loadState: () => ({ shard: {}, checkpoint: {}, queueState: [] }),
      stderr: err as any,
    });
    expect(code).toBe(1);
    expect(err.chunks.join("")).toContain("Usage: kindx scheduler status");
  });

  test("buildSchedulerQueueRows computes topology drift deterministically", () => {
    const queue = buildSchedulerQueueRows(
      {
        collections: {
          notes: { shardCount: 2, completed: true, lastHashSeq: "abc_1" },
        },
      },
      [{
        collection: "notes",
        shardCount: 3,
        total: 10,
        processed: 7,
        pending: 3,
        queueLimit: null,
        workers: 2,
        batchSize: 100,
        active: 1,
      }],
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]?.checkpointShardCount).toBe(2);
    expect(queue[0]?.topologyDrift).toBe(true);
    expect(queue[0]?.lastHashSeq).toBe("abc_1");
  });
});
