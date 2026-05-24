/**
 * specs/embed-command.test.ts
 *
 * Unit tests for engine/commands/embed-command.ts - Embed command implementation.
 */

import { describe, test, expect } from "vitest";

describe("embed-command", () => {
  describe("runEmbedCommand", () => {
    test("calls runVectorIndex with correct arguments", async () => {
      const { runEmbedCommand } = await import("../engine/commands/embed-command.js");
      
      let calledWith: { model: string | undefined; force: boolean; resume: boolean } | null = null;
      const mockRunVectorIndex = async (model: string | undefined, force: boolean, resume: boolean) => {
        calledWith = { model, force, resume };
      };

      await runEmbedCommand({
        force: true,
        resume: false,
        runVectorIndex: mockRunVectorIndex,
      });

      expect(calledWith).toEqual({
        model: undefined,
        force: true,
        resume: false,
      });
    });

    test("passes resume flag correctly", async () => {
      const { runEmbedCommand } = await import("../engine/commands/embed-command.js");
      
      let calledWith: { model: string | undefined; force: boolean; resume: boolean } | null = null;
      const mockRunVectorIndex = async (model: string | undefined, force: boolean, resume: boolean) => {
        calledWith = { model, force, resume };
      };

      await runEmbedCommand({
        force: false,
        resume: true,
        runVectorIndex: mockRunVectorIndex,
      });

      expect(calledWith).toEqual({
        model: undefined,
        force: false,
        resume: true,
      });
    });
  });

  describe("executeEmbedCommand", () => {
    test("returns 0 on success", async () => {
      const { executeEmbedCommand } = await import("../engine/commands/embed-command.js");
      
      const mockRunVectorIndex = async () => {};

      const result = await executeEmbedCommand({
        force: false,
        resume: false,
        runVectorIndex: mockRunVectorIndex,
      });

      expect(result).toBe(0);
    });

    test("returns 1 on error", async () => {
      const { executeEmbedCommand } = await import("../engine/commands/embed-command.js");
      
      const mockRunVectorIndex = async () => {
        throw new Error("Test error");
      };

      const mockStderr = {
        write: () => {},
      };

      const result = await executeEmbedCommand({
        force: false,
        resume: false,
        runVectorIndex: mockRunVectorIndex,
        stderr: mockStderr,
      });

      expect(result).toBe(1);
    });

    test("writes error to stderr", async () => {
      const { executeEmbedCommand } = await import("../engine/commands/embed-command.js");
      
      const mockRunVectorIndex = async () => {
        throw new Error("Test error message");
      };

      let writtenData = "";
      const mockStderr = {
        write: (data: string) => { writtenData += data; },
      };

      await executeEmbedCommand({
        force: false,
        resume: false,
        runVectorIndex: mockRunVectorIndex,
        stderr: mockStderr,
      });

      expect(writtenData).toContain("Test error message");
    });
  });
});
