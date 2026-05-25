/**
 * specs/arch-adapter.test.ts
 *
 * Integration tests for engine/integrations/arch/adapter.ts - Arch adapter public API.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArchConfig, getArchStatus } from "../engine/integrations/arch/adapter.js";

describe("arch/adapter", () => {
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
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe("getArchConfig", () => {
    test("returns an object with all expected fields", () => {
      const config = getArchConfig();

      expect(config).toHaveProperty("enabled");
      expect(config).toHaveProperty("augmentEnabled");
      expect(config).toHaveProperty("autoRefreshOnUpdate");
      expect(config).toHaveProperty("pythonBin");
      expect(config).toHaveProperty("repoPath");
      expect(config).toHaveProperty("artifactDir");
      expect(config).toHaveProperty("collectionName");
      expect(config).toHaveProperty("minConfidence");
      expect(config).toHaveProperty("maxHints");
    });

    test("enabled defaults to false when KINDX_ARCH_ENABLED is not set", () => {
      const config = getArchConfig();
      expect(config.enabled).toBe(false);
    });

    test("enabled returns true when KINDX_ARCH_ENABLED is set to true", () => {
      process.env.KINDX_ARCH_ENABLED = "true";
      const config = getArchConfig();
      expect(config.enabled).toBe(true);
    });

    test("augmentEnabled defaults to false when KINDX_ARCH_AUGMENT_ENABLED is not set", () => {
      const config = getArchConfig();
      expect(config.augmentEnabled).toBe(false);
    });

    test("augmentEnabled returns true when KINDX_ARCH_AUGMENT_ENABLED is set to true", () => {
      process.env.KINDX_ARCH_AUGMENT_ENABLED = "true";
      const config = getArchConfig();
      expect(config.augmentEnabled).toBe(true);
    });

    test("pythonBin defaults to python3", () => {
      const config = getArchConfig();
      expect(config.pythonBin).toBe("python3");
    });

    test("pythonBin respects KINDX_ARCH_PYTHON_BIN override", () => {
      process.env.KINDX_ARCH_PYTHON_BIN = "/usr/bin/python3.11";
      const config = getArchConfig();
      expect(config.pythonBin).toBe("/usr/bin/python3.11");
    });

    test("collectionName defaults to __arch", () => {
      const config = getArchConfig();
      expect(config.collectionName).toBe("__arch");
    });

    test("minConfidence defaults to INFERRED", () => {
      const config = getArchConfig();
      expect(config.minConfidence).toBe("INFERRED");
    });

    test("maxHints defaults to 3", () => {
      const config = getArchConfig();
      expect(config.maxHints).toBe(3);
    });

    test("returns a fresh config object on each call", () => {
      const config1 = getArchConfig();
      const config2 = getArchConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });

  describe("getArchStatus", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "arch-adapter-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("returns object with enabled, augmentEnabled, repoCheck, paths, manifest fields", () => {
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status).toHaveProperty("enabled");
      expect(status).toHaveProperty("augmentEnabled");
      expect(status).toHaveProperty("repoCheck");
      expect(status).toHaveProperty("paths");
      expect(status).toHaveProperty("manifest");
    });

    test("enabled and augmentEnabled mirror the config values", () => {
      process.env.KINDX_ARCH_ENABLED = "true";
      process.env.KINDX_ARCH_AUGMENT_ENABLED = "true";
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status.enabled).toBe(true);
      expect(status.augmentEnabled).toBe(true);
    });

    test("enabled and augmentEnabled are false with default config", () => {
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status.enabled).toBe(false);
      expect(status.augmentEnabled).toBe(false);
    });

    test("repoCheck.ok is false when repo path does not exist", () => {
      process.env.KINDX_ARCH_REPO_PATH = "/nonexistent/path/to/arch-repo";
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status.repoCheck.ok).toBe(false);
      expect(status.repoCheck.reason).toBeDefined();
      expect(status.repoCheck.reason).toContain("not found");
    });

    test("repoCheck includes reason when repo path is missing", () => {
      process.env.KINDX_ARCH_REPO_PATH = "/tmp/definitely-does-not-exist-arch";
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status.repoCheck.ok).toBe(false);
      expect(typeof status.repoCheck.reason).toBe("string");
      expect(status.repoCheck.reason!.length).toBeGreaterThan(0);
    });

    test("returns null manifest when no artifacts exist", () => {
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status.manifest).toBeNull();
    });

    test("paths object has expected structure", () => {
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status.paths).toHaveProperty("workspaceRoot");
      expect(status.paths).toHaveProperty("sidecarOutputDir");
      expect(status.paths).toHaveProperty("distilledDir");
      expect(status.paths).toHaveProperty("docsDir");
      expect(status.paths).toHaveProperty("manifestPath");
    });

    test("paths.manifestPath is a string", () => {
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(typeof status.paths.manifestPath).toBe("string");
    });

    test("paths.workspaceRoot is derived from artifactDir and sourceRoot", () => {
      const config = getArchConfig();
      const status = getArchStatus(config, tmpDir);

      expect(status.paths.workspaceRoot).toContain("arch");
    });

    test("works with a different sourceRoot", () => {
      const altDir = mkdtempSync(join(tmpdir(), "arch-adapter-alt-"));
      try {
        const config = getArchConfig();
        const status = getArchStatus(config, altDir);

        expect(status.paths).toBeDefined();
        expect(status.manifest).toBeNull();
      } finally {
        rmSync(altDir, { recursive: true, force: true });
      }
    });

    test("status result is independent of getArchConfig call", () => {
      process.env.KINDX_ARCH_ENABLED = "true";
      const config1 = getArchConfig();
      process.env.KINDX_ARCH_ENABLED = "false";
      const config2 = getArchConfig();
      const status1 = getArchStatus(config1, tmpDir);
      const status2 = getArchStatus(config2, tmpDir);

      expect(status1.enabled).toBe(true);
      expect(status2.enabled).toBe(false);
    });
  });
});
