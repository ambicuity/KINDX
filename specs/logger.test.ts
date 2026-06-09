/**
 * specs/logger.test.ts
 *
 * Unit tests for engine/utils/logger.ts - Structural logger.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("logger", () => {
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

  describe("configureLogger", () => {
    test("sets log level", async () => {
      const { configureLogger, logger } = await import("../engine/utils/logger.js");
      
      configureLogger({ level: "DEBUG" });
      logger.debug("debug message");
      expect(writtenData.length).toBeGreaterThan(0);
      expect(writtenData[0]).toContain("DEBUG");
    });

    test("sets log format", async () => {
      const { configureLogger, logger } = await import("../engine/utils/logger.js");
      
      configureLogger({ format: "json" });
      logger.info("json message");
      expect(writtenData.length).toBeGreaterThan(0);
      expect(writtenData[0]).toContain("{");
    });

    test("ignores invalid level", async () => {
      const { configureLogger, logger } = await import("../engine/utils/logger.js");
      
      configureLogger({ level: "INVALID" });
      logger.info("test message");
      expect(writtenData.length).toBeGreaterThan(0);
    });
  });

  describe("logger", () => {
    test("logs info messages", async () => {
      const { logger } = await import("../engine/utils/logger.js");
      
      logger.info("test message");
      expect(writtenData.length).toBeGreaterThan(0);
      expect(writtenData[0]).toContain("test message");
    });

    test("logs error messages", async () => {
      const { logger } = await import("../engine/utils/logger.js");
      
      logger.error("error message");
      expect(writtenData.length).toBeGreaterThan(0);
      expect(writtenData[0]).toContain("error message");
    });

    test("includes metadata in log", async () => {
      const { logger } = await import("../engine/utils/logger.js");
      
      logger.info("test", { key: "value" });
      expect(writtenData.length).toBeGreaterThan(0);
      expect(writtenData[0]).toContain("key");
    });

    test("sanitizes ANSI escape sequences", async () => {
      const { logger } = await import("../engine/utils/logger.js");
      
      logger.info("test\x1b[31mred\x1b[0m");
      expect(writtenData.length).toBeGreaterThan(0);
      expect(writtenData[0]).not.toContain("\x1b[31m");
    });
  });
});
