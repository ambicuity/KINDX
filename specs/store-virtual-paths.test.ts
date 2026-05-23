/**
 * store-virtual-paths.test.ts - Virtual path normalization, parsing, and docid tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect } from "vitest";
import {
  normalizeVirtualPath,
  isVirtualPath,
  parseVirtualPath,
  normalizeDocid,
  isDocid,
} from "../engine/repository.js";

describe("normalizeVirtualPath", () => {
  test("already normalized kindx:// path passes through", () => {
    expect(normalizeVirtualPath("kindx://collection/path.md")).toBe("kindx://collection/path.md");
    expect(normalizeVirtualPath("kindx://journals/2025-01-01.md")).toBe("kindx://journals/2025-01-01.md");
  });

  test("handles //collection/path format (missing kindx: prefix)", () => {
    expect(normalizeVirtualPath("//collection/path.md")).toBe("kindx://collection/path.md");
    expect(normalizeVirtualPath("//journals/2025-01-01.md")).toBe("kindx://journals/2025-01-01.md");
  });

  test("handles kindx:// with extra slashes", () => {
    expect(normalizeVirtualPath("kindx:////collection/path.md")).toBe("kindx://collection/path.md");
    expect(normalizeVirtualPath("kindx:///journals/2025-01-01.md")).toBe("kindx://journals/2025-01-01.md");
    expect(normalizeVirtualPath("kindx:///////archive/file.md")).toBe("kindx://archive/file.md");
  });

  test("handles collection root paths", () => {
    expect(normalizeVirtualPath("kindx://collection/")).toBe("kindx://collection/");
    expect(normalizeVirtualPath("kindx://collection")).toBe("kindx://collection");
    expect(normalizeVirtualPath("//collection/")).toBe("kindx://collection/");
  });

  test("preserves bare collection/path format (not auto-converted)", () => {
    // Bare paths without kindx:// or // prefix are NOT converted
    // (could be relative filesystem paths)
    expect(normalizeVirtualPath("collection/path.md")).toBe("collection/path.md");
    expect(normalizeVirtualPath("journals/2025-01-01.md")).toBe("journals/2025-01-01.md");
  });

  test("preserves absolute filesystem paths", () => {
    expect(normalizeVirtualPath("/Users/test/file.md")).toBe("/Users/test/file.md");
    expect(normalizeVirtualPath("/absolute/path/file.md")).toBe("/absolute/path/file.md");
  });

  test("preserves home-relative paths", () => {
    expect(normalizeVirtualPath("~/Documents/file.md")).toBe("~/Documents/file.md");
  });

  test("preserves docid format", () => {
    expect(normalizeVirtualPath("#abc123")).toBe("#abc123");
    expect(normalizeVirtualPath("#def456")).toBe("#def456");
  });

  test("handles whitespace trimming", () => {
    expect(normalizeVirtualPath("  kindx://collection/path.md  ")).toBe("kindx://collection/path.md");
    expect(normalizeVirtualPath("  //collection/path.md  ")).toBe("kindx://collection/path.md");
  });
});

describe("isVirtualPath", () => {
  test("recognizes kindx:// paths", () => {
    expect(isVirtualPath("kindx://collection/path.md")).toBe(true);
    expect(isVirtualPath("kindx://journals/2025-01-01.md")).toBe(true);
    expect(isVirtualPath("kindx://collection")).toBe(true);
  });

  test("recognizes //collection/path format", () => {
    expect(isVirtualPath("//collection/path.md")).toBe(true);
    expect(isVirtualPath("//journals/2025-01-01.md")).toBe(true);
  });

  test("does not auto-recognize bare collection/path format", () => {
    // Bare paths could be relative filesystem paths, so not auto-detected as virtual
    expect(isVirtualPath("collection/path.md")).toBe(false);
    expect(isVirtualPath("journals/2025-01-01.md")).toBe(false);
    expect(isVirtualPath("archive/subfolder/file.md")).toBe(false);
  });

  test("rejects docid format", () => {
    expect(isVirtualPath("#abc123")).toBe(false);
    expect(isVirtualPath("#def456")).toBe(false);
  });

  test("rejects absolute filesystem paths", () => {
    expect(isVirtualPath("/Users/test/file.md")).toBe(false);
    expect(isVirtualPath("/absolute/path/file.md")).toBe(false);
  });

  test("rejects home-relative paths", () => {
    expect(isVirtualPath("~/Documents/file.md")).toBe(false);
    expect(isVirtualPath("~/notes/journal.md")).toBe(false);
  });

  test("rejects paths without slashes", () => {
    expect(isVirtualPath("file.md")).toBe(false);
    expect(isVirtualPath("document")).toBe(false);
  });
});

describe("parseVirtualPath", () => {
  test("parses standard kindx:// paths", () => {
    expect(parseVirtualPath("kindx://collection/path.md")).toEqual({
      collectionName: "collection",
      path: "path.md",
    });
    expect(parseVirtualPath("kindx://journals/2025-01-01.md")).toEqual({
      collectionName: "journals",
      path: "2025-01-01.md",
    });
  });

  test("parses paths with nested directories", () => {
    expect(parseVirtualPath("kindx://archive/subfolder/file.md")).toEqual({
      collectionName: "archive",
      path: "subfolder/file.md",
    });
  });

  test("parses collection root paths", () => {
    expect(parseVirtualPath("kindx://collection/")).toEqual({
      collectionName: "collection",
      path: "",
    });
    expect(parseVirtualPath("kindx://collection")).toEqual({
      collectionName: "collection",
      path: "",
    });
  });

  test("parses //collection/path format (normalizes first)", () => {
    expect(parseVirtualPath("//collection/path.md")).toEqual({
      collectionName: "collection",
      path: "path.md",
    });
  });

  test("parses kindx:// with extra slashes (normalizes first)", () => {
    expect(parseVirtualPath("kindx:////collection/path.md")).toEqual({
      collectionName: "collection",
      path: "path.md",
    });
  });

  test("returns null for non-virtual paths", () => {
    expect(parseVirtualPath("/absolute/path.md")).toBe(null);
    expect(parseVirtualPath("~/home/path.md")).toBe(null);
    expect(parseVirtualPath("#docid")).toBe(null);
    expect(parseVirtualPath("file.md")).toBe(null);
    // Bare collection/path is not recognized as virtual
    expect(parseVirtualPath("collection/path.md")).toBe(null);
  });
});

describe("normalizeDocid", () => {
  test("strips leading # from docid", () => {
    expect(normalizeDocid("#abc123")).toBe("abc123");
    expect(normalizeDocid("#def456")).toBe("def456");
  });

  test("returns bare hex unchanged", () => {
    expect(normalizeDocid("abc123")).toBe("abc123");
    expect(normalizeDocid("def456")).toBe("def456");
  });

  test("strips surrounding double quotes", () => {
    expect(normalizeDocid('"#abc123"')).toBe("abc123");
    expect(normalizeDocid('"abc123"')).toBe("abc123");
  });

  test("strips surrounding single quotes", () => {
    expect(normalizeDocid("'#abc123'")).toBe("abc123");
    expect(normalizeDocid("'abc123'")).toBe("abc123");
  });

  test("handles quoted docid without #", () => {
    expect(normalizeDocid('"def456"')).toBe("def456");
    expect(normalizeDocid("'def456'")).toBe("def456");
  });

  test("handles whitespace", () => {
    expect(normalizeDocid("  #abc123  ")).toBe("abc123");
    expect(normalizeDocid("  abc123  ")).toBe("abc123");
  });

  test("handles uppercase hex", () => {
    expect(normalizeDocid("#ABC123")).toBe("ABC123");
    expect(normalizeDocid('"ABC123"')).toBe("ABC123");
  });

  test("does not strip mismatched quotes", () => {
    expect(normalizeDocid('"abc123\'')).toBe('"abc123\'');
    expect(normalizeDocid("'abc123\"")).toBe("'abc123\"");
  });
});

describe("isDocid", () => {
  test("accepts #hash format", () => {
    expect(isDocid("#abc123")).toBe(true);
    expect(isDocid("#def456")).toBe(true);
    expect(isDocid("#ABCDEF")).toBe(true);
  });

  test("accepts bare 6-char hex", () => {
    expect(isDocid("abc123")).toBe(true);
    expect(isDocid("def456")).toBe(true);
    expect(isDocid("ABCDEF")).toBe(true);
  });

  test("accepts longer hex strings", () => {
    expect(isDocid("abc123def456")).toBe(true);
    expect(isDocid("#abc123def456")).toBe(true);
  });

  test("accepts double-quoted docids", () => {
    expect(isDocid('"#abc123"')).toBe(true);
    expect(isDocid('"abc123"')).toBe(true);
  });

  test("accepts single-quoted docids", () => {
    expect(isDocid("'#abc123'")).toBe(true);
    expect(isDocid("'abc123'")).toBe(true);
  });

  test("rejects non-hex strings", () => {
    expect(isDocid("ghijkl")).toBe(false);
    expect(isDocid("#ghijkl")).toBe(false);
    expect(isDocid("abc12g")).toBe(false);
  });

  test("rejects strings shorter than 6 chars", () => {
    expect(isDocid("abc12")).toBe(false);
    expect(isDocid("#abc1")).toBe(false);
    expect(isDocid("'abc'")).toBe(false);
  });

  test("rejects empty strings", () => {
    expect(isDocid("")).toBe(false);
    expect(isDocid("#")).toBe(false);
    expect(isDocid('""')).toBe(false);
  });

  test("rejects file paths", () => {
    expect(isDocid("/path/to/file.md")).toBe(false);
    expect(isDocid("path/to/file.md")).toBe(false);
    expect(isDocid("kindx://collection/file.md")).toBe(false);
  });

  test("rejects paths that look like hex with extensions", () => {
    expect(isDocid("abc123.md")).toBe(false);
  });
});
