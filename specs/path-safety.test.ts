import { describe, expect, test } from "vitest";
import { assertUnderRoot, isUnderRoot, PathTraversalError } from "../engine/utils/path-safety.js";

describe("assertUnderRoot", () => {
  test("accepts a child directly inside root", () => {
    expect(assertUnderRoot("/a/b/file.md", "/a/b")).toBe("/a/b/file.md");
  });

  test("accepts a child nested under root", () => {
    expect(assertUnderRoot("/a/b/c/d/file.md", "/a/b")).toBe("/a/b/c/d/file.md");
  });

  test("accepts root itself", () => {
    expect(assertUnderRoot("/a/b", "/a/b")).toBe("/a/b");
  });

  test("resolves relative child against root", () => {
    expect(assertUnderRoot("c/d/file.md", "/a/b")).toBe("/a/b/c/d/file.md");
  });

  test("normalizes . and intermediate ..", () => {
    expect(assertUnderRoot("/a/b/c/../d/./e", "/a/b")).toBe("/a/b/d/e");
  });

  test("rejects absolute child outside root", () => {
    expect(() => assertUnderRoot("/etc/passwd", "/a/b")).toThrow(PathTraversalError);
  });

  test("rejects relative child that escapes root", () => {
    expect(() => assertUnderRoot("../../etc/passwd", "/a/b")).toThrow(PathTraversalError);
  });

  test("rejects sibling directory with overlapping prefix", () => {
    // `/a/b-extra` is NOT under `/a/b` even though the string starts with it.
    expect(() => assertUnderRoot("/a/b-extra/file", "/a/b")).toThrow(PathTraversalError);
  });

  test("PathTraversalError carries child and root", () => {
    try {
      assertUnderRoot("/etc/passwd", "/safe");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PathTraversalError);
      const pErr = err as PathTraversalError;
      expect(pErr.child).toBe("/etc/passwd");
      expect(pErr.root).toBe("/safe");
    }
  });

  test("throws when root is relative (programmer error)", () => {
    expect(() => assertUnderRoot("x", "relative/root")).toThrow(/must be absolute/);
  });
});

describe("isUnderRoot", () => {
  test("returns true for accepted paths", () => {
    expect(isUnderRoot("/a/b/file", "/a/b")).toBe(true);
  });
  test("returns false for traversal", () => {
    expect(isUnderRoot("/etc/passwd", "/safe")).toBe(false);
    expect(isUnderRoot("../leaks", "/safe")).toBe(false);
  });
});
