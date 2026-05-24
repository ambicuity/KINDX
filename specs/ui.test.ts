/**
 * specs/ui.test.ts
 *
 * Unit tests for engine/utils/ui.ts - Terminal UI utilities.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("ui", () => {
  let originalStderrWrite: typeof process.stderr.write;
  let writtenData: string[];

  beforeEach(() => {
    writtenData = [];
    originalStderrWrite = process.stderr.write;
    process.stderr.write = ((data: string) => {
      writtenData.push(data);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  describe("c (colors)", () => {
    test("exports color object", async () => {
      const { c } = await import("../engine/utils/ui.js");
      expect(c).toBeDefined();
      expect(typeof c.reset).toBe("string");
      expect(typeof c.bold).toBe("string");
      expect(typeof c.dim).toBe("string");
    });
  });

  describe("cursor", () => {
    test("exports cursor control", async () => {
      const { cursor } = await import("../engine/utils/ui.js");
      expect(cursor).toBeDefined();
      expect(typeof cursor.hide).toBe("function");
      expect(typeof cursor.show).toBe("function");
      expect(typeof cursor.clearLine).toBe("function");
    });

    test("hide writes escape sequence", async () => {
      const { cursor } = await import("../engine/utils/ui.js");
      cursor.hide();
      expect(writtenData.length).toBeGreaterThan(0);
    });
  });

  describe("progress", () => {
    test("exports progress control", async () => {
      const { progress } = await import("../engine/utils/ui.js");
      expect(progress).toBeDefined();
      expect(typeof progress.set).toBe("function");
      expect(typeof progress.clear).toBe("function");
    });
  });

  describe("Spinner", () => {
    test("creates spinner with text", async () => {
      const { Spinner } = await import("../engine/utils/ui.js");
      const spinner = new Spinner("Loading...");
      expect(spinner.text).toBe("Loading...");
    });

    test("has default frames", async () => {
      const { Spinner } = await import("../engine/utils/ui.js");
      const spinner = new Spinner("Test");
      expect(spinner.frames.length).toBeGreaterThan(0);
    });
  });
});
