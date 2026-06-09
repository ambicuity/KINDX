/**
 * specs/arch-config.test.ts
 *
 * Unit tests for engine/integrations/arch/config.ts - Arch configuration loading and confidence helpers.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadArchConfig, confidenceRank, isConfidenceAllowed } from "../engine/integrations/arch/config.js";

describe("arch/config", () => {
  const savedEnv: Record<string, string | undefined> = {};

  const envKeys = [
    "KINDX_ARCH_ENABLED",
    "KINDX_ARCH_AUGMENT_ENABLED",
    "KINDX_ARCH_AUTO_REFRESH_ON_UPDATE",
    "KINDX_ARCH_PYTHON_BIN",
    "KINDX_ARCH_REPO_PATH",
    "KINDX_ARCH_ARTIFACT_DIR",
    "KINDX_ARCH_COLLECTION",
    "KINDX_ARCH_MIN_CONFIDENCE",
    "KINDX_ARCH_MAX_HINTS",
    "XDG_CACHE_HOME",
  ];

  beforeEach(() => {
    // Save and clear all relevant env vars
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env vars
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe("loadArchConfig", () => {
    test("returns defaults when all env vars are undefined", () => {
      const config = loadArchConfig();

      expect(config.enabled).toBe(false);
      expect(config.augmentEnabled).toBe(false);
      expect(config.autoRefreshOnUpdate).toBe(false);
      expect(config.pythonBin).toBe("python3");
      expect(config.collectionName).toBe("__arch");
      expect(config.minConfidence).toBe("INFERRED");
      expect(config.maxHints).toBe(3);
    });

    test("respects KINDX_ARCH_ENABLED=true", () => {
      process.env.KINDX_ARCH_ENABLED = "true";
      const config = loadArchConfig();
      expect(config.enabled).toBe(true);
    });

    test("respects KINDX_ARCH_ENABLED=false", () => {
      process.env.KINDX_ARCH_ENABLED = "false";
      const config = loadArchConfig();
      expect(config.enabled).toBe(false);
    });

    test("respects KINDX_ARCH_PYTHON_BIN", () => {
      process.env.KINDX_ARCH_PYTHON_BIN = "/usr/bin/python3";
      const config = loadArchConfig();
      expect(config.pythonBin).toBe("/usr/bin/python3");
    });

    test("trims whitespace from KINDX_ARCH_PYTHON_BIN", () => {
      process.env.KINDX_ARCH_PYTHON_BIN = "  /usr/bin/python3  ";
      const config = loadArchConfig();
      expect(config.pythonBin).toBe("/usr/bin/python3");
    });

    test("respects KINDX_ARCH_COLLECTION", () => {
      process.env.KINDX_ARCH_COLLECTION = "my-arch";
      const config = loadArchConfig();
      expect(config.collectionName).toBe("my-arch");
    });

    test("respects KINDX_ARCH_MAX_HINTS", () => {
      process.env.KINDX_ARCH_MAX_HINTS = "10";
      const config = loadArchConfig();
      expect(config.maxHints).toBe(10);
    });

    test("resolves repoPath relative to cwd", () => {
      process.env.KINDX_ARCH_REPO_PATH = "./tmp/arch";
      const config = loadArchConfig();
      expect(config.repoPath).toContain("tmp");
      expect(config.repoPath).toContain("arch");
    });

    test("respects XDG_CACHE_HOME for artifactDir", () => {
      process.env.XDG_CACHE_HOME = "/tmp/test-cache";
      const config = loadArchConfig();
      expect(config.artifactDir).toContain("test-cache");
      expect(config.artifactDir).toContain("kindx");
      expect(config.artifactDir).toContain("arch");
    });
  });

  describe("parseBool (via loadArchConfig)", () => {
    const trueValues = ["1", "true", "yes", "on", "TRUE", "YES", "ON", "True", "Yes", "On"];
    const falseValues = ["0", "false", "no", "off", "FALSE", "NO", "OFF", "False", "No", "Off"];

    for (const value of trueValues) {
      test(`parses "${value}" as true`, () => {
        process.env.KINDX_ARCH_ENABLED = value;
        const config = loadArchConfig();
        expect(config.enabled).toBe(true);
      });
    }

    for (const value of falseValues) {
      test(`parses "${value}" as false`, () => {
        process.env.KINDX_ARCH_ENABLED = value;
        const config = loadArchConfig();
        expect(config.enabled).toBe(false);
      });
    }

    test("returns fallback for unrecognized value", () => {
      process.env.KINDX_ARCH_ENABLED = "maybe";
      const config = loadArchConfig();
      expect(config.enabled).toBe(false); // default fallback is false
    });

    test("returns fallback for empty string", () => {
      process.env.KINDX_ARCH_ENABLED = "";
      const config = loadArchConfig();
      expect(config.enabled).toBe(false);
    });

    test("handles whitespace around value", () => {
      process.env.KINDX_ARCH_ENABLED = "  true  ";
      const config = loadArchConfig();
      expect(config.enabled).toBe(true);
    });
  });

  describe("parsePositiveInt (via loadArchConfig)", () => {
    test("parses valid positive integer", () => {
      process.env.KINDX_ARCH_MAX_HINTS = "5";
      const config = loadArchConfig();
      expect(config.maxHints).toBe(5);
    });

    test("returns fallback for zero", () => {
      process.env.KINDX_ARCH_MAX_HINTS = "0";
      const config = loadArchConfig();
      expect(config.maxHints).toBe(3); // default fallback
    });

    test("returns fallback for negative number", () => {
      process.env.KINDX_ARCH_MAX_HINTS = "-1";
      const config = loadArchConfig();
      expect(config.maxHints).toBe(3);
    });

    test("returns fallback for non-numeric string", () => {
      process.env.KINDX_ARCH_MAX_HINTS = "abc";
      const config = loadArchConfig();
      expect(config.maxHints).toBe(3);
    });

    test("returns fallback for float", () => {
      process.env.KINDX_ARCH_MAX_HINTS = "3.5";
      const config = loadArchConfig();
      // parseInt("3.5") = 3, which is > 0, so it returns 3
      expect(config.maxHints).toBe(3);
    });

    test("returns fallback when undefined", () => {
      const config = loadArchConfig();
      expect(config.maxHints).toBe(3);
    });

    test("parses large numbers", () => {
      process.env.KINDX_ARCH_MAX_HINTS = "1000";
      const config = loadArchConfig();
      expect(config.maxHints).toBe(1000);
    });
  });

  describe("parseConfidence (via loadArchConfig)", () => {
    test("parses EXTRACTED", () => {
      process.env.KINDX_ARCH_MIN_CONFIDENCE = "EXTRACTED";
      const config = loadArchConfig();
      expect(config.minConfidence).toBe("EXTRACTED");
    });

    test("parses INFERRED", () => {
      process.env.KINDX_ARCH_MIN_CONFIDENCE = "INFERRED";
      const config = loadArchConfig();
      expect(config.minConfidence).toBe("INFERRED");
    });

    test("parses AMBIGUOUS", () => {
      process.env.KINDX_ARCH_MIN_CONFIDENCE = "AMBIGUOUS";
      const config = loadArchConfig();
      expect(config.minConfidence).toBe("AMBIGUOUS");
    });

    test("is case-insensitive", () => {
      process.env.KINDX_ARCH_MIN_CONFIDENCE = "extracted";
      const config = loadArchConfig();
      expect(config.minConfidence).toBe("EXTRACTED");
    });

    test("trims whitespace", () => {
      process.env.KINDX_ARCH_MIN_CONFIDENCE = "  INFERRED  ";
      const config = loadArchConfig();
      expect(config.minConfidence).toBe("INFERRED");
    });

    test("defaults to INFERRED for invalid value", () => {
      process.env.KINDX_ARCH_MIN_CONFIDENCE = "INVALID";
      const config = loadArchConfig();
      expect(config.minConfidence).toBe("INFERRED");
    });

    test("defaults to INFERRED when undefined", () => {
      const config = loadArchConfig();
      expect(config.minConfidence).toBe("INFERRED");
    });
  });

  describe("confidenceRank", () => {
    test("EXTRACTED returns 3", () => {
      expect(confidenceRank("EXTRACTED")).toBe(3);
    });

    test("INFERRED returns 2", () => {
      expect(confidenceRank("INFERRED")).toBe(2);
    });

    test("AMBIGUOUS returns 1", () => {
      expect(confidenceRank("AMBIGUOUS")).toBe(1);
    });

    test("ranks are ordered: EXTRACTED > INFERRED > AMBIGUOUS", () => {
      expect(confidenceRank("EXTRACTED")).toBeGreaterThan(confidenceRank("INFERRED"));
      expect(confidenceRank("INFERRED")).toBeGreaterThan(confidenceRank("AMBIGUOUS"));
    });
  });

  describe("isConfidenceAllowed", () => {
    test("EXTRACTED passes INFERRED filter", () => {
      expect(isConfidenceAllowed("EXTRACTED", "INFERRED")).toBe(true);
    });

    test("EXTRACTED passes EXTRACTED filter", () => {
      expect(isConfidenceAllowed("EXTRACTED", "EXTRACTED")).toBe(true);
    });

    test("INFERRED passes INFERRED filter", () => {
      expect(isConfidenceAllowed("INFERRED", "INFERRED")).toBe(true);
    });

    test("INFERRED passes AMBIGUOUS filter", () => {
      expect(isConfidenceAllowed("INFERRED", "AMBIGUOUS")).toBe(true);
    });

    test("AMBIGUOUS passes AMBIGUOUS filter", () => {
      expect(isConfidenceAllowed("AMBIGUOUS", "AMBIGUOUS")).toBe(true);
    });

    test("AMBIGUOUS fails EXTRACTED filter", () => {
      expect(isConfidenceAllowed("AMBIGUOUS", "EXTRACTED")).toBe(false);
    });

    test("AMBIGUOUS fails INFERRED filter", () => {
      expect(isConfidenceAllowed("AMBIGUOUS", "INFERRED")).toBe(false);
    });

    test("INFERRED fails EXTRACTED filter", () => {
      expect(isConfidenceAllowed("INFERRED", "EXTRACTED")).toBe(false);
    });

    test("returns false for undefined value", () => {
      expect(isConfidenceAllowed(undefined, "AMBIGUOUS")).toBe(false);
    });

    test("returns false for empty string value", () => {
      expect(isConfidenceAllowed("", "AMBIGUOUS")).toBe(false);
    });

    test("returns false for invalid confidence value", () => {
      expect(isConfidenceAllowed("INVALID", "AMBIGUOUS")).toBe(false);
    });

    test("is case-insensitive for value", () => {
      expect(isConfidenceAllowed("extracted", "INFERRED")).toBe(true);
      expect(isConfidenceAllowed("Extracted", "INFERRED")).toBe(true);
    });
  });
});
