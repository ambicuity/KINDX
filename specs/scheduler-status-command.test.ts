/**
 * specs/scheduler-status-command.test.ts
 *
 * Unit tests for engine/commands/scheduler-status-command.ts - Scheduler status.
 */

import { describe, test, expect } from "vitest";

describe("scheduler-status-command", () => {
  describe("buildSchedulerQueueRows", () => {
    test("returns empty array for empty queue", async () => {
      const { buildSchedulerQueueRows } = await import("../engine/commands/scheduler-status-command.js");
      
      const result = buildSchedulerQueueRows({}, []);
      expect(result).toEqual([]);
    });

    test("builds rows from queue state", async () => {
      const { buildSchedulerQueueRows } = await import("../engine/commands/scheduler-status-command.js");
      
      const queueState = [
        {
          collection: "test",
          shardCount: 3,
          total: 10,
          processed: 5,
          pending: 3,
          active: 2,
          queueLimit: 100,
          workers: 4,
          batchSize: 10,
        },
      ];

      const result = buildSchedulerQueueRows({}, queueState);
      expect(result).toHaveLength(1);
      expect(result[0].collection).toBe("test");
      expect(result[0].shardCount).toBe(3);
    });

    test("detects topology drift", async () => {
      const { buildSchedulerQueueRows } = await import("../engine/commands/scheduler-status-command.js");
      
      const checkpoint = {
        collections: {
          test: { shardCount: 5, completed: false, lastHashSeq: null },
        },
      };
      const queueState = [
        {
          collection: "test",
          shardCount: 3,
          total: 10,
          processed: 5,
          pending: 3,
          active: 2,
          queueLimit: 100,
          workers: 4,
          batchSize: 10,
        },
      ];

      const result = buildSchedulerQueueRows(checkpoint, queueState);
      expect(result[0].topologyDrift).toBe(true);
    });
  });
});
