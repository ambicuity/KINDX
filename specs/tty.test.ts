/**
 * specs/tty.test.ts
 *
 * Unit tests for engine/cli/tui/tty.ts - Terminal control.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("tty", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let writtenData: string[];

  beforeEach(() => {
    writtenData = [];
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((data: string) => {
      writtenData.push(data);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  describe("tryReadCaps", () => {
    test("returns capabilities object", async () => {
      const { tryReadCaps } = await import("../engine/cli/tui/tty.js");
      const caps = tryReadCaps();
      expect(caps).toBeDefined();
      expect(typeof caps.width).toBe("number");
      expect(typeof caps.height).toBe("number");
      expect(typeof caps.color).toBe("boolean");
      expect(typeof caps.unicode).toBe("boolean");
    });

    test("detects UTF-8 from environment", async () => {
      const { tryReadCaps } = await import("../engine/cli/tui/tty.js");
      const caps = tryReadCaps({ LANG: "en_US.UTF-8" });
      expect(caps.unicode).toBe(true);
    });

    test("detects NO_COLOR", async () => {
      const { tryReadCaps } = await import("../engine/cli/tui/tty.js");
      const caps = tryReadCaps({ NO_COLOR: "1" });
      expect(caps.color).toBe(false);
    });
  });

  describe("moveTo", () => {
    test("returns escape sequence", async () => {
      const { moveTo } = await import("../engine/cli/tui/tty.js");
      const result = moveTo(5, 10);
      expect(result).toContain("\x1b[");
      expect(result).toContain("5");
      expect(result).toContain("10");
    });
  });

  describe("clearLine", () => {
    test("returns escape sequence", async () => {
      const { clearLine } = await import("../engine/cli/tui/tty.js");
      const result = clearLine();
      expect(result).toContain("\x1b[");
    });
  });

  describe("writeOut", () => {
    test("writes to stdout", async () => {
      const { writeOut } = await import("../engine/cli/tui/tty.js");
      writeOut("test output");
      expect(writtenData).toContain("test output");
    });
  });

  describe("enterAltScreen", () => {
    test("writes alt screen sequence", async () => {
      const { enterAltScreen } = await import("../engine/cli/tui/tty.js");
      enterAltScreen();
      expect(writtenData.length).toBeGreaterThan(0);
      expect(writtenData.join("")).toContain("\x1b[");
    });
  });

  describe("exitAltScreen", () => {
    test("writes exit sequence", async () => {
      const { exitAltScreen } = await import("../engine/cli/tui/tty.js");
      exitAltScreen();
      expect(writtenData.length).toBeGreaterThan(0);
    });
  });

  describe("enableRawMode", () => {
    test("returns cleanup function", async () => {
      const { enableRawMode } = await import("../engine/cli/tui/tty.js");
      const cleanup = enableRawMode();
      expect(typeof cleanup).toBe("function");
      cleanup();
    });
  });
});
