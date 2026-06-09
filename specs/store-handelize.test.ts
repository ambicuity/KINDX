/**
 * store-handelize.test.ts - handelize path normalization tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect } from "vitest";
import { handelize } from "../engine/repository.js";

describe("handelize", () => {
  test("converts to lowercase", () => {
    expect(handelize("README.md")).toBe("readme.md");
    expect(handelize("MyFile.MD")).toBe("myfile.md");
  });

  test("preserves folder structure", () => {
    expect(handelize("a/b/c/d.md")).toBe("a/b/c/d.md");
    expect(handelize("docs/api/README.md")).toBe("docs/api/readme.md");
  });

  test("replaces non-word characters with dash", () => {
    expect(handelize("hello world.md")).toBe("hello-world.md");
    expect(handelize("file (1).md")).toBe("file-1.md");
    expect(handelize("foo@bar#baz.md")).toBe("foo-bar-baz.md");
  });

  test("collapses multiple special chars into single dash", () => {
    expect(handelize("hello   world.md")).toBe("hello-world.md");
    expect(handelize("foo---bar.md")).toBe("foo-bar.md");
    expect(handelize("a  -  b.md")).toBe("a-b.md");
  });

  test("removes leading and trailing dashes from segments", () => {
    expect(handelize("-hello-.md")).toBe("hello.md");
    expect(handelize("--test--.md")).toBe("test.md");
    expect(handelize("a/-b-/c.md")).toBe("a/b/c.md");
  });

  test("converts triple underscore to folder separator", () => {
    expect(handelize("foo___bar.md")).toBe("foo/bar.md");
    expect(handelize("notes___2025___january.md")).toBe("notes/2025/january.md");
    expect(handelize("a/b___c/d.md")).toBe("a/b/c/d.md");
  });

  test("handles complex real-world meeting notes", () => {
    // Example: "Money Movement Licensing Review - 2025／11／19 10:25 EST - Notes by Gemini.md"
    const complexName = "Money Movement Licensing Review - 2025／11／19 10:25 EST - Notes by Gemini.md";
    const result = handelize(complexName);
    expect(result).toBe("money-movement-licensing-review-2025-11-19-10-25-est-notes-by-gemini.md");
    expect(result).not.toContain(" ");
    expect(result).not.toContain("／");
    expect(result).not.toContain(":");
  });

  test("handles unicode characters", () => {
    // Pure unicode filenames are now supported (fixes GitHub issue #10)
    expect(handelize("日本語.md")).toBe("日本語.md");
    expect(handelize("Зоны и проекты.md")).toBe("зоны-и-проекты.md");
    // Mixed unicode/ascii preserves both
    expect(handelize("café-notes.md")).toBe("café-notes.md");
    expect(handelize("naïve.md")).toBe("naïve.md");
    expect(handelize("日本語-notes.md")).toBe("日本語-notes.md");
  });

  test("handles dates and times in filenames", () => {
    expect(handelize("meeting-2025-01-15.md")).toBe("meeting-2025-01-15.md");
    expect(handelize("notes 2025/01/15.md")).toBe("notes-2025/01/15.md");
    expect(handelize("call_10:30_AM.md")).toBe("call-10-30-am.md");
  });

  test("handles special project naming patterns", () => {
    expect(handelize("PROJECT_ABC_v2.0.md")).toBe("project-abc-v2-0.md");
    expect(handelize("[WIP] Feature Request.md")).toBe("wip-feature-request.md");
    expect(handelize("(DRAFT) Proposal v1.md")).toBe("draft-proposal-v1.md");
  });

  test("handles symbol-only route filenames", () => {
    expect(handelize("routes/api/auth/$.ts")).toBe("routes/api/auth/$.ts");
    expect(handelize("app/routes/$id.tsx")).toBe("app/routes/$id.tsx");
  });

  test("filters out empty segments", () => {
    expect(handelize("a//b/c.md")).toBe("a/b/c.md");
    expect(handelize("/a/b/")).toBe("a/b");
    expect(handelize("///test///")).toBe("test");
  });

  test("throws error for invalid inputs", () => {
    expect(() => handelize("")).toThrow("path cannot be empty");
    expect(() => handelize("   ")).toThrow("path cannot be empty");
    expect(() => handelize(".md")).toThrow("no valid filename content");
    expect(() => handelize("...")).toThrow("no valid filename content");
    expect(() => handelize("___")).toThrow("no valid filename content");
  });

  test("handles minimal valid inputs", () => {
    expect(handelize("a")).toBe("a");
    expect(handelize("1")).toBe("1");
    expect(handelize("a.md")).toBe("a.md");
  });
});
