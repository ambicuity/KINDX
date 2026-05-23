/**
 * store-path-utils.test.ts - Path utility function tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect } from "vitest";
import {
  homedir,
  resolve,
  getDefaultDbPath,
  getPwd,
  getRealPath,
} from "../engine/repository.js";

describe("Path Utilities", () => {
  test("homedir returns HOME environment variable", () => {
    const result = homedir();
    expect(result).toBe(process.env.HOME || "/tmp");
  });

  test("resolve handles absolute paths", () => {
    expect(resolve("/foo/bar")).toBe("/foo/bar");
    expect(resolve("/foo", "/bar")).toBe("/bar");
  });

  test("resolve handles relative paths", () => {
    const pwd = process.env.PWD || process.cwd();
    expect(resolve("foo")).toBe(`${pwd}/foo`);
    expect(resolve("foo", "bar")).toBe(`${pwd}/foo/bar`);
  });

  test("resolve normalizes . and ..", () => {
    expect(resolve("/foo/bar/./baz")).toBe("/foo/bar/baz");
    expect(resolve("/foo/bar/../baz")).toBe("/foo/baz");
    expect(resolve("/foo/bar/../../baz")).toBe("/baz");
  });

  test("getDefaultDbPath throws in test mode without INDEX_PATH", () => {
    // In test mode, getDefaultDbPath should throw to prevent accidental writes to global index
    // This is intentional safety behavior
    const originalIndexPath = process.env.INDEX_PATH;
    delete process.env.INDEX_PATH;

    expect(() => getDefaultDbPath()).toThrow("Database path not set");

    // Restore
    if (originalIndexPath) process.env.INDEX_PATH = originalIndexPath;
  });

  test("getDefaultDbPath uses INDEX_PATH when set", () => {
    const originalIndexPath = process.env.INDEX_PATH;
    process.env.INDEX_PATH = "/tmp/test-index.sqlite";

    expect(getDefaultDbPath()).toBe("/tmp/test-index.sqlite");
    expect(getDefaultDbPath("custom")).toBe("/tmp/test-index.sqlite"); // INDEX_PATH overrides name

    // Restore
    if (originalIndexPath) {
      process.env.INDEX_PATH = originalIndexPath;
    } else {
      delete process.env.INDEX_PATH;
    }
  });

  test("getPwd returns current working directory", () => {
    const pwd = getPwd();
    expect(pwd).toBeTruthy();
    expect(typeof pwd).toBe("string");
  });

  test("getRealPath resolves symlinks", () => {
    const result = getRealPath("/tmp");
    expect(result).toBeTruthy();
    // On macOS, /tmp is a symlink to /private/tmp
    expect(result === "/tmp" || result === "/private/tmp").toBe(true);
  });
});
