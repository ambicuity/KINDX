/**
 * specs/query-command.test.ts
 *
 * Unit tests for engine/commands/query-command.ts - Query command implementation.
 */

import { describe, test, expect } from "vitest";

describe("query-command", () => {
  describe("runQueryCommand", () => {
    test("throws error for empty query", async () => {
      const { runQueryCommand } = await import("../engine/commands/query-command.js");
      
      const mockRunQuerySearch = async () => {};

      await expect(runQueryCommand({
        query: "",
        opts: {},
        runQuerySearch: mockRunQuerySearch,
      })).rejects.toThrow("Usage: kindx query [options] <query>");
    });

    test("calls runQuerySearch with correct arguments", async () => {
      const { runQueryCommand } = await import("../engine/commands/query-command.js");
      
      let calledWith: { query: string; opts: unknown } | null = null;
      const mockRunQuerySearch = async (query: string, opts: unknown) => {
        calledWith = { query, opts };
      };

      await runQueryCommand({
        query: "test query",
        opts: { limit: 5 },
        runQuerySearch: mockRunQuerySearch,
      });

      expect(calledWith).toEqual({
        query: "test query",
        opts: { limit: 5 },
      });
    });
  });

  describe("executeQueryCommand", () => {
    test("returns 0 on success", async () => {
      const { executeQueryCommand } = await import("../engine/commands/query-command.js");
      
      const mockRunQuerySearch = async () => {};

      const result = await executeQueryCommand({
        query: "test query",
        opts: {},
        runQuerySearch: mockRunQuerySearch,
      });

      expect(result).toBe(0);
    });

    test("returns 1 on error", async () => {
      const { executeQueryCommand } = await import("../engine/commands/query-command.js");
      
      const mockRunQuerySearch = async () => {
        throw new Error("Test error");
      };

      const mockStderr = {
        write: () => {},
      } as unknown as NodeJS.WritableStream;

      const result = await executeQueryCommand({
        query: "test query",
        opts: {},
        runQuerySearch: mockRunQuerySearch,
        stderr: mockStderr,
      });

      expect(result).toBe(1);
    });

    test("returns 1 for empty query", async () => {
      const { executeQueryCommand } = await import("../engine/commands/query-command.js");
      
      const mockRunQuerySearch = async () => {};

      const mockStderr = {
        write: () => {},
      } as unknown as NodeJS.WritableStream;

      const result = await executeQueryCommand({
        query: "",
        opts: {},
        runQuerySearch: mockRunQuerySearch,
        stderr: mockStderr,
      });

      expect(result).toBe(1);
    });

    test("writes error to stderr", async () => {
      const { executeQueryCommand } = await import("../engine/commands/query-command.js");
      
      const mockRunQuerySearch = async () => {
        throw new Error("Test error message");
      };

      let writtenData = "";
      const mockStderr = {
        write: (data: string) => { writtenData += data; },
      } as unknown as NodeJS.WritableStream;

      await executeQueryCommand({
        query: "test query",
        opts: {},
        runQuerySearch: mockRunQuerySearch,
        stderr: mockStderr,
      });

      expect(writtenData).toContain("Test error message");
    });
  });
});
